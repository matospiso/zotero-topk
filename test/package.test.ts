import { after as afterAll, before as beforeAll, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { TopKBackend } from "../bridge/server";
import { version } from "../package.json";

let extracted: string;
beforeAll(() => {
	execFileSync(process.execPath, ["--import", "tsx", "scripts/build.ts"], { stdio: "pipe" });
	extracted = mkdtempSync(join(tmpdir(), "topk-node-package-"));
	execFileSync("unzip", ["-q", `build/zotero-topk-${version}.xpi`, "-d", extracted]);
});
afterAll(() => { if (extracted) rmSync(extracted, { recursive: true, force: true }); });

test("XPI exposes Zotero lifecycle callbacks and compiled default preferences", () => {
	const context = vm.createContext({});
	vm.runInContext(readFileSync(join(extracted, "bootstrap.js"), "utf8"), context);
	for (const name of ["install", "uninstall", "startup", "shutdown", "onMainWindowLoad", "onMainWindowUnload"]) {
		assert.equal(typeof context[name], "function");
	}
	const prefs = new Map<string, unknown>();
	vm.runInNewContext(readFileSync(join(extracted, "prefs.js"), "utf8"), { pref: (key: string, value: unknown) => prefs.set(key, value) });
	assert.equal(prefs.get("extensions.zotero-topk.nodePath"), "");
	assert.equal(prefs.get("extensions.zotero-topk.uploadConcurrency"), 4);
	assert.equal(prefs.has("extensions.zotero-topk.bunPath"), false);
	const renderer = readFileSync(join(extracted, "content/renderer.js"), "utf8");
	assert.ok(renderer.includes('"./pdfjs/pdf.mjs"'));
	assert.ok(!renderer.includes('from "pdfjs-dist"'));
});

test("the pinned native TopK SDK loads under Node without credentials or network", () => {
	const backend = new TopKBackend();
	const sdk = backend._sdk();
	const client = new sdk.Client({ apiKey: "never-provisioned-test-key", region: "aws-us-east-1-elastica" });
	assert.ok(client.collection("compatibility-probe"));
	assert.ok(sdk.data.image(readFileSync("addon/content/icons/topk-48.png")));
	assert.ok(backend._schema().page_image);
});

test("production plugin bundle loads as a classic Gecko script and ignores the fake preference", async () => {
	const context = vm.createContext({ rootURI: "resource://zotero-topk/", pluginVersion: version,
		ChromeUtils: { importESModule: () => ({}) },
		Zotero: { Prefs: { get: (key: string) => key.endsWith("bridgeFake") ? true : "" } },
	});
	vm.runInContext(readFileSync(join(extracted, "content/zotero-topk.js"), "utf8"), context);
	assert.equal(context.Zotero.TopK.version, version);
	assert.equal(context.Zotero.TopK.rootURI, "resource://zotero-topk/");
	context.Zotero.TopK.bridge.ensureRunning = async () => {};
	await assert.rejects(context.Zotero.TopK.bridge.ensureReady(), /No TopK API key/);
});

test("packaged Node helper serves authenticated requests and exits when its parent pipe closes", { timeout: 10000 }, async () => {
	const token = "test-session-token-".repeat(3);
	const child = spawn(process.execPath, ["server.js"], {
		cwd: join(extracted, "bridge"), env: { ...process.env, TOPK_BRIDGE_TOKEN: token, TOPK_BRIDGE_FAKE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = once(child, "exit");
	let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
	try {
		let stdout = "";
		for await (const chunk of child.stdout) {
			stdout += chunk;
			if (stdout.includes("\n")) break;
		}
		const match = stdout.match(/TOPK_BRIDGE_READY (.+)\n/);
		assert.ok(match, `Helper exited before READY: ${stderr}`);
		const ready = JSON.parse(match[1]);
		assert.equal(ready.fake, true);
		const base = `http://127.0.0.1:${ready.port}`;
		const request = (route: string, body?: unknown, headers = {}) => fetch(base + route, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		assert.equal((await fetch(base + "/health")).status, 401);
		const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
			const req = httpRequest(base + "/health", { headers: { Host: "foreign.example", Authorization: `Bearer ${token}` } }, (res) => {
				res.resume(); resolve(res.statusCode);
			});
			req.on("error", reject); req.end();
		});
		assert.equal(foreignHostStatus, 403);
		assert.equal((await request("/upsert", [])).status, 400);
		assert.equal((await request("/configure", { apiKey: "fake", region: "test", collection: "pages" })).status, 200);
		const doc = { _id: "user:17/ABCDEFGH/1", library_key: "user:17", attachment_key: "ABCDEFGH",
			page: 1, page_count: 1, indexed_pages: 1, page_image_b64: "aW1hZ2U=" };
		assert.equal((await request("/upsert", { docs: [doc] })).status, 200);
		const manifest = await (await request("/manifest", { libraryKey: "user:17" })).json();
		assert.equal(manifest.rows.length, 1);
		assert.equal((await request("/delete", { libraryKey: "user:17", attachmentKeys: ["ABCDEFGH"] })).status, 200);
		const removed = await (await request("/attachment-status", { libraryKey: "user:17", attachmentKey: "ABCDEFGH" })).json();
		assert.equal(removed.exists, false);
		child.stdin.end();
		assert.equal((await exited)[0], 0);
	} finally {
		child.kill();
		await exited;
	}
});
