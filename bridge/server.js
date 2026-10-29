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
const { version: BRIDGE_VERSION } = require("./package.json");

const TOKEN = process.env.TOPK_BRIDGE_TOKEN || "";
const FAKE = process.env.TOPK_BRIDGE_FAKE === "1";
const PORT = Number(process.env.TOPK_BRIDGE_PORT || 0);
const MAX_BODY = 64 * 1024 * 1024;
const SEARCH_FIELDS = ["library_id", "attachment_key", "item_key", "page", "page_count", "title"];

if (!TOKEN) {
	console.error("TOPK_BRIDGE_TOKEN is required");
	process.exit(2);
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
		if (!apiKey) throw new HttpError(400, "apiKey is required");
		if (!region) throw new HttpError(400, "region is required");
		if (!collection) throw new HttpError(400, "collection is required");
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

	async search({ query, limit = 50, libraryIDs }) {
		if (!query || typeof query !== "string") throw new HttpError(400, "query is required");
		const { select, field, fn } = this._sdk().query;
		const selected = { score: fn.semanticSimilarity("page_image", query) };
		for (const f of SEARCH_FIELDS) selected[f] = field(f);
		let q = select(selected);
		if (Array.isArray(libraryIDs) && libraryIDs.length) {
			q = q.filter(field("library_id").in(libraryIDs.map(Number)));
		}
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
		return { images };
	}

	async deleteAttachments({ libraryID, attachmentKeys }) {
		if (!Array.isArray(attachmentKeys) || !attachmentKeys.length) return { ok: true, deleted: 0 };
		const { field } = this._sdk().query;
		for (let i = 0; i < attachmentKeys.length; i += 100) {
			const chunk = attachmentKeys.slice(i, i + 100);
			let expr = field("attachment_key").in(chunk);
			if (libraryID != null) expr = field("library_id").eq(Number(libraryID)).and(expr);
			const lsn = await withRetry("delete", () => this._col().delete(expr));
			this.lastLsn = lsn;
			this.lastLsnAt = Date.now();
		}
		return { ok: true, deleted: attachmentKeys.length };
	}

	/**
	 * List what is already indexed (one row per attachment) so a fresh install
	 * can reconcile with an existing collection instead of re-rendering everything.
	 */
	async manifest({ libraryID }) {
		const { select, field } = this._sdk().query;
		const col = this._col();
		const PAGE = 500;
		const rows = [];
		const base = () => {
			let f = field("page").eq(1);
			if (libraryID != null) f = f.and(field("library_id").eq(Number(libraryID)));
			return f;
		};
		const fields = {
			attachment_key: field("attachment_key"),
			library_id: field("library_id"),
			file_hash: field("file_hash"),
			page_count: field("page_count"),
		};
		try {
			let last = null;
			for (;;) {
				let f = base();
				if (last !== null) f = f.and(field("attachment_key").gt(last));
				const docs = await withRetry("manifest", () => col.query(select(fields).filter(f).sort(field("attachment_key"), true).limit(PAGE)), { maxMs: 90000 });
				rows.push(...docs);
				if (docs.length < PAGE) break;
				last = docs[docs.length - 1].attachment_key;
			}
			return { rows, complete: true };
		}
		catch (e) {
			log("manifest: keyset pagination failed, falling back to a single page:", e.message || e);
			const docs = await withRetry("manifest fallback", () => col.query(select(fields).filter(base()).sort(field("page"), true).limit(1000)), { maxMs: 90000 });
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
		this.collectionName = null;
		this.region = null;
	}

	get configured() {
		return !!this.collectionName;
	}

	async configure({ region, collection }) {
		this.collectionName = collection || "fake";
		this.region = region || "fake";
		return { ok: true, created: false, collection: this.collectionName, region: this.region, fake: true };
	}

	async status() {
		return { configured: this.configured, collection: this.collectionName, region: this.region, docCount: this.docs.size, fake: true };
	}

	async upsert({ docs }) {
		for (const d of docs) this.docs.set(d._id, d);
		return { ok: true, lsn: String(this.docs.size), count: docs.length };
	}

	async search({ query, limit = 50, libraryIDs }) {
		const terms = String(query).toLowerCase().split(/\W+/).filter(Boolean);
		const hits = [];
		for (const d of this.docs.values()) {
			if (Array.isArray(libraryIDs) && libraryIDs.length && !libraryIDs.includes(d.library_id)) continue;
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
		for (const id of ids || []) {
			const d = this.docs.get(id);
			if (d) images[id] = { format: "jpeg", b64: d.page_image_b64 };
		}
		return { images };
	}

	async deleteAttachments({ libraryID, attachmentKeys }) {
		let deleted = 0;
		for (const [id, d] of this.docs) {
			if ((libraryID == null || d.library_id === libraryID) && attachmentKeys.includes(d.attachment_key)) {
				this.docs.delete(id);
				deleted++;
			}
		}
		return { ok: true, deleted };
	}

	async manifest({ libraryID }) {
		const rows = [];
		for (const d of this.docs.values()) {
			if (d.page === 1 && (libraryID == null || d.library_id === libraryID)) {
				rows.push({ attachment_key: d.attachment_key, library_id: d.library_id, file_hash: d.file_hash, page_count: d.page_count });
			}
		}
		return { rows, complete: true };
	}
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const backend = FAKE ? new FakeBackend() : new TopKBackend();

const ROUTES = {
	"GET /health": async () => ({ ok: true, version: BRIDGE_VERSION, fake: FAKE, configured: backend.configured }),
	"GET /status": () => backend.status(),
	"POST /configure": (body) => backend.configure(body),
	"POST /upsert": (body) => backend.upsert(body),
	"POST /search": (body) => backend.search(body),
	"POST /images": (body) => backend.images(body),
	"POST /delete": (body) => backend.deleteAttachments(body),
	"POST /manifest": (body) => backend.manifest(body),
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
		const auth = req.headers.authorization || "";
		if (auth !== `Bearer ${TOKEN}`) throw new HttpError(401, "unauthorized");
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
			}
		}
		const result = await handler(body);
		send(res, 200, result);
	}
	catch (e) {
		const status = e instanceof HttpError ? e.status : 500;
		if (status >= 500) log("error:", e && e.stack || e);
		send(res, status, { error: String(e && e.message || e) });
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
