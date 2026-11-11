import { createRequire } from "node:module";
import type { Client, ClientConfig } from "topk-js";
import type { SearchHit, PageDoc, ManifestRow, ConfigureRequest, UpsertRequest, SearchRequest,
	ImagesRequest, DeleteRequest, LibraryRequest, AttachmentRequest, PageImage, BridgeResponses } from "../shared/protocol";
import { HOST_LABEL, HOST_NAME, COLLECTION_NAME } from "../shared/configuration";

const require = createRequire(import.meta.url);
type SDK = { Client: typeof import("topk-js").Client; schema: typeof import("topk-js/schema");
	data: typeof import("topk-js/data"); query: typeof import("topk-js/query") };
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const MAX_MANIFEST_ROWS = 50000;
const MAX_IMAGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const SEARCH_FIELDS = ["library_id", "library_key", "attachment_key", "item_key", "page", "page_count", "title"] as const;

function asLibraryKey(value: unknown) {
	if (typeof value !== "string" || !/^(group:[1-9][0-9]*|user:[1-9][0-9]*|local:[A-Za-z0-9]+)$/.test(value)) {
		throw new HttpError(400, "libraryKey must be a qualified Zotero library identity");
	}
	return value;
}

/** Return a bounded thumbnail batch; callers can request omitted IDs separately. */
function imageResponse(images: Record<string, PageImage>) {
	const result: Record<string, PageImage> = Object.create(null);
	let bytes = Buffer.byteLength('{"images":{}}');
	for (const [id, image] of Object.entries(images)) {
		const size = Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(image)) + 2;
		if (bytes + size > MAX_IMAGE_RESPONSE_BYTES) continue;
		result[id] = image;
		bytes += size;
	}
	return { images: result };
}

function log(...args: unknown[]) {
	console.error("[topk-bridge]", ...args);
}

const TRANSIENT = /Unavailable|temporarily unavailable|QuotaExceeded|Too many requests|timed out|timeout|deadline|Unknown|transport|connection|ECONN|EAI_AGAIN|lsn/i;

/**
 * Retry transient TopK failures (cluster scaling from zero, rate limits,
 * network blips) with exponential backoff for up to `maxMs` milliseconds.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>, { maxMs = 240000, initMs = 1000, maxDelayMs = 20000 } = {}) {
	const started = Date.now();
	let delay = initMs;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		}
		catch (e) {
			const msg = message(e);
			const elapsed = Date.now() - started;
			if (e instanceof HttpError || !TRANSIENT.test(msg) || elapsed + delay > maxMs) throw e;
			log(`${what}: transient error (attempt ${attempt}, retrying in ${delay}ms): ${msg.slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(maxDelayMs, Math.round(delay * 1.8));
		}
	}
}

export class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function validateDestination({ region, collection, host }: Pick<ConfigureRequest, "region" | "collection" | "host">) {
	if (typeof region !== "string" || !HOST_LABEL.test(region)) throw new HttpError(400, "region must be a single hostname label (e.g. aws-us-east-1-elastica)");
	if (typeof collection !== "string" || !COLLECTION_NAME.test(collection)) throw new HttpError(400, "collection must match [A-Za-z0-9_-]{1,128}");
	if (host != null && host !== "" && (typeof host !== "string" || !HOST_NAME.test(host))) throw new HttpError(400, "host must be a hostname (e.g. topk.io)");
}

export interface Backend {
	readonly configured: boolean;
	configure(body: ConfigureRequest): Promise<BridgeResponses["/configure"]>;
	status(): Promise<BridgeResponses["/status"]>;
	upsert(body: UpsertRequest): Promise<BridgeResponses["/upsert"]>;
	search(body: SearchRequest): Promise<BridgeResponses["/search"]>;
	images(body: ImagesRequest): Promise<BridgeResponses["/images"]>;
	deleteAttachments(body: DeleteRequest): Promise<BridgeResponses["/delete"]>;
	deleteLibrary(body: LibraryRequest): Promise<BridgeResponses["/delete-library"]>;
	hasAttachment(body: AttachmentRequest): Promise<BridgeResponses["/attachment-status"]>;
	manifest(body: LibraryRequest): Promise<BridgeResponses["/manifest"]>;
}

export class TopKBackend implements Backend {
	client: Client | null;
	collectionName: string | null;
	region: string | null;
	host: string | null = null;
	lastLsn: string | null;
	lastLsnAt: number;
	private _mods?: SDK;
	constructor() {
		this.client = null;
		this.collectionName = null;
		this.region = null;
		this.lastLsn = null;
		this.lastLsnAt = 0;
	}

	get configured() {
		return !!this.client;
	}

	_sdk() {
		if (!this._mods) {
			const { Client } = require("topk-js");
			const schema = require("topk-js/schema");
			const data = require("topk-js/data");
			const query = require("topk-js/query");
			this._mods = { Client, schema, data, query };
		}
		return this._mods;
	}

	_schema() {
		const { image, text, int, semanticIndex } = this._sdk().schema;
		return {
			page_image: image().required().index(semanticIndex()),
			library_id: int().required(),
			library_key: text(),
			indexed_pages: int(),
			attachment_key: text().required(),
			item_key: text().required(),
			page: int().required(),
			page_count: int().required(),
			title: text(),
			file_hash: text().required(),
		};
	}

	_col() {
		if (!this.client) throw new HttpError(409, "bridge is not configured (missing API key?)");
		return this.client.collection(this.collectionName!);
	}

	async configure({ apiKey, region, collection, host }: ConfigureRequest): Promise<BridgeResponses["/configure"]> {
		if (typeof apiKey !== "string" || !apiKey) throw new HttpError(400, "apiKey is required");
		validateDestination({ region, collection, host });
		const { Client } = this._sdk();
		const config: ClientConfig = {
			apiKey,
			region,
			// The SDK's own retries are short; keep them but let withRetry() handle cold starts.
			retryConfig: { maxRetries: 5, timeout: 120000, backoff: { initBackoff: 250, maxBackoff: 5000 } },
		};
		if (host) config.host = host;
		const client = new Client(config);
		let created = false;
		let col;
		try {
			col = await withRetry("get collection", () => client.collections().get(collection));
		}
		catch (e) {
			if (/not found/i.test(message(e))) {
				log(`creating collection "${collection}" in ${region}${host ? ` (${host})` : ""}`);
				col = await withRetry("create collection", () => client.collections().create(collection, this._schema()));
				created = true;
			}
			else {
				throw new HttpError(502, `TopK: ${message(e)}`);
			}
		}
		const pageImage = col && col.schema && col.schema.page_image;
		if (!pageImage || !/semantic/i.test(JSON.stringify(pageImage))) {
			throw new HttpError(409,
				`collection "${collection}" exists but has no semantic index on a "page_image" field; `
				+ "pick another collection name");
		}
		this.client = client;
		this.collectionName = collection;
		this.region = region;
		this.host = host || null;
		this.lastLsn = null;
		this.lastLsnAt = 0;
		return { ok: true, created, collection, region, host: this.host };
	}

	async status(): Promise<BridgeResponses["/status"]> {
		if (!this.client) return { configured: false };
		let docCount: number | null = null;
		try {
			docCount = await withRetry("count", () => this._col().count(), { maxMs: 30000 });
		}
		catch (e) {
			log("count failed:", message(e));
		}
		return { configured: true, collection: this.collectionName, region: this.region, host: this.host, docCount };
	}

	async upsert({ docs }: UpsertRequest): Promise<BridgeResponses["/upsert"]> {
		if (!Array.isArray(docs) || !docs.length) throw new HttpError(400, "docs must be a non-empty array");
		const { image } = this._sdk().data;
		const payload = docs.map((d) => {
			if (!d._id || !d.page_image_b64) throw new HttpError(400, "each doc needs _id and page_image_b64");
			const { page_image_b64, ...rest } = d;
			return { ...rest, page_image: image(Buffer.from(page_image_b64, "base64")) };
		});
		// Bound to the collection of the moment the request was accepted: a retry never crosses into another destination.
		const col = this._col();
		const lsn = await withRetry("upsert", () => col.upsert(payload));
		this.recordLsn(lsn);
		return { ok: true, lsn, count: payload.length };
	}

	async search({ query, limit = 50, libraryKeys }: SearchRequest): Promise<BridgeResponses["/search"]> {
		if (!query || typeof query !== "string") throw new HttpError(400, "query is required");
		const { select, field, fn } = this._sdk().query;
		const selected: Record<string, ReturnType<SDK["query"]["field"]> | ReturnType<SDK["query"]["fn"]["semanticSimilarity"]>> = { score: fn.semanticSimilarity("page_image", query) };
		for (const f of SEARCH_FIELDS) selected[f] = field(f);
		let q = select(selected);
		if (!Array.isArray(libraryKeys) || !libraryKeys.length) return { hits: [] };
		q = q.filter(field("library_key").in(libraryKeys.map(asLibraryKey)));
		q = q.sort(field("score"), false).limit(Math.max(1, Math.min(500, Number(limit) || 50)));
		// Read-your-writes right after indexing: wait for the last upsert to be visible.
		const options = this.readOptions();
		const docs = await withRetry("search", () => this._col().query(q, options), { maxMs: 90000 });
		return { hits: docs.map((d) => ({ ...d, score: Number(d.score) })) as unknown as SearchHit[] };
	}

	async images({ ids }: ImagesRequest): Promise<BridgeResponses["/images"]> {
		if (!Array.isArray(ids) || !ids.length) return { images: {} };
		const docs = await withRetry("get images", () => this._col().get(ids.slice(0, 50), ["page_image"]), { maxMs: 90000 });
		const images: Record<string, PageImage> = {};
		for (const [id, doc] of Object.entries(docs)) {
			const img = doc?.page_image as { data?: Uint8Array; format: string } | undefined;
			if (img && img.data) {
				images[id] = { format: img.format, b64: Buffer.from(img.data).toString("base64") };
			}
		}
		return imageResponse(images);
	}

	async deleteAttachments({ libraryKey, attachmentKeys }: DeleteRequest): Promise<BridgeResponses["/delete"]> {
		const lib = asLibraryKey(libraryKey);
		if (!Array.isArray(attachmentKeys) || !attachmentKeys.length) return { ok: true, deleted: 0 };
		if (!attachmentKeys.every((k) => typeof k === "string" && k.length <= 64)) throw new HttpError(400, "attachmentKeys must be strings");
		const { field } = this._sdk().query;
		for (let i = 0; i < attachmentKeys.length; i += 100) {
			const chunk = attachmentKeys.slice(i, i + 100);
			const expr = field("library_key").eq(lib).and(field("attachment_key").in(chunk));
			const lsn = await withRetry("delete", () => this._col().delete(expr));
			this.recordLsn(lsn);
		}
		return { ok: true, deleted: attachmentKeys.length };
	}

	async deleteLibrary({ libraryKey }: LibraryRequest): Promise<BridgeResponses["/delete-library"]> {
		const lib = asLibraryKey(libraryKey);
		const { field } = this._sdk().query;
		const lsn = await withRetry("delete library", () => this._col().delete(field("library_key").eq(lib)));
		this.recordLsn(lsn);
		return { ok: true, libraryKey: lib };
	}

	async hasAttachment({ libraryKey, attachmentKey }: AttachmentRequest): Promise<BridgeResponses["/attachment-status"]> {
		const lib = asLibraryKey(libraryKey);
		if (typeof attachmentKey !== "string" || !attachmentKey) throw new HttpError(400, "attachmentKey is required");
		const { select, field } = this._sdk().query;
		const col = this._col();
		const q = select({ attachment_key: field("attachment_key") }).filter(field("library_key").eq(lib).and(field("attachment_key").eq(attachmentKey))).limit(1);
		const docs = await withRetry("attachment status", () => col.query(q, this.readOptions()), { maxMs: 90000 });
		return { exists: docs.length > 0 };
	}

	recordLsn(lsn: string) {
		// Concurrent responses can arrive out of order. LSNs are decimal u64 strings,
		// so compare without losing precision or weakening the read-your-writes fence.
		if (!this.lastLsn || BigInt(lsn) > BigInt(this.lastLsn)) this.lastLsn = lsn;
		this.lastLsnAt = Date.now();
	}

	readOptions() {
		return this.lastLsn && Date.now() - this.lastLsnAt < 120000 ? { lsn: this.lastLsn } : undefined;
	}

	/**
	 * List what is already indexed (one row per attachment) so a fresh install
	 * can reconcile with an existing collection instead of re-rendering everything.
	 */
	async manifest({ libraryKey }: LibraryRequest): Promise<BridgeResponses["/manifest"]> {
		const lib = asLibraryKey(libraryKey);
		const { select, field } = this._sdk().query;
		const col = this._col();
		const PAGE = 500;
		const rows: ManifestRow[] = [];
		const base = () => field("page").eq(1).and(field("indexed_pages").gt(0)).and(field("library_key").eq(lib));
		const fields = {
			attachment_key: field("attachment_key"),
			library_id: field("library_id"),
			library_key: field("library_key"),
			indexed_pages: field("indexed_pages"),
			file_hash: field("file_hash"),
			page_count: field("page_count"),
		};
		try {
			let last: string | null = null;
			for (;;) {
				let f = base();
				if (last !== null) f = f.and(field("attachment_key").gt(last));
				const docs = await withRetry("manifest", () => col.query(select(fields).filter(f).sort(field("attachment_key"), true).limit(PAGE), this.readOptions()), { maxMs: 90000 });
				rows.push(...docs as unknown as ManifestRow[]);
				if (docs.length < PAGE) break;
				if (rows.length >= MAX_MANIFEST_ROWS) return { rows, complete: false };
				last = String(docs[docs.length - 1].attachment_key);
			}
			return { rows, complete: true };
		}
		catch (e) {
			log("manifest: keyset pagination failed, falling back to a single page:", message(e));
			const docs = await withRetry("manifest fallback", () => col.query(select(fields).filter(base()).sort(field("page"), true).limit(1000), this.readOptions()), { maxMs: 90000 });
			return { rows: docs as unknown as ManifestRow[], complete: docs.length < 1000 };
		}
	}
}

export class FakeBackend implements Backend {
	docs: Map<string, PageDoc>;
	targets: Map<string, Map<string, PageDoc>>;
	collectionName: string | null;
	region: string | null;
	constructor() {
		this.docs = new Map();
		this.targets = new Map();
		this.collectionName = null;
		this.region = null;
	}

	get configured() {
		return !!this.collectionName;
	}

	async configure({ apiKey, region, collection, host }: ConfigureRequest): Promise<BridgeResponses["/configure"]> {
		validateDestination({ region, collection, host });
		const target = JSON.stringify([apiKey, region, collection, host]);
		if (!this.targets.has(target)) this.targets.set(target, new Map());
		this.docs = this.targets.get(target)!;
		this.collectionName = collection;
		this.region = region;
		return { ok: true, created: false, collection: this.collectionName, region: this.region, fake: true };
	}

	async status(): Promise<BridgeResponses["/status"]> {
		return { configured: this.configured, collection: this.collectionName, region: this.region, docCount: this.docs.size, fake: true };
	}

	async upsert({ docs }: UpsertRequest): Promise<BridgeResponses["/upsert"]> {
		if (!Array.isArray(docs) || !docs.length) throw new HttpError(400, "docs must be a non-empty array");
		for (const d of docs) {
			if (!d || typeof d._id !== "string" || typeof d.page_image_b64 !== "string") throw new HttpError(400, "each doc needs _id and page_image_b64");
			this.docs.set(d._id, d);
		}
		return { ok: true, lsn: String(this.docs.size), count: docs.length };
	}

	async search({ query, limit = 50, libraryKeys }: SearchRequest): Promise<BridgeResponses["/search"]> {
		if (!query || typeof query !== "string") throw new HttpError(400, "query is required");
		limit = Math.max(1, Math.min(500, Number(limit) || 50));
		const terms = String(query).toLowerCase().split(/\W+/).filter(Boolean);
		const hits: SearchHit[] = [];
		for (const d of this.docs.values()) {
			if (!Array.isArray(libraryKeys) || !libraryKeys.map(asLibraryKey).includes(d.library_key)) continue;
			const title = String(d.title || "").toLowerCase();
			let score = 0.01 / (1 + d.page);
			for (const t of terms) if (title.includes(t)) score += 1;
			const hit = { score } as SearchHit;
			for (const f of SEARCH_FIELDS) (hit as unknown as Record<string, unknown>)[f] = d[f];
			hit._id = d._id;
			hits.push(hit);
		}
		hits.sort((a, b) => b.score - a.score);
		return { hits: hits.slice(0, limit) };
	}

	async images({ ids }: ImagesRequest): Promise<BridgeResponses["/images"]> {
		const images: Record<string, PageImage> = {};
		if (!Array.isArray(ids)) return { images: {} };
		for (const id of ids.slice(0, 50)) {
			const d = this.docs.get(id);
			if (d) images[id] = { format: "jpeg", b64: d.page_image_b64 };
		}
		return imageResponse(images);
	}

	async deleteAttachments({ libraryKey, attachmentKeys }: DeleteRequest): Promise<BridgeResponses["/delete"]> {
		const lib = asLibraryKey(libraryKey);
		if (!Array.isArray(attachmentKeys)) throw new HttpError(400, "attachmentKeys must be an array");
		let deleted = 0;
		for (const [id, d] of this.docs) {
			if (d.library_key === lib && attachmentKeys.includes(d.attachment_key)) {
				this.docs.delete(id);
				deleted++;
			}
		}
		return { ok: true, deleted };
	}

	async deleteLibrary({ libraryKey }: LibraryRequest): Promise<BridgeResponses["/delete-library"]> {
		const lib = asLibraryKey(libraryKey);
		for (const [id, d] of this.docs) if (d.library_key === lib) this.docs.delete(id);
		return { ok: true, libraryKey: lib };
	}

	async hasAttachment({ libraryKey, attachmentKey }: AttachmentRequest): Promise<BridgeResponses["/attachment-status"]> {
		const lib = asLibraryKey(libraryKey);
		return { exists: [...this.docs.values()].some((d) => d.library_key === lib && d.attachment_key === attachmentKey) };
	}

	async manifest({ libraryKey }: LibraryRequest): Promise<BridgeResponses["/manifest"]> {
		const lib = asLibraryKey(libraryKey);
		const rows: ManifestRow[] = [];
		for (const d of this.docs.values()) {
			if (d.page === 1 && (d.indexed_pages ?? 0) > 0 && d.library_key === lib) {
				rows.push({ attachment_key: d.attachment_key, library_id: d.library_id, library_key: d.library_key, indexed_pages: d.indexed_pages!, file_hash: d.file_hash, page_count: d.page_count });
			}
		}
		return { rows, complete: true };
	}
}

