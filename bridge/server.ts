// The plugin owns this loopback helper through its stdin pipe.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version as BRIDGE_VERSION } from "../package.json";
import { FakeBackend, TopKBackend, HttpError } from "./backend";
import type { Backend } from "./backend";
import { createScheduler, SCOPE } from "./scheduler";
import type { BridgeRoutes, ConfigureRequest, SearchRequest, ImagesRequest, LibraryRequest, AttachmentRequest } from "../shared/protocol";
import { BRIDGE_READY_PREFIX, type BridgeReady } from "../shared/protocol";

const MAX_BODY = 64 * 1024 * 1024;
const MAX_ERROR_TEXT = 500;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function log(...args: unknown[]) { console.error("[topk-bridge]", ...args); }

// Compare fixed-size digests so neither token length nor content leaks via timing.
function tokenMatches(header: string | undefined, digest: Buffer) {
	if (!header?.startsWith("Bearer ")) return false;
	return crypto.timingSafeEqual(crypto.createHash("sha256").update(header.slice(7)).digest(), digest);
}
// Only loopback peers are expected; a browser-originated request (DNS rebinding) carries a foreign Host header.
function hostAllowed(host: string | undefined) {
	if (typeof host !== "string") return false;
	const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
	return name === "127.0.0.1" || name === "localhost" || name === "::1";
}
/** The HTTP boundary accepts untrusted JSON; each backend validates its request fields. */
export function createRoutes(backend: Backend): BridgeRoutes {
	const scheduled = createScheduler();
	return {
		"GET /health": () => ({ ok: true, version: BRIDGE_VERSION, fake: backend instanceof FakeBackend, configured: backend.configured }),
		"GET /status": scheduled(SCOPE.read, () => backend.status()),
		"POST /configure": scheduled(SCOPE.all, (body: ConfigureRequest) => backend.configure(body)),
		"POST /upsert": scheduled(SCOPE.upload, (body) => backend.upsert(body)),
		"POST /search": scheduled(SCOPE.read, (body: SearchRequest) => backend.search(body)),
		"POST /images": scheduled(SCOPE.read, (body: ImagesRequest) => backend.images(body)),
		"POST /delete": scheduled(SCOPE.attachments, (body) => backend.deleteAttachments(body)),
		"POST /delete-library": scheduled(SCOPE.library, (body) => backend.deleteLibrary(body)),
		"POST /manifest": scheduled(SCOPE.read, (body: LibraryRequest) => backend.manifest(body)),
		"POST /attachment-status": scheduled(SCOPE.read, (body: AttachmentRequest) => backend.hasAttachment(body)),
	};
}

function readBody(req: IncomingMessage) {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
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

function send(res: ServerResponse, status: number, obj: unknown) {
	const body = Buffer.from(JSON.stringify(obj));
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": body.length,
		"Cache-Control": "no-store",
	});
	res.end(body);
}

export function startServer({ token, port = 0, fake = false }: { token: string; port?: number; fake?: boolean }) {
	if (token.length < 32) throw new Error("TOPK_BRIDGE_TOKEN is required (at least 32 characters)");
	const digest = crypto.createHash("sha256").update(token).digest();
	const routes = createRoutes(fake ? new FakeBackend() : new TopKBackend()) as Record<string, (body: unknown) => unknown>;
	const server = http.createServer(async (req, res) => {
		try {
			if (!tokenMatches(req.headers.authorization, digest)) throw new HttpError(401, "unauthorized");
			if (!hostAllowed(req.headers.host)) throw new HttpError(403, "forbidden host");
			const url = new URL(req.url || "/", "http://127.0.0.1");
			const handler = routes[`${req.method} ${url.pathname}`];
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
			if (status >= 500) log("error:", e instanceof Error ? e.stack : e);
			// Error text may originate from the remote service: keep it short and never let it carry control characters.
			const text = message(e).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_TEXT);
			send(res, status, { error: text });
		}
	});

	server.keepAliveTimeout = 120000;
	server.listen(port, "127.0.0.1", () => {
		const { port } = server.address() as import("node:net").AddressInfo;
		const ready: BridgeReady = { port, version: BRIDGE_VERSION, fake };
		process.stdout.write(`${BRIDGE_READY_PREFIX}${JSON.stringify(ready)}\n`);
		log(`listening on 127.0.0.1:${port}${fake ? " (FAKE backend)" : ""}`);
	});

	return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	startServer({ token: process.env.TOPK_BRIDGE_TOKEN || "", port: Number(process.env.TOPK_BRIDGE_PORT || 0), fake: process.env.TOPK_BRIDGE_FAKE === "1" });
	// Exit when Zotero closes the session pipe, including an unexpected parent crash.
	process.stdin.on("end", () => process.exit(0));
	process.stdin.on("error", () => process.exit(0));
	process.stdin.resume();
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}
