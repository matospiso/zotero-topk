import { Bridge, PageDoc, BridgeError } from "./bridge";
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
const STATE_PREFS = ["region", "host", "collection"];

function isTransient(e: unknown, msg: string) {
	return (e instanceof BridgeError && TRANSIENT_ERROR.test(msg)) || (e as any)?.transient === true;
}
function isSetupError(e: unknown, msg: string) {
	return e instanceof BridgeError && SETUP_ERROR.test(msg);
}

const MAX_IMAGE_BYTES = 500 * 1024; // TopK limit is 512 KB
const BATCH_B64_BYTES = 5 * 1024 * 1024; // stay below the 8 MB upsert limit even with base64 overhead
const UPLOADS_IN_FLIGHT = 2;
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
	return `${libraryID}/${key}`;
}

export function pageDocID(libraryID: number, key: string, page: number) {
	return `${libraryID}/${key}/${page}`;
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
	private cancelSignal = { cancelled: false };
	private pendingDeletes: PendingDelete[] = [];
	private prefObservers: any[] = [];

	constructor(private bridge: Bridge, private renderer: Renderer) {}

	private get statePath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "topk-index-state.json");
	}

	/** Identity of the TopK target the local state describes; state from another target is discarded. */
	private target(): string {
		return JSON.stringify([getPref<string>("region", ""), getPref<string>("host", "").trim(), getPref<string>("collection", "")]);
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
		// Switching region/host/collection points at a different index: local state no longer applies.
		for (const name of STATE_PREFS) {
			this.prefObservers.push(Zotero.Prefs.registerObserver(`extensions.zotero-topk.${name}`, () => {
				void this.resetStateIfTargetChanged();
			}, true));
		}
		if (getPref<boolean>("autoIndex", true)) {
			// Let Zotero finish starting up before scanning the library.
			setTimeout(() => {
				if (!this.stopped) this.indexAllLibraries({ force: false }).catch((e) => logError("initial sync", e));
			}, 8000);
		}
	}

	stop() {
		this.stopped = true;
		this.cancelSignal.cancelled = true;
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
				if (data && data.target && data.target !== this.target()) {
					log("index state belongs to a different TopK region/host/collection; starting fresh");
					return;
				}
				if (data && data.attachments) {
					for (const [k, v] of Object.entries<any>(data.attachments)) this.state.set(k, v);
				}
				if (Array.isArray(data?.pendingDeletes)) this.pendingDeletes = data.pendingDeletes;
				log(`loaded index state for ${this.state.size} attachment(s), ${this.pendingDeletes.length} pending delete(s)`);
			}
		}
		catch (e) {
			logError("loadState", e);
		}
	}

	private async saveState(now = false) {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const write = async () => {
			try {
				const attachments: Record<string, AttachmentState> = {};
				for (const [k, v] of this.state) attachments[k] = v;
				await IOUtils.writeUTF8(this.statePath,
					JSON.stringify({ version: 2, target: this.target(), attachments, pendingDeletes: this.pendingDeletes }),
					{ tmpPath: this.statePath + ".tmp" });
			}
			catch (e) {
				logError("saveState", e);
			}
		};
		if (now) return write();
		this.saveTimer = setTimeout(write, 1500) as any;
	}

	getState(item: any): AttachmentState | undefined {
		return this.state.get(stateKey(item.libraryID, item.key));
	}

	private lastTarget = "";

	private async resetStateIfTargetChanged() {
		const t = this.target();
		if (t === this.lastTarget) return;
		this.lastTarget = t;
		if (!this.state.size && !this.pendingDeletes.length) return;
		log("TopK target changed: clearing local index state");
		this.state.clear();
		this.pendingDeletes = [];
		this.reconciled.clear();
		await this.saveState(true);
		this.onChange?.();
	}

	get stats() {
		let pages = 0;
		for (const s of this.state.values()) pages += s.pages;
		return { attachments: this.state.size, pages, queued: this.queue.length, running: this.running };
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
					if (libraryID) void this.removeLibrary(libraryID);
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
		if (this.stopped || !item) return;
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
		const byLibrary = new Map<number, string[]>();
		const collect = (att: any) => {
			if (!att.isAttachment()) return;
			const list = byLibrary.get(att.libraryID) || [];
			list.push(att.key);
			byLibrary.set(att.libraryID, list);
		};
		for (const item of items) {
			if (item.isAttachment()) collect(item);
			else if (item.isRegularItem()) for (const att of Zotero.Items.get(item.getAttachments())) collect(att);
		}
		for (const [libraryID, keys] of byLibrary) {
			try {
				await this.bridge.deleteAttachments(libraryID, keys);
			}
			catch (e) {
				for (const k of keys) this.pendingDeletes.push({ libraryID, key: k });
				await this.saveState();
				throw e;
			}
			for (const k of keys) this.state.delete(stateKey(libraryID, k));
		}
		await this.saveState();
		this.onChange?.();
	}

	/** Retry deletions that could not be delivered earlier (bridge down, offline). */
	private async flushPendingDeletes() {
		if (!this.pendingDeletes.length) return;
		const pending = this.pendingDeletes;
		this.pendingDeletes = [];
		const failed: PendingDelete[] = [];
		for (const d of pending) {
			try {
				if (d.key) await this.bridge.deleteAttachments(d.libraryID, [d.key]);
				else await this.bridge.deleteLibrary(d.libraryID);
			}
			catch (e) {
				failed.push(d);
			}
		}
		this.pendingDeletes.push(...failed);
		if (failed.length !== pending.length) log(`flushed ${pending.length - failed.length} pending delete(s)${failed.length ? `, ${failed.length} still pending` : ""}`);
		await this.saveState();
	}

	async indexAllLibraries({ force }: { force: boolean }) {
		for (const library of Zotero.Libraries.getAll()) {
			if (library.libraryType === "feed") continue;
			await this.indexLibrary(library.libraryID, { force });
		}
	}

	async indexLibrary(libraryID: number, { force }: { force: boolean }) {
		if (!force) await this.reconcile(libraryID);
		const items = await Zotero.Items.getAll(libraryID, false, false, false);
		let n = 0;
		for (const item of items) {
			if (!classifyAttachment(item)) continue;
			if (!force) {
				const st = this.getState(item);
				// Cheap pre-check: if we have state, the hash check happens when the job runs.
				if (st && !(await this.needsReindex(item, st))) continue;
			}
			this.enqueue(item, force);
			n++;
		}
		log(`library ${libraryID}: ${n} attachment(s) queued${force ? " (forced)" : ""}`);
	}

	/** Pull the list of already indexed attachments from TopK so a fresh install doesn't re-render everything. */
	private async reconcile(libraryID: number) {
		if (this.reconciled.has(libraryID)) return;
		this.reconciled.add(libraryID);
		try {
			const { rows, complete } = await this.bridge.manifest(libraryID);
			let updated = 0;
			for (const row of rows) {
				if (Number(row.library_id) !== libraryID || typeof row.attachment_key !== "string") continue;
				const k = stateKey(row.library_id, row.attachment_key);
				const existing = this.state.get(k);
				if (!existing || existing.hash !== row.file_hash) {
					this.state.set(k, {
						libraryID: row.library_id,
						key: row.attachment_key,
						hash: row.file_hash,
						pages: row.page_count,
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
		this.cancelSignal = { cancelled: false };
		try {
			try { await this.flushPendingDeletes(); } catch (e) { logError("pending deletes", e); }
			while (this.queue.length && !this.stopped) {
				const job = this.queue.shift()!;
				this.queued.delete(job.itemID);
				const item = Zotero.Items.get(job.itemID);
				if (!item) continue;
				try {
					await this.indexAttachment(item, job.force);
					this.lastError = "";
				}
				catch (e) {
					this.lastError = errorMessage(e);
					logError(`indexing ${item.key}`, e);
					const attempt = (job.attempt || 1);
					if (isTransient(e, this.lastError) && attempt < MAX_ATTEMPTS) {
						// e.g. the cluster is scaling from zero: back off and try this one again later.
						const wait = Math.min(60000, 5000 * 2 ** (attempt - 1));
						log(`will retry ${item.key} in ${wait / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
						this.setProgressText(`Waiting for TopK… (${item.getDisplayTitle?.() || item.key})`);
						await delay(wait);
						if (!this.stopped) {
							this.queue.push({ itemID: job.itemID, force: job.force, attempt: attempt + 1 });
							this.queued.add(job.itemID);
							this.progressTotal++;
						}
						continue;
					}
					this.setProgressText(`Failed: ${item.getDisplayTitle?.() || item.key} – ${this.lastError}`);
					// Setup problems (no key, no Node.js): stop hammering, drop the queue.
					if (isSetupError(e, this.lastError)) {
						this.queue = [];
						this.queued.clear();
						break;
					}
				}
				finally {
					this.progressDone++;
					this.current = null;
					this.onChange?.();
				}
			}
		}
		finally {
			this.running = false;
			this.finishProgress();
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
		const path = await item.getFilePathAsync();
		if (!path) return false;
		return (await this.fileHash(path)) !== st.hash;
	}

	private describe(item: any) {
		const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
		const title = (parent && parent.getDisplayTitle && parent.getDisplayTitle()) || item.getDisplayTitle?.() || item.attachmentFilename || item.key;
		return { parent, title: String(title).slice(0, 500), itemKey: parent ? parent.key : item.key };
	}

	private async indexAttachment(item: any, force: boolean) {
		const kind = classifyAttachment(item);
		if (!kind) return;
		const path = await item.getFilePathAsync();
		if (!path) {
			debug(`skipping ${item.key}: file not available`);
			return;
		}
		const hash = await this.fileHash(path);
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
		if (existing && existing.status !== "failed") {
			// Page count may have shrunk; drop stale pages first.
			await this.bridge.deleteAttachments(item.libraryID, [item.key]);
		}
		try {
			await this.uploadAttachment(item, kind, path, hash, existing, title, itemKey);
		}
		catch (e) {
			const msg = errorMessage(e);
			if (!isTransient(e, msg) && !this.cancelSignal.cancelled) {
				// Remember the failure so a document that always fails is not re-rendered on every startup.
				const attempts = (existing?.status === "failed" && existing.hash === hash ? existing.attempts || 0 : 0) + 1;
				this.state.set(sk, { libraryID: item.libraryID, key: item.key, hash, pages: 0, totalPages: 0, kind, at: Date.now(), status: "failed", attempts, error: msg.slice(0, 300) });
				await this.saveState();
			}
			throw e;
		}
	}

	private async uploadAttachment(item: any, kind: AttachmentKind, path: string, hash: string, existing: AttachmentState | undefined, title: string, itemKey: string) {
		const sk = stateKey(item.libraryID, item.key);

		const signal = { cancelled: false };
		const parentSignal = this.cancelSignal;
		const batchPages = Math.max(1, getPref<number>("uploadBatch", 8));
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
		let marked = false;
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
			while (inflight.size >= UPLOADS_IN_FLIGHT) await Promise.race(inflight);
			if (!marked) {
				// Record the attachment before the first upload so an interrupted index can still be removed later.
				marked = true;
				this.state.set(sk, { libraryID: item.libraryID, key: item.key, hash, pages: 0, totalPages: total, kind, at: Date.now(), status: "partial" });
				void this.saveState();
			}
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
			if (parentSignal.cancelled) signal.cancelled = true;
			total = p.pageCount;
			done++;
			lastProgress = Date.now();
			this.current = { itemID: item.id, title, page: done, total };
			this.setProgressText(`${title} — page ${done}/${total}`);
			this.setProgressPercent(Math.round((done / Math.min(total, opts.maxPages)) * 100));
			batch.push({
				_id: pageDocID(item.libraryID, item.key, p.page),
				library_id: item.libraryID,
				attachment_key: item.key,
				item_key: itemKey,
				page: p.page,
				page_count: total,
				title,
				file_hash: hash,
				page_image_b64: p.jpegB64,
			});
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
		let result: { rendered: number; total: number };
		try {
			const render = kind === "pdf"
				? this.renderer.renderPdf(path, opts, onPage)
				: this.renderer.renderHtml(path, opts, onPage);
			result = await Promise.race([render, stalled, docTimeout]);
			await flush();
			lastProgress = Date.now();
			stallLimit = UPLOAD_STALL_TIMEOUT_MS;
			this.setProgressText(`${title} — uploading ${result.rendered - uploaded} page(s)…`);
			await Promise.race([Promise.all(inflight), stalled, docTimeout]);
		}
		finally {
			if (watchdog) clearTimeout(watchdog);
			if (docTimer) clearTimeout(docTimer);
		}
		if (uploadError) throw uploadError;
		if (parentSignal.cancelled || signal.cancelled) return;

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
	}

	async remove(libraryID: number, key: string) {
		const sk = stateKey(libraryID, key);
		// Also issue the delete for attachments without local state: an interrupted or crashed
		// index may have uploaded pages before the state entry was written.
		try {
			await this.bridge.deleteAttachments(libraryID, [key]);
			this.state.delete(sk);
			await this.saveState();
			log(`removed ${libraryID}/${key} from index`);
			this.onChange?.();
		}
		catch (e) {
			logError("remove", e);
			this.pendingDeletes.push({ libraryID, key });
			await this.saveState();
		}
	}

	/** Drop every page of a library (group removed from Zotero). */
	async removeLibrary(libraryID: number) {
		for (const k of [...this.state.keys()]) if (k.startsWith(`${libraryID}/`)) this.state.delete(k);
		this.reconciled.delete(libraryID);
		try {
			await this.bridge.deleteLibrary(libraryID);
			log(`removed library ${libraryID} from index`);
		}
		catch (e) {
			logError("removeLibrary", e);
			this.pendingDeletes.push({ libraryID });
		}
		await this.saveState();
		this.onChange?.();
	}

	/** Resolves once the queue is drained (used by tests). */
	async whenIdle(timeoutMs = 600000) {
		const deadline = Date.now() + timeoutMs;
		while ((this.running || this.queue.length || this.pending.size) && Date.now() < deadline) await delay(200);
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
