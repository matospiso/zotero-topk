import { Bridge, PageDoc } from "./bridge";
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
}

interface Job {
	itemID: number;
	force: boolean;
	attempt?: number;
}

const MAX_ATTEMPTS = 4;
const TRANSIENT_ERROR = /Unavailable|temporarily unavailable|QuotaExceeded|Too many requests|timed out|timeout|deadline|transport|connection|bridge is not running|bridge exited/i;

const MAX_IMAGE_BYTES = 500 * 1024; // TopK limit is 512 KB
const BATCH_B64_BYTES = 5 * 1024 * 1024; // stay below the 8 MB upsert limit even with base64 overhead
const UPLOADS_IN_FLIGHT = 2;
const STALL_TIMEOUT_MS = 4 * 60 * 1000; // no page progress for this long → give up on the document

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

	constructor(private bridge: Bridge, private renderer: Renderer) {}

	private get statePath() {
		return PathUtils.join(Zotero.DataDirectory.dir, "topk-index-state.json");
	}

	// ----------------------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------------------

	async start() {
		await this.loadState();
		this.notifierID = Zotero.Notifier.registerObserver(
			{ notify: (event: string, type: string, ids: any[], extraData: any) => this.notify(event, type, ids, extraData) },
			["item"],
			"zotero-topk"
		);
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
				if (data && data.attachments) {
					for (const [k, v] of Object.entries<any>(data.attachments)) this.state.set(k, v);
				}
				log(`loaded index state for ${this.state.size} attachment(s)`);
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
				await IOUtils.writeUTF8(this.statePath, JSON.stringify({ version: 1, attachments }), { tmpPath: this.statePath + ".tmp" });
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
		if (type !== "item" || this.stopped) return;
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
			await this.bridge.deleteAttachments(libraryID, keys);
			for (const k of keys) this.state.delete(stateKey(libraryID, k));
		}
		await this.saveState();
		this.onChange?.();
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
					if (TRANSIENT_ERROR.test(this.lastError) && attempt < MAX_ATTEMPTS) {
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
					if (/API key|not configured|Node\.js|npm/i.test(this.lastError)) {
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
		if (!force && existing && existing.hash === hash) {
			debug(`skipping ${item.key}: unchanged`);
			return;
		}
		const { title, itemKey } = this.describe(item);
		this.current = { itemID: item.id, title, page: 0, total: 0 };
		this.ensureProgress();
		this.setProgressText(`${title}`);
		this.onChange?.();
		log(`indexing ${kind} ${item.libraryID}/${item.key} “${title}”`);

		await this.bridge.ensureReady();
		if (existing) {
			// Page count may have shrunk; drop stale pages first.
			await this.bridge.deleteAttachments(item.libraryID, [item.key]);
		}

		const signal = { cancelled: false };
		const parentSignal = this.cancelSignal;
		const batchPages = Math.max(1, getPref<number>("uploadBatch", 8));
		const opts = {
			maxEdge: getPref<number>("maxEdge", 1536),
			quality: getPref<number>("jpegQuality", 85),
			maxBytes: MAX_IMAGE_BYTES,
			maxPages: getPref<number>("maxPages", 500),
			concurrency: Math.max(1, getPref<number>("renderConcurrency", 8)),
			signal,
		};
		let batch: PageDoc[] = [];
		let batchBytes = 0;
		const inflight = new Set<Promise<unknown>>();
		let uploadError: unknown = null;
		let uploaded = 0;
		let total = 0;
		let done = 0;
		let lastProgress = Date.now();
		const flush = async () => {
			if (!batch.length) return;
			const docs = batch;
			batch = [];
			batchBytes = 0;
			while (inflight.size >= UPLOADS_IN_FLIGHT) await Promise.race(inflight);
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
				if (Date.now() - lastProgress > STALL_TIMEOUT_MS) {
					signal.cancelled = true;
					this.renderer.destroy(); // drop the pdf.js frame so the next document starts clean
					reject(new Error(`no progress for ${STALL_TIMEOUT_MS / 60000} minutes (stalled at page ${done}/${total || "?"})`));
					return;
				}
				watchdog = setTimeout(check, 5000);
			};
			watchdog = setTimeout(check, 5000);
		});
		let result: { rendered: number; total: number };
		try {
			const render = kind === "pdf"
				? this.renderer.renderPdf(path, opts, onPage)
				: this.renderer.renderHtml(path, opts, onPage);
			result = await Promise.race([render, stalled]);
			await flush();
			this.setProgressText(`${title} — uploading ${result.rendered - uploaded} page(s)…`);
			await Promise.race([Promise.all(inflight), stalled]);
		}
		finally {
			if (watchdog) clearTimeout(watchdog);
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
		});
		await this.saveState();
		log(`indexed ${item.key}: ${result.rendered}/${result.total} page(s) in ${((Date.now() - started) / 1000).toFixed(1)}s (${(result.rendered / ((Date.now() - started) / 1000)).toFixed(1)} pages/s)`);
	}

	async remove(libraryID: number, key: string) {
		const sk = stateKey(libraryID, key);
		if (!this.state.has(sk)) return;
		try {
			await this.bridge.deleteAttachments(libraryID, [key]);
			this.state.delete(sk);
			await this.saveState();
			log(`removed ${libraryID}/${key} from index`);
			this.onChange?.();
		}
		catch (e) {
			logError("remove", e);
		}
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
