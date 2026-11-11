import { Bridge, PageDoc, BridgeError, destinationKey } from "./bridge";
import { libraryKey } from "./library";
import { Renderer, RenderedPage } from "./renderer";
import { getPref, delay } from "./prefs";
import { log, logError, errorMessage, debug } from "./log";

export type AttachmentKind = "pdf" | "html";

export interface AttachmentState {
	libraryID: number;
	key: string;
	hash: string;
	pages: number;
	totalPages: number;
	kind: AttachmentKind;
	at: number;
	/** ok = fully indexed; partial = upload started but not finished; failed = gave up on this file version */
	status?: "ok" | "partial" | "failed";
	attempts?: number;
	error?: string;
}

interface PendingDelete {
	libraryID: number;
	libraryKey: string;
	key?: string; // absent = whole library
}

interface Job {
	itemID: number;
	force: boolean;
	attempt?: number;
}

const MAX_ATTEMPTS = 4;
const MAX_FAILED_VERSIONS = 3; // give up on a file version after this many non-transient failures
// Only errors reported by the bridge (TopK / helper process) are classified by text; errors
// produced while rendering a document never drive retries or queue drops, so a document
// author cannot influence scheduling through the text of a parser error.
const TRANSIENT_ERROR = /Unavailable|temporarily unavailable|QuotaExceeded|Too many requests|timed out|timeout|deadline|transport|connection|bridge is not running|bridge exited/i;
const SETUP_ERROR = /API key|not configured|Node\.js|npm|Invalid TopK|Invalid collection/i;
const STATE_PREFS = ["apiKey", "region", "host", "collection", "bridgeFake"];

class JobCancelled extends Error {}

interface ActiveJob {
	libraryID: number;
	key: string;
	target: string;
	signal: { cancelled: boolean };
	done: Promise<void>;
}

function isTransient(e: unknown, msg: string) {
	return (e instanceof BridgeError && TRANSIENT_ERROR.test(msg)) || (e as any)?.transient === true;
}
function isSetupError(e: unknown, msg: string) {
	return e instanceof BridgeError && SETUP_ERROR.test(msg);
}

const MAX_IMAGE_BYTES = 500 * 1024; // TopK limit is 512 KB
const BATCH_B64_BYTES = 5 * 1024 * 1024; // stay below the 8 MB upsert limit even with base64 overhead
const MAX_UPLOADS_IN_FLIGHT = 16;
const STALL_TIMEOUT_MS = 4 * 60 * 1000; // no page progress for this long while rendering → give up on the document
// While only uploads are outstanding, allow for the bridge's own retry window (cold cluster start):
// the HTTP request itself times out after 300 s, so a hung upload still surfaces as an error.
const UPLOAD_STALL_TIMEOUT_MS = 7 * 60 * 1000;

/** Raised by the watchdogs: the document may well succeed later, so the job is retried like a bridge outage. */
class IndexingStall extends Error {
	transient = true;
}

export function classifyAttachment(item: any): AttachmentKind | null {
	try {
		if (!item || !item.isAttachment() || !item.isFileAttachment() || item.deleted) return null;
		if (item.isPDFAttachment()) return "pdf";
		if (item.attachmentContentType === "text/html") return getPref<boolean>("indexSnapshots", true) ? "html" : null;
	}
	catch (e) {}
	return null;
}

export function stateKey(libraryID: number, key: string) {
	return `${libraryKey(libraryID)}/${key}`;
}

export function pageDocID(libraryID: number, key: string, page: number) {
	return `${libraryKey(libraryID)}/${key}/${page}`;
}

/**
 * Keeps TopK in sync with the library: renders eligible attachments page by
 * page and upserts them, reacts to item changes, and remembers what has been
 * indexed (by content hash) in a small JSON file in the Zotero data directory.
 */
export class Indexer {
	private state = new Map<string, AttachmentState>();
	private queue: Job[] = [];
	private queued = new Set<number>();
	private running = false;
	private stopped = false;
	private notifierID: string | null = null;
	private pending = new Map<number, number>(); // itemID -> timer
	private saveTimer: number | null = null;
	private reconciled = new Set<number>();
	private progress: any = null;
	private progressLine: any = null;
	private progressTotal = 0;
	private progressDone = 0;
	public current: { itemID: number; title: string; page: number; total: number } | null = null;
	public lastError = "";
	public onChange: (() => void) | null = null;
	private pendingDeletes: PendingDelete[] = [];
	private prefObservers: any[] = [];
	private activeJobs = new Set<ActiveJob>();
	private targets = new Map<string, { state: Map<string, AttachmentState>; pendingDeletes: PendingDelete[] }>();
	private writes: Promise<void> = Promise.resolve();
	private deleting: Promise<void> | null = null;

	constructor(private bridge: Bridge, private renderer: Renderer) {}

	private get statePath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "topk-index-state.json");
	}

	/** Identity of the TopK target the local state describes; each destination retains its own state and pending removals. */
	private target(): string { return destinationKey(); }

	private checkJob(job: ActiveJob) {
		if (this.stopped || job.signal.cancelled || job.target !== this.target()) throw new JobCancelled();
	}

	// ----------------------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------------------

	async start() {
		this.lastTarget = this.target();
		await this.loadState();
		this.notifierID = Zotero.Notifier.registerObserver(
			{ notify: (event: string, type: string, ids: any[], extraData: any) => this.notify(event, type, ids, extraData) },
			["item", "group"],
			"zotero-topk"
		);
		// A different credential or destination must never inherit reconciliation or completed state.
		for (const name of STATE_PREFS) {
			this.prefObservers.push(Zotero.Prefs.registerObserver(`extensions.zotero-topk.${name}`, () => {
				void this.resetStateIfTargetChanged();
			}, true));
		}
		void this.retryPendingDeletes();
		if (getPref<boolean>("autoIndex", true)) {
			// Let Zotero finish starting up before scanning the library.
			setTimeout(() => {
				if (!this.stopped) this.indexAllLibraries({ force: false }).catch((e) => logError("initial sync", e));
			}, 8000);
		}
	}

	stop() {
		this.stopped = true;
		for (const job of this.activeJobs) job.signal.cancelled = true;
		if (this.notifierID) {
			Zotero.Notifier.unregisterObserver(this.notifierID);
			this.notifierID = null;
		}
		for (const o of this.prefObservers) {
			try { Zotero.Prefs.unregisterObserver(o); } catch (e) {}
		}
		this.prefObservers = [];
		for (const t of this.pending.values()) clearTimeout(t);
		this.pending.clear();
		this.queue = [];
		this.queued.clear();
		this.closeProgress();
		void this.saveState(true);
	}

	// ----------------------------------------------------------------------
	// State persistence
	// ----------------------------------------------------------------------

	private async loadState() {
		try {
			if (await IOUtils.exists(this.statePath)) {
				const data = JSON.parse(await IOUtils.readUTF8(this.statePath));
				// Older state has neither credential scope nor stable library identities.
				if (data.version === 3) {
					for (const [target, value] of Object.entries<any>(data.targets || {})) {
						this.targets.set(target, { state: new Map(Object.entries(value.attachments || {})), pendingDeletes: value.pendingDeletes || [] });
					}
				}
			}
		}
		catch (e) { logError("loadState", e); }
		this.selectTarget(this.target());
	}

	private selectTarget(target: string) {
		if (!this.targets.has(target)) this.targets.set(target, { state: new Map(), pendingDeletes: [] });
		const saved = this.targets.get(target)!;
		this.state = saved.state;
		this.pendingDeletes = saved.pendingDeletes;
		this.lastTarget = target;
		this.reconciled.clear();
	}

	private async saveState(now = false) {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = null;
		const write = () => {
			this.saveTimer = null;
			const targets = Object.fromEntries([...this.targets].map(([key, value]) =>
				[key, { attachments: Object.fromEntries(value.state), pendingDeletes: value.pendingDeletes }]));
			const data = JSON.stringify({ version: 3, targets });
			this.writes = this.writes.then(() => IOUtils.writeUTF8(this.statePath, data,
				{ tmpPath: this.statePath + ".tmp" })).catch((e) => logError("saveState", e));
			return this.writes;
		};
		if (now) return write();
		this.saveTimer = setTimeout(write, 1500) as any;
	}

	getState(item: any): AttachmentState | undefined {
		if (this.target() !== this.lastTarget) return undefined;
		return this.state.get(stateKey(item.libraryID, item.key));
	}

	private lastTarget = "";

	private async resetStateIfTargetChanged() {
		const target = this.target();
		if (target === this.lastTarget) return;
		for (const job of this.activeJobs) job.signal.cancelled = true;
		this.queue = [];
		this.queued.clear();
		this.selectTarget(target);
		await this.saveState(true);
		this.onChange?.();
	}

	get stats() {
		let pages = 0;
		let attachments = 0;
		for (const s of this.state.values()) if (s.status === "ok") { pages += s.pages; attachments++; }
		return { attachments, pages, queued: this.queue.length, running: this.running };
	}

	getStatusText(): string {
		const s = this.stats;
		const parts = [`Indexed ${s.attachments} attachment(s), ${s.pages} page(s).`];
		if (s.queued) parts.push(`${s.queued} waiting.`);
		if (this.current) parts.push(`Indexing “${this.current.title}” (page ${this.current.page}/${this.current.total || "?"})…`);
		if (this.lastError) parts.push(`Last error: ${this.lastError}`);
		return parts.join(" ");
	}

	// ----------------------------------------------------------------------
	// Notifier
	// ----------------------------------------------------------------------

	private notify(event: string, type: string, ids: any[], extraData: any) {
		if (this.stopped) return;
		if (type === "group") {
			// A group library was removed (left / access revoked): its pages must not stay in the index.
			if (event === "delete") {
				for (const id of ids) {
					const libraryID = Number(extraData?.[id]?.libraryID);
					if (libraryID) void this.removeLibrary(libraryID, `group:${id}`);
				}
			}
			return;
		}
		if (type !== "item") return;
		try {
			if (event === "add" || event === "modify") {
				if (!getPref<boolean>("autoIndex", true)) return;
				for (const id of ids) this.scheduleItem(Number(id));
			}
			else if (event === "trash") {
				for (const id of ids) {
					const item = Zotero.Items.get(id);
					if (item && item.isAttachment()) void this.remove(item.libraryID, item.key);
				}
			}
			else if (event === "delete") {
				for (const id of ids) {
					const data = extraData?.[id];
					if (data?.libraryID && data?.key) void this.remove(data.libraryID, data.key);
				}
			}
		}
		catch (e) {
			logError("notify", e);
		}
	}

	/** Debounced: files often arrive a moment after the item is created. */
	private scheduleItem(itemID: number) {
		const existing = this.pending.get(itemID);
		if (existing) clearTimeout(existing);
		this.pending.set(itemID, setTimeout(() => {
			this.pending.delete(itemID);
			const item = Zotero.Items.get(itemID);
			if (!item) return;
			if (item.isAttachment()) {
				if (item.deleted) {
					void this.remove(item.libraryID, item.key);
				}
				else if (classifyAttachment(item)) {
					this.enqueue(item, false);
				}
			}
			else if (item.isRegularItem()) {
				// Title changes etc.: nothing to do unless children are unindexed.
				for (const att of Zotero.Items.get(item.getAttachments())) {
					if (classifyAttachment(att) && !this.getState(att)) this.enqueue(att, false);
				}
			}
		}, 3000) as any);
	}

	// ----------------------------------------------------------------------
	// Queue
	// ----------------------------------------------------------------------

	enqueue(item: any, force: boolean) {
		void this.resetStateIfTargetChanged();
		if (this.stopped || !item || this.hasPendingDelete(item.libraryID, item.key)) return;
		if (this.queued.has(item.id)) {
			if (force) for (const j of this.queue) if (j.itemID === item.id) j.force = true;
			return;
		}
		this.queued.add(item.id);
		this.queue.push({ itemID: item.id, force });
		this.progressTotal++;
		this.onChange?.();
		void this.run();
	}

	/** Index (or re-index) every eligible attachment among `items` (parents are expanded). */
	enqueueItems(items: any[], force: boolean) {
		for (const item of items) {
			if (item.isAttachment()) {
				if (classifyAttachment(item)) this.enqueue(item, force);
			}
			else if (item.isRegularItem()) {
				for (const att of Zotero.Items.get(item.getAttachments())) {
					if (classifyAttachment(att)) this.enqueue(att, force);
				}
			}
		}
	}

	async removeItems(items: any[]) {
		const attachments = items.flatMap((item) => item.isAttachment() ? [item]
			: item.isRegularItem() ? Zotero.Items.get(item.getAttachments()) : []);
		await Promise.all(attachments.map((att) => this.remove(att.libraryID, att.key)));
	}

	private hasPendingDelete(libraryID: number, key?: string) {
		return this.pendingDeletes.some((d) => d.libraryID === libraryID && (!d.key || d.key === key));
	}

	/** Tombstones remain durable until their remote deletion has succeeded. */
	private async flushPendingDeletes() {
		while (this.deleting) await this.deleting;
		const target = this.lastTarget;
		const pending = this.pendingDeletes;
		const work = async () => {
			for (const d of [...pending]) {
				for (const active of [...this.activeJobs]) {
					if (active.target === target && active.libraryID === d.libraryID && (!d.key || d.key === active.key)) {
						active.signal.cancelled = true;
						await active.done;
					}
				}
				if (this.stopped || this.target() !== target) return;
				try {
					if (d.key) await this.bridge.deleteAttachments(d.libraryKey, [d.key]);
					else await this.bridge.deleteLibrary(d.libraryKey);
					const i = pending.indexOf(d);
					if (i >= 0) pending.splice(i, 1);
					await this.saveState(true);
				}
				catch (e) { logError("pending delete", e); }
			}
		};
		const promise = work();
		this.deleting = promise;
		try { await promise; }
		finally { if (this.deleting === promise) this.deleting = null; }
	}

	/** Reconnect cleanup is independent of the automatic-ingest preference. */
	async retryPendingDeletes() {
		await this.resetStateIfTargetChanged();
		await this.flushPendingDeletes();
	}

	async indexAllLibraries({ force }: { force: boolean }) {
		await this.resetStateIfTargetChanged();
		await this.flushPendingDeletes();
		for (const library of Zotero.Libraries.getAll()) {
			if (library.libraryType === "feed") continue;
			await this.indexLibrary(library.libraryID, { force });
		}
	}

	async indexLibrary(libraryID: number, { force }: { force: boolean }) {
		await this.resetStateIfTargetChanged();
		await this.flushPendingDeletes();
		const target = this.lastTarget;
		if (!force) await this.reconcile(libraryID);
		const items = await Zotero.Items.getAll(libraryID, false, false, false);
		let n = 0;
		for (const item of items) {
			if (this.target() !== target) return;
			if (!classifyAttachment(item)) continue;
			if (!force) {
				const st = this.getState(item);
				// Cheap pre-check: if we have state, the hash check happens when the job runs.
				if (st && !(await this.needsReindex(item, st))) continue;
			}
			if (this.target() !== target) return;
			this.enqueue(item, force);
			n++;
		}
		log(`library ${libraryID}: ${n} attachment(s) queued${force ? " (forced)" : ""}`);
	}

	/** Pull the list of already indexed attachments from TopK so a fresh install doesn't re-render everything. */
	private async reconcile(libraryID: number) {
		if (this.reconciled.has(libraryID)) return;
		const target = this.lastTarget;
		try {
			const { rows, complete } = await this.bridge.manifest(libraryID);
			if (this.target() !== target) return;
			if (complete) this.reconciled.add(libraryID);
			let updated = 0;
			for (const row of rows) {
				if (this.target() !== target) return;
				if (row.library_key !== libraryKey(libraryID) || typeof row.attachment_key !== "string"
					|| !Number.isInteger(row.indexed_pages) || row.indexed_pages < 1) continue;
				if (this.hasPendingDelete(libraryID, row.attachment_key)) continue;
				const item = Zotero.Items.getByLibraryAndKey(libraryID, row.attachment_key);
				if (item?.deleted) { await this.remove(libraryID, row.attachment_key); continue; }
				const k = stateKey(libraryID, row.attachment_key);
				const existing = this.state.get(k);
				if (!existing) {
					this.state.set(k, {
						libraryID,
						key: row.attachment_key,
						hash: row.file_hash,
						pages: row.indexed_pages,
						totalPages: row.page_count,
						kind: "pdf",
						at: Date.now(),
						status: "ok",
					});
					updated++;
				}
			}
			if (updated) await this.saveState();
			log(`reconciled library ${libraryID} with TopK: ${rows.length} indexed attachment(s)${complete ? "" : " (partial)"}, ${updated} new to local state`);
		}
		catch (e) {
			logError("reconcile", e);
		}
	}

	private async run() {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			try { await this.flushPendingDeletes(); } catch (e) { logError("pending deletes", e); }
			// Pipeline: while one attachment's last uploads and its commit record are still in flight,
			// the next attachment is already hashed, cleared and rendering. TopK sets the pace through
			// backpressure on the uploads; the client does not idle between documents.
			let previous: Promise<void> = Promise.resolve();
			do {
				while (this.queue.length && !this.stopped) {
					const job = this.queue.shift()!;
					this.queued.delete(job.itemID);
					const item = Zotero.Items.get(job.itemID);
					if (!item || this.hasPendingDelete(item.libraryID, item.key)) continue;
					let finish!: () => void;
					const active: ActiveJob = { libraryID: item.libraryID, key: item.key, target: this.target(),
						signal: { cancelled: false }, done: new Promise<void>((resolve) => { finish = resolve; }) };
					this.activeJobs.add(active);
					let completion: Promise<void>;
					try {
						await this.resetStateIfTargetChanged();
						completion = (await this.indexAttachment(item, job.force, active))?.completion ?? Promise.resolve();
					}
					catch (e) {
						completion = Promise.reject(e);
					}
					completion.catch(() => {});
					// At most one attachment drains while the next one renders.
					await previous;
					previous = this.settle(job, item, active, completion, finish);
				}
				await previous;
			} while (this.queue.length && !this.stopped); // a retry may have been queued while draining
		}
		finally {
			this.running = false;
			this.finishProgress();
		}
	}

	/** Waits for an attachment's remaining uploads and commit record, records the outcome, and schedules a retry if warranted. */
	private async settle(job: Job, item: any, active: ActiveJob, completion: Promise<void>, finish: () => void) {
		try {
			await completion;
			this.lastError = "";
		}
		catch (e) {
			if (!(e instanceof JobCancelled || active.signal.cancelled || active.target !== this.target())) {
				this.lastError = errorMessage(e);
				logError(`indexing ${item.key}`, e);
				const attempt = (job.attempt || 1);
				if (isTransient(e, this.lastError) && attempt < MAX_ATTEMPTS) {
					// e.g. the cluster is scaling from zero: back off and try this one again later.
					const wait = Math.min(60000, 5000 * 2 ** (attempt - 1));
					log(`will retry ${item.key} in ${wait / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
					this.setProgressText(`Waiting for TopK… (${item.getDisplayTitle?.() || item.key})`);
					await delay(wait);
					if (!this.stopped && !active.signal.cancelled && active.target === this.target()) {
						this.queue.push({ itemID: job.itemID, force: job.force, attempt: attempt + 1 });
						this.queued.add(job.itemID);
						this.progressTotal++;
					}
				}
				else {
					this.setProgressText(`Failed: ${item.getDisplayTitle?.() || item.key} – ${this.lastError}`);
					// Setup problems (no key, no Node.js): stop hammering, drop the queue.
					if (isSetupError(e, this.lastError)) {
						this.queue = [];
						this.queued.clear();
					}
				}
			}
		}
		finally {
			this.activeJobs.delete(active);
			finish();
			this.progressDone++;
			if (this.current?.itemID === item.id) this.current = null;
			this.onChange?.();
		}
	}

	// ----------------------------------------------------------------------
	// Indexing one attachment
	// ----------------------------------------------------------------------

	private async fileHash(path: string): Promise<string> {
		try {
			return await IOUtils.computeHexDigest(path, "sha256");
		}
		catch (e) {
			return await Zotero.Utilities.Internal.md5Async(path);
		}
	}

	private async needsReindex(item: any, st: AttachmentState): Promise<boolean> {
		if (st.status === "partial" || (st.status === "failed" && (st.attempts || 0) < MAX_FAILED_VERSIONS)) return true;
		const path = await item.getFilePathAsync();
		if (!path) return false;
		return (await this.fileHash(path)) !== st.hash;
	}

	private describe(item: any) {
		const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
		const title = (parent && parent.getDisplayTitle && parent.getDisplayTitle()) || item.getDisplayTitle?.() || item.attachmentFilename || item.key;
		return { parent, title: String(title).slice(0, 500), itemKey: parent ? parent.key : item.key };
	}

	/**
	 * Prepares and renders one attachment. Resolves once rendering has finished, with a promise for the
	 * remaining uploads, the commit record and the state update, so the queue can start the next
	 * attachment while this one drains. Resolves to undefined when the attachment is skipped.
	 */
	private async indexAttachment(item: any, force: boolean, job: ActiveJob): Promise<{ completion: Promise<void> } | undefined> {
		this.checkJob(job);
		const kind = classifyAttachment(item);
		if (!kind) return;
		const path = await item.getFilePathAsync();
		if (!path) {
			debug(`skipping ${item.key}: file not available`);
			return;
		}
		const hash = await this.fileHash(path);
		this.checkJob(job);
		const sk = stateKey(item.libraryID, item.key);
		const existing = this.state.get(sk);
		if (!force && existing && existing.hash === hash && existing.status !== "partial") {
			if (existing.status === "failed") {
				if ((existing.attempts || 0) >= MAX_FAILED_VERSIONS) {
					debug(`skipping ${item.key}: failed ${existing.attempts} time(s) on this file version`);
					return;
				}
			}
			else {
				debug(`skipping ${item.key}: unchanged`);
				return;
			}
		}
		const { title, itemKey } = this.describe(item);
		this.current = { itemID: item.id, title, page: 0, total: 0 };
		this.ensureProgress();
		this.setProgressText(`${title}`);
		this.onChange?.();
		log(`indexing ${kind} ${item.libraryID}/${item.key} “${title}”`);

		await this.bridge.ensureReady();
		this.checkJob(job);
		// Invalidate the completed version before deleting any pages, even if rendering fails.
		this.state.set(sk, { libraryID: item.libraryID, key: item.key, hash, pages: 0, totalPages: 0, kind, at: Date.now(), status: "partial" });
		await this.saveState(true);
		this.checkJob(job);
		const recordFailure = async (e: unknown) => {
			const msg = errorMessage(e);
			if (!(e instanceof JobCancelled) && !isTransient(e, msg) && !job.signal.cancelled && job.target === this.target()) {
				// Remember the failure so a document that always fails is not re-rendered on every startup.
				const attempts = (existing?.status === "failed" && existing.hash === hash ? existing.attempts || 0 : 0) + 1;
				this.state.set(sk, { libraryID: item.libraryID, key: item.key, hash, pages: 0, totalPages: 0, kind, at: Date.now(), status: "failed", attempts, error: msg.slice(0, 300) });
				await this.saveState();
			}
		};
		try {
			// Always clear an interrupted remote version, including one unknown locally.
			await this.bridge.deleteAttachments(item.libraryID, [item.key]);
			this.checkJob(job);
			const { completion } = await this.uploadAttachment(item, kind, path, hash, title, itemKey, job);
			return { completion: completion.catch(async (e) => { await recordFailure(e); throw e; }) };
		}
		catch (e) {
			await recordFailure(e);
			throw e;
		}
	}

	// The completion is wrapped so that awaiting this function does not adopt (and wait for) it.
	private async uploadAttachment(item: any, kind: AttachmentKind, path: string, hash: string, title: string, itemKey: string, job: ActiveJob): Promise<{ completion: Promise<void> }> {
		const sk = stateKey(item.libraryID, item.key);

		let cancelled = false;
		const signal = {
			get cancelled() { return cancelled || job.signal.cancelled; },
			set cancelled(value: boolean) { cancelled = value; },
		};
		const batchPages = Math.max(1, getPref<number>("uploadBatch", 8));
		const uploadsInFlight = Math.max(1, Math.min(MAX_UPLOADS_IN_FLIGHT, getPref<number>("uploadConcurrency", 4)));
		const opts = {
			maxEdge: getPref<number>("maxEdge", 1536),
			quality: getPref<number>("jpegQuality", 85),
			maxBytes: MAX_IMAGE_BYTES,
			maxPages: Math.max(1, Math.min(5000, getPref<number>("maxPages", 500))),
			maxFileBytes: Math.max(1, getPref<number>("maxFileMB", 200)) * 1048576,
			concurrency: Math.max(1, getPref<number>("renderConcurrency", 8)),
			signal,
		};
		const docTimeoutMs = Math.max(1, getPref<number>("docTimeoutMinutes", 30)) * 60000;
		let batch: PageDoc[] = [];
		let batchBytes = 0;
		const inflight = new Set<Promise<unknown>>();
		let uploadError: unknown = null;
		let firstPage: PageDoc | undefined;
		const seen = new Set<number>();
		let uploaded = 0;
		let total = 0;
		let done = 0;
		let lastProgress = Date.now();
		let stallLimit = STALL_TIMEOUT_MS;
		const flush = async () => {
			if (!batch.length) return;
			const docs = batch;
			batch = [];
			batchBytes = 0;
			while (inflight.size >= uploadsInFlight) await Promise.race(inflight);
			this.checkJob(job);
			if (signal.cancelled) throw new JobCancelled();
			if (uploadError) throw uploadError;
			const started = Date.now();
			const p: Promise<unknown> = this.bridge.upsert(docs)
				.then(() => {
					uploaded += docs.length;
					lastProgress = Date.now();
					debug(`uploaded ${docs.length} page(s) of ${item.key} in ${Date.now() - started}ms`);
				})
				.catch((e) => { uploadError = uploadError || e; })
				.finally(() => inflight.delete(p));
			inflight.add(p);
		};
		const onPage = async (p: RenderedPage) => {
			if (uploadError) throw uploadError;
			this.checkJob(job);
			if (signal.cancelled) throw new JobCancelled();
			if (seen.has(p.page)) throw new Error("Renderer returned a duplicate page");
			seen.add(p.page);
			total = p.pageCount;
			done++;
			lastProgress = Date.now();
			this.current = { itemID: item.id, title, page: done, total };
			this.setProgressText(`${title} — page ${done}/${total}`);
			this.setProgressPercent(Math.round((done / Math.min(total, opts.maxPages)) * 100));
			const doc: PageDoc = {
				_id: pageDocID(item.libraryID, item.key, p.page),
				library_id: item.libraryID,
				library_key: libraryKey(item.libraryID),
				attachment_key: item.key,
				item_key: itemKey,
				page: p.page,
				page_count: total,
				title,
				file_hash: hash,
				page_image_b64: p.jpegB64,
			};
			// Page 1 is the commit record: publish it only after every other page succeeded.
			if (p.page === 1) { firstPage = doc; return; }
			batch.push(doc);
			batchBytes += p.jpegB64.length;
			if (batch.length >= batchPages || batchBytes >= BATCH_B64_BYTES) await flush();
		};
		const started = Date.now();
		// Watchdog: a stuck render or upload must not block the whole queue.
		let watchdog: any = null;
		const stalled = new Promise<never>((_, reject) => {
			const check = () => {
				if (Date.now() - lastProgress > stallLimit) {
					signal.cancelled = true;
					this.renderer.destroy(); // drop the pdf.js frame so the next document starts clean
					reject(new IndexingStall(`no progress for ${Math.round(stallLimit / 60000)} minutes (stalled at page ${done}/${total || "?"})`));
					return;
				}
				watchdog = setTimeout(check, 5000);
			};
			watchdog = setTimeout(check, 5000);
		});
		// Hard per-document budget: the stall watchdog resets on every page, so a huge or slow
		// document could otherwise hold the single indexing queue for hours.
		let docTimer: any = null;
		const docTimeout = new Promise<never>((_, reject) => {
			docTimer = setTimeout(() => {
				signal.cancelled = true;
				this.renderer.destroy();
				reject(new IndexingStall(`document took longer than ${Math.round(docTimeoutMs / 60000)} minutes (page ${done}/${total || "?"})`));
			}, docTimeoutMs);
		});
		const clearTimers = () => {
			if (watchdog) clearTimeout(watchdog);
			if (docTimer) clearTimeout(docTimer);
		};
		let result: { rendered: number; total: number };
		try {
			const render = kind === "pdf"
				? this.renderer.renderPdf(path, opts, onPage)
				: this.renderer.renderHtml(path, opts, onPage);
			result = await Promise.race([render, stalled, docTimeout]);
			await flush();
		}
		catch (e) {
			clearTimers();
			// Prevent late renderer callbacks from starting uploads after a failure, and
			// drain requests already sent before a retry or a final removal can proceed.
			signal.cancelled = true;
			await Promise.allSettled(inflight);
			throw e;
		}
		lastProgress = Date.now();
		stallLimit = UPLOAD_STALL_TIMEOUT_MS;
		this.setProgressText(`${title} — uploading ${result.rendered - uploaded} page(s)…`);
		// Rendering is done; the queue may start the next attachment while these uploads drain.
		const completion = (async () => {
			let drained = false;
			try {
				await Promise.race([Promise.all(inflight), stalled, docTimeout]);
				drained = true;
			}
			finally {
				clearTimers();
				if (!drained) signal.cancelled = true;
				await Promise.allSettled(inflight);
			}
			if (uploadError) throw uploadError;
			this.checkJob(job);
			if (!firstPage || result.rendered !== Math.min(result.total, opts.maxPages)
				|| seen.size !== result.rendered || uploaded !== result.rendered - 1
				|| [...seen].some((page) => page < 1 || page > result.rendered)) {
				throw new Error("Renderer did not produce the complete expected page set");
			}
			// Page 1 is the commit record: it goes out only after every other page has been acknowledged.
			await this.bridge.upsert([{ ...firstPage, indexed_pages: result.rendered }]);
			this.checkJob(job);

			this.state.set(sk, {
				libraryID: item.libraryID,
				key: item.key,
				hash,
				pages: result.rendered,
				totalPages: result.total,
				kind,
				at: Date.now(),
				status: "ok",
			});
			await this.saveState();
			log(`indexed ${item.key}: ${result.rendered}/${result.total} page(s) in ${((Date.now() - started) / 1000).toFixed(1)}s (${(result.rendered / ((Date.now() - started) / 1000)).toFixed(1)} pages/s)`);
		})();
		return { completion };
	}

	async remove(libraryID: number, key: string) {
		await this.requestRemoval({ libraryID, libraryKey: libraryKey(libraryID), key });
	}

	/** Group deletion supplies its stable ID because the local library may already be gone. */
	async removeLibrary(libraryID: number, remoteKey = libraryKey(libraryID)) {
		await this.requestRemoval({ libraryID, libraryKey: remoteKey });
	}

	private async requestRemoval(deletion: PendingDelete) {
		const { libraryID, key } = deletion;
		// Preference observers normally do this synchronously; cover direct callers too.
		void this.resetStateIfTargetChanged();
		for (const [id, timer] of this.pending) {
			const item = Zotero.Items.get(id);
			if (!item || (item.libraryID === libraryID && (!key || item.key === key))) {
				clearTimeout(timer);
				this.pending.delete(id);
			}
		}
		for (const active of this.activeJobs) {
			if (active.libraryID === libraryID && (!key || active.key === key)) active.signal.cancelled = true;
		}
		this.queue = this.queue.filter((job) => {
			const item = Zotero.Items.get(job.itemID);
			const keep = item && (item.libraryID !== libraryID || (key && item.key !== key));
			if (!keep) this.queued.delete(job.itemID);
			return keep;
		});
		for (const [k, value] of this.state) if (value.libraryID === libraryID && (!key || value.key === key)) this.state.delete(k);
		this.reconciled.delete(libraryID);
		if (!this.hasPendingDelete(libraryID, key)) this.pendingDeletes.push(deletion);
		await this.saveState(true);
		this.onChange?.();
		await this.flushPendingDeletes();
	}

	/** Resolves once the queue is drained (used by tests). */
	async whenIdle(timeoutMs = 600000) {
		const deadline = Date.now() + timeoutMs;
		while ((this.running || this.queue.length || this.pending.size || this.deleting) && Date.now() < deadline) await delay(200);
	}

	// ----------------------------------------------------------------------
	// Progress window
	// ----------------------------------------------------------------------

	private ensureProgress() {
		if (this.progress) return;
		try {
			this.progress = new Zotero.ProgressWindow({ closeOnClick: false });
			this.progress.changeHeadline("TopK: indexing pages");
			this.progressLine = new this.progress.ItemProgress("attachmentPDF", "…");
			this.progress.show();
			this.progressDone = 0;
			this.progressTotal = this.queue.length + 1;
		}
		catch (e) {
			this.progress = null;
		}
	}

	private setProgressText(text: string) {
		try { this.progressLine?.setText(`${text}  (${this.progressDone + 1}/${this.progressTotal})`); } catch (e) {}
	}

	private setProgressPercent(pct: number) {
		try { this.progressLine?.setProgress(Math.max(0, Math.min(100, pct))); } catch (e) {}
	}

	private finishProgress() {
		if (!this.progress) return;
		try {
			this.progressLine?.setProgress(100);
			this.progressLine?.setText(this.lastError ? `Done with errors: ${this.lastError}` : `Done: indexed ${this.progressDone} document(s)`);
			this.progress.startCloseTimer(this.lastError ? 8000 : 3000);
		}
		catch (e) {}
		this.progress = null;
		this.progressLine = null;
		this.progressTotal = 0;
		this.progressDone = 0;
	}

	private closeProgress() {
		try { this.progress?.close(); } catch (e) {}
		this.progress = null;
		this.progressLine = null;
	}
}
