// Local helper for the Zotero TopK plugin.
//
// Zotero runs on Gecko and cannot load Node native modules, so the plugin
// spawns this process and talks to it over localhost HTTP. All TopK traffic
// goes through the official `topk-js` SDK in here.
//
// Environment:
//   TOPK_BRIDGE_TOKEN  shared secret; every request must send it as a Bearer token
//   TOPK_BRIDGE_PORT   optional fixed port (default: random free port)
//   TOPK_BRIDGE_FAKE   "1" → in-memory fake backend (plugin development/tests)
"use strict";

const http = require("http");
const crypto = require("crypto");
const { version: BRIDGE_VERSION } = require("./package.json");

const TOKEN = process.env.TOPK_BRIDGE_TOKEN || "";
const FAKE = process.env.TOPK_BRIDGE_FAKE === "1";
const PORT = Number(process.env.TOPK_BRIDGE_PORT || 0);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_MANIFEST_ROWS = 50000;
const MAX_ERROR_TEXT = 500;
const MAX_IMAGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const SEARCH_FIELDS = ["library_id", "library_key", "attachment_key", "item_key", "page", "page_count", "title"];
// Region / host are interpolated into https://<region>.api.<host> by the SDK: allow hostname labels only.
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

if (TOKEN.length < 32) {
	console.error("TOPK_BRIDGE_TOKEN is required (at least 32 characters)");
	process.exit(2);
}
// Constant-time bearer check: compare fixed-length digests so neither token length nor content leaks via timing.
const TOKEN_DIGEST = crypto.createHash("sha256").update(TOKEN).digest();
function tokenMatches(header) {
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const digest = crypto.createHash("sha256").update(header.slice(7)).digest();
	return crypto.timingSafeEqual(digest, TOKEN_DIGEST);
}
// Only loopback peers are expected; a browser-originated request (DNS rebinding) carries a foreign Host header.
function hostAllowed(host) {
	if (typeof host !== "string") return false;
	const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
	return name === "127.0.0.1" || name === "localhost" || name === "::1";
}
function asLibraryKey(value) {
	if (typeof value !== "string" || !/^(group:[1-9][0-9]*|user:[1-9][0-9]*|local:[A-Za-z0-9]+)$/.test(value)) {
		throw new HttpError(400, "libraryKey must be a qualified Zotero library identity");
	}
	return value;
}

/** Return a bounded thumbnail batch; callers can request omitted IDs separately. */
function imageResponse(images) {
	const result = Object.create(null);
	let bytes = Buffer.byteLength('{"images":{}}');
	for (const [id, image] of Object.entries(images)) {
		const size = Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(image)) + 2;
		if (bytes + size > MAX_IMAGE_RESPONSE_BYTES) continue;
		result[id] = image;
		bytes += size;
	}
	return { images: result };
}

function log(...args) {
	console.error("[topk-bridge]", ...args);
}

const TRANSIENT = /Unavailable|temporarily unavailable|QuotaExceeded|Too many requests|timed out|timeout|deadline|Unknown|transport|connection|ECONN|EAI_AGAIN|lsn/i;

/**
 * Retry transient TopK failures (cluster scaling from zero, rate limits,
 * network blips) with exponential backoff for up to `maxMs` milliseconds.
 */
async function withRetry(what, fn, { maxMs = 240000, initMs = 1000, maxDelayMs = 20000 } = {}) {
	const started = Date.now();
	let delay = initMs;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		}
		catch (e) {
			const msg = String(e && e.message || e);
			const elapsed = Date.now() - started;
			if (e instanceof HttpError || !TRANSIENT.test(msg) || elapsed + delay > maxMs) throw e;
			log(`${what}: transient error (attempt ${attempt}, retrying in ${delay}ms): ${msg.slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, delay));
			delay = Math.min(maxDelayMs, Math.round(delay * 1.8));
		}
	}
}

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Real backend: TopK via topk-js
// ---------------------------------------------------------------------------
class TopKBackend {
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
			// One document per rendered page; the page image carries the semantic index.
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
		return this.client.collection(this.collectionName);
	}

	async configure({ apiKey, region, collection, host }) {
		if (typeof apiKey !== "string" || !apiKey) throw new HttpError(400, "apiKey is required");
		if (typeof region !== "string" || !HOST_LABEL.test(region)) throw new HttpError(400, "region must be a single hostname label (e.g. aws-us-east-1-elastica)");
		if (typeof collection !== "string" || !COLLECTION_NAME.test(collection)) throw new HttpError(400, "collection must match [A-Za-z0-9_-]{1,128}");
		if (host != null && host !== "" && (typeof host !== "string" || !HOST_NAME.test(host))) throw new HttpError(400, "host must be a hostname (e.g. topk.io)");
		const { Client } = this._sdk();
		const config = {
			apiKey,
			region,
			// The SDK's own retries are short; keep them but let withRetry() handle cold starts.
			retryConfig: { maxRetries: 5, timeout: 120000, backoff: { initBackoff: 250, maxBackoff: 5000 } },
		};
		if (host) config.host = host; // endpoint becomes https://<region>.api.<host>
		const client = new Client(config);
		let created = false;
		let col;
		try {
			col = await withRetry("get collection", () => client.collections().get(collection));
		}
		catch (e) {
			if (/not found/i.test(String(e && e.message))) {
				log(`creating collection "${collection}" in ${region}${host ? ` (${host})` : ""}`);
				col = await withRetry("create collection", () => client.collections().create(collection, this._schema()));
				created = true;
			}
			else {
				throw new HttpError(502, `TopK: ${e.message || e}`);
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

	async status() {
		if (!this.client) return { configured: false };
		let docCount = null;
		try {
			docCount = await withRetry("count", () => this._col().count(), { maxMs: 30000 });
		}
		catch (e) {
			log("count failed:", e.message || e);
		}
		return { configured: true, collection: this.collectionName, region: this.region, host: this.host, docCount };
	}

	async upsert({ docs }) {
		if (!Array.isArray(docs) || !docs.length) throw new HttpError(400, "docs must be a non-empty array");
		const { image } = this._sdk().data;
		const payload = docs.map((d) => {
			if (!d._id || !d.page_image_b64) throw new HttpError(400, "each doc needs _id and page_image_b64");
			const { page_image_b64, ...rest } = d;
			return { ...rest, page_image: image(Buffer.from(page_image_b64, "base64")) };
		});
		const lsn = await withRetry("upsert", () => this._col().upsert(payload));
		this.lastLsn = lsn;
		this.lastLsnAt = Date.now();
		return { ok: true, lsn, count: payload.length };
	}

	async search({ query, limit = 50, libraryKeys }) {
		if (!query || typeof query !== "string") throw new HttpError(400, "query is required");
		const { select, field, fn } = this._sdk().query;
		const selected = { score: fn.semanticSimilarity("page_image", query) };
		for (const f of SEARCH_FIELDS) selected[f] = field(f);
		let q = select(selected);
		if (!Array.isArray(libraryKeys) || !libraryKeys.length) return { hits: [] };
		q = q.filter(field("library_key").in(libraryKeys.map(asLibraryKey)));
		q = q.sort(field("score"), false).limit(Math.max(1, Math.min(500, Number(limit) || 50)));
		// Read-your-writes right after indexing: wait for the last upsert to be visible.
		const options = (this.lastLsn && Date.now() - this.lastLsnAt < 120000) ? { lsn: this.lastLsn } : undefined;
		const docs = await withRetry("search", () => this._col().query(q, options), { maxMs: 90000 });
		return { hits: docs.map((d) => ({ ...d, score: Number(d.score) })) };
	}

	async images({ ids }) {
		if (!Array.isArray(ids) || !ids.length) return { images: {} };
		const docs = await withRetry("get images", () => this._col().get(ids.slice(0, 50), ["page_image"]), { maxMs: 90000 });
		const images = {};
		for (const [id, doc] of Object.entries(docs)) {
			const img = doc && doc.page_image;
			if (img && img.data) {
				images[id] = { format: img.format, b64: Buffer.from(img.data).toString("base64") };
			}
		}
		return imageResponse(images);
	}

	async deleteAttachments({ libraryKey, attachmentKeys }) {
		const lib = asLibraryKey(libraryKey);
		if (!Array.isArray(attachmentKeys) || !attachmentKeys.length) return { ok: true, deleted: 0 };
		if (!attachmentKeys.every((k) => typeof k === "string" && k.length <= 64)) throw new HttpError(400, "attachmentKeys must be strings");
		const { field } = this._sdk().query;
		for (let i = 0; i < attachmentKeys.length; i += 100) {
			const chunk = attachmentKeys.slice(i, i + 100);
			// Always scoped to one library: a collection-wide delete is never issued.
			const expr = field("library_key").eq(lib).and(field("attachment_key").in(chunk));
			const lsn = await withRetry("delete", () => this._col().delete(expr));
			this.lastLsn = lsn;
			this.lastLsnAt = Date.now();
		}
		return { ok: true, deleted: attachmentKeys.length };
	}

	/** Remove every page of one library (used when a group library is removed from Zotero). */
	async deleteLibrary({ libraryKey }) {
		const lib = asLibraryKey(libraryKey);
		const { field } = this._sdk().query;
		const lsn = await withRetry("delete library", () => this._col().delete(field("library_key").eq(lib)));
		this.lastLsn = lsn;
		this.lastLsnAt = Date.now();
		return { ok: true, libraryKey: lib };
	}

	async hasAttachment({ libraryKey, attachmentKey }) {
		const lib = asLibraryKey(libraryKey);
		if (typeof attachmentKey !== "string" || !attachmentKey) throw new HttpError(400, "attachmentKey is required");
		const { select, field } = this._sdk().query;
		const col = this._col();
		const q = select("attachment_key").filter(field("library_key").eq(lib).and(field("attachment_key").eq(attachmentKey))).limit(1);
		const docs = await withRetry("attachment status", () => col.query(q, this.readOptions()), { maxMs: 90000 });
		return { exists: docs.length > 0 };
	}

	readOptions() {
		return this.lastLsn && Date.now() - this.lastLsnAt < 120000 ? { lsn: this.lastLsn } : undefined;
	}

	/**
	 * List what is already indexed (one row per attachment) so a fresh install
	 * can reconcile with an existing collection instead of re-rendering everything.
	 */
	async manifest({ libraryKey }) {
		const lib = asLibraryKey(libraryKey);
		const { select, field } = this._sdk().query;
		const col = this._col();
		const PAGE = 500;
		const rows = [];
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
			let last = null;
			for (;;) {
				let f = base();
				if (last !== null) f = f.and(field("attachment_key").gt(last));
				const docs = await withRetry("manifest", () => col.query(select(fields).filter(f).sort(field("attachment_key"), true).limit(PAGE), this.readOptions()), { maxMs: 90000 });
				rows.push(...docs);
				if (docs.length < PAGE) break;
				if (rows.length >= MAX_MANIFEST_ROWS) return { rows, complete: false };
				last = docs[docs.length - 1].attachment_key;
			}
			return { rows, complete: true };
		}
		catch (e) {
			log("manifest: keyset pagination failed, falling back to a single page:", e.message || e);
			const docs = await withRetry("manifest fallback", () => col.query(select(fields).filter(base()).sort(field("page"), true).limit(1000), this.readOptions()), { maxMs: 90000 });
			return { rows: docs, complete: docs.length < 1000 };
		}
	}
}

// ---------------------------------------------------------------------------
// Fake backend for development and automated tests (no network, no API key)
// ---------------------------------------------------------------------------
class FakeBackend {
	constructor() {
		this.docs = new Map();
		this.targets = new Map();
		this.collectionName = null;
		this.region = null;
	}

	get configured() {
		return !!this.collectionName;
	}

	async configure({ apiKey, region, collection, host }) {
		// Same input contract as the real backend, so tests exercise the validation.
		if (typeof region !== "string" || !HOST_LABEL.test(region)) throw new HttpError(400, "region must be a single hostname label (e.g. aws-us-east-1-elastica)");
		if (typeof collection !== "string" || !COLLECTION_NAME.test(collection)) throw new HttpError(400, "collection must match [A-Za-z0-9_-]{1,128}");
		if (host != null && host !== "" && (typeof host !== "string" || !HOST_NAME.test(host))) throw new HttpError(400, "host must be a hostname (e.g. topk.io)");
		const target = JSON.stringify([apiKey, region, collection, host]);
		if (!this.targets.has(target)) this.targets.set(target, new Map());
		this.docs = this.targets.get(target);
		this.collectionName = collection;
		this.region = region;
		return { ok: true, created: false, collection: this.collectionName, region: this.region, fake: true };
	}

	async status() {
		return { configured: this.configured, collection: this.collectionName, region: this.region, docCount: this.docs.size, fake: true };
	}

	async upsert({ docs }) {
		if (!Array.isArray(docs) || !docs.length) throw new HttpError(400, "docs must be a non-empty array");
		for (const d of docs) {
			if (!d || typeof d._id !== "string" || typeof d.page_image_b64 !== "string") throw new HttpError(400, "each doc needs _id and page_image_b64");
			this.docs.set(d._id, d);
		}
		return { ok: true, lsn: String(this.docs.size), count: docs.length };
	}

	async search({ query, limit = 50, libraryKeys }) {
		if (!query || typeof query !== "string") throw new HttpError(400, "query is required");
		limit = Math.max(1, Math.min(500, Number(limit) || 50));
		const terms = String(query).toLowerCase().split(/\W+/).filter(Boolean);
		const hits = [];
		for (const d of this.docs.values()) {
			if (!Array.isArray(libraryKeys) || !libraryKeys.map(asLibraryKey).includes(d.library_key)) continue;
			const title = String(d.title || "").toLowerCase();
			let score = 0.01 / (1 + d.page);
			for (const t of terms) if (title.includes(t)) score += 1;
			const hit = { score };
			for (const f of SEARCH_FIELDS) hit[f] = d[f];
			hit._id = d._id;
			hits.push(hit);
		}
		hits.sort((a, b) => b.score - a.score);
		return { hits: hits.slice(0, limit) };
	}

	async images({ ids }) {
		const images = {};
		if (!Array.isArray(ids)) return { images: {} };
		for (const id of ids.slice(0, 50)) {
			const d = this.docs.get(id);
			if (d) images[id] = { format: "jpeg", b64: d.page_image_b64 };
		}
		return imageResponse(images);
	}

	async deleteAttachments({ libraryKey, attachmentKeys }) {
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

	async deleteLibrary({ libraryKey }) {
		const lib = asLibraryKey(libraryKey);
		for (const [id, d] of this.docs) if (d.library_key === lib) this.docs.delete(id);
		return { ok: true, libraryKey: lib };
	}

	async hasAttachment({ libraryKey, attachmentKey }) {
		const lib = asLibraryKey(libraryKey);
		return { exists: [...this.docs.values()].some((d) => d.library_key === lib && d.attachment_key === attachmentKey) };
	}

	async manifest({ libraryKey }) {
		const lib = asLibraryKey(libraryKey);
		const rows = [];
		for (const d of this.docs.values()) {
			if (d.page === 1 && d.indexed_pages > 0 && d.library_key === lib) {
				rows.push({ attachment_key: d.attachment_key, library_id: d.library_id, library_key: d.library_key, indexed_pages: d.indexed_pages, file_hash: d.file_hash, page_count: d.page_count });
			}
		}
		return { rows, complete: true };
	}
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
// A client HTTP timeout does not cancel a TopK write. Keep mutations and
// reconfiguration ordered here too, so a late upload cannot follow its deletion.
let mutations = Promise.resolve();
function serializeMutation(fn) {
	return (...args) => {
		const result = mutations.then(() => fn(...args));
		mutations = result.catch(() => {});
		return result;
	};
}

const backend = FAKE ? new FakeBackend() : new TopKBackend();

const ROUTES = {
	"GET /health": async () => ({ ok: true, version: BRIDGE_VERSION, fake: FAKE, configured: backend.configured }),
	"GET /status": () => backend.status(),
	"POST /configure": serializeMutation((body) => backend.configure(body)),
	"POST /upsert": serializeMutation((body) => backend.upsert(body)),
	"POST /search": (body) => backend.search(body),
	"POST /images": (body) => backend.images(body),
	"POST /delete": serializeMutation((body) => backend.deleteAttachments(body)),
	"POST /delete-library": serializeMutation((body) => backend.deleteLibrary(body)),
	"POST /manifest": (body) => backend.manifest(body),
	"POST /attachment-status": (body) => backend.hasAttachment(body),
	"POST /shutdown": async () => {
		setTimeout(() => process.exit(0), 50);
		return { ok: true };
	},
};

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new HttpError(413, "request body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function send(res, status, obj) {
	const body = Buffer.from(JSON.stringify(obj));
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": body.length,
		"Cache-Control": "no-store",
	});
	res.end(body);
}

const server = http.createServer(async (req, res) => {
	try {
		if (!tokenMatches(req.headers.authorization)) throw new HttpError(401, "unauthorized");
		if (!hostAllowed(req.headers.host)) throw new HttpError(403, "forbidden host");
		const url = new URL(req.url, "http://127.0.0.1");
		const handler = ROUTES[`${req.method} ${url.pathname}`];
		if (!handler) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
		let body = {};
		if (req.method === "POST") {
			const raw = await readBody(req);
			if (raw.length) {
				try {
					body = JSON.parse(raw.toString("utf8"));
				}
				catch (e) {
					throw new HttpError(400, "invalid JSON body");
				}
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
			}
		}
		const result = await handler(body);
		send(res, 200, result);
	}
	catch (e) {
		const status = e instanceof HttpError ? e.status : 500;
		if (status >= 500) log("error:", e && e.stack || e);
		// Error text may originate from the remote service: keep it short and never let it carry control characters.
		const text = String(e && e.message || e).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_TEXT);
		send(res, status, { error: text });
	}
});

server.keepAliveTimeout = 120000;
server.listen(PORT, "127.0.0.1", () => {
	const { port } = server.address();
	// The plugin waits for this exact line on stdout.
	process.stdout.write(`TOPK_BRIDGE_READY ${JSON.stringify({ port, version: BRIDGE_VERSION, fake: FAKE })}\n`);
	log(`listening on 127.0.0.1:${port}${FAKE ? " (FAKE backend)" : ""}`);
});

// Exit when the parent goes away (stdin closes when Zotero quits or kills us).
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
