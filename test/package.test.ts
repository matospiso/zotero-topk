import { after as afterAll, before as beforeAll, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { version } from "../package.json";
import { BRIDGE_READY_PREFIX, type BridgeReady } from "../shared/protocol";

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
	assert.match(renderer, /from\s+["']\.\/pdfjs\/pdf\.mjs["']/);
	assert.ok(!renderer.includes('from "pdfjs-dist"'));
});

test("packaged uninstall removes declared preferences and external files", async () => {
	const declaredPrefs = new Set<string>();
	vm.runInNewContext(readFileSync(join(extracted, "prefs.js"), "utf8"), { pref: (key: string) => declaredPrefs.add(key) });
	const cleared: Array<{ key: string; global: boolean }> = [];
	const removed: Array<{ path: string; ignoreAbsent: boolean; recursive: boolean }> = [];
	const errors: string[] = [];
	const context = vm.createContext({
		ADDON_UNINSTALL: 6,
		Zotero: {
			DataDirectory: { dir: "/zotero-data" },
			Prefs: { clear: (key: string, global: boolean) => cleared.push({ key, global }) },
			debug: (message: string) => errors.push(message),
		},
		PathUtils: { join },
		IOUtils: { remove: async (path: string, options: { ignoreAbsent: boolean; recursive?: boolean }) => {
			removed.push({ path, ignoreAbsent: options.ignoreAbsent, recursive: options.recursive === true });
		} },
	});
	vm.runInContext(readFileSync(join(extracted, "bootstrap.js"), "utf8"), context);
	await context.uninstall({}, 7);
	assert.equal(cleared.length, 0);
	assert.equal(removed.length, 0);
	await context.uninstall({}, 6);
	assert.deepEqual(cleared.map(({ key }) => key).sort(), [...declaredPrefs].sort());
	assert.equal(cleared.every(({ global }) => global), true);
	assert.deepEqual(removed, [
		{ path: join("/zotero-data", "topk-index-state.json"), ignoreAbsent: true, recursive: false },
		{ path: join("/zotero-data", "topk-index-state.json.tmp"), ignoreAbsent: true, recursive: false },
		{ path: join("/zotero-data", "topk-bridge"), ignoreAbsent: true, recursive: true },
	]);
	assert.equal(errors.length, 0);
});

test("the pinned native TopK SDK loads under Node without credentials or network", () => {
	const sdk = createRequire(new URL("../bridge/package.json", import.meta.url))("topk-js");
	const client = new sdk.Client({ apiKey: "never-provisioned-test-key", region: "aws-us-east-1-elastica" });
	assert.notEqual(client.collection("compatibility-probe"), undefined);
	assert.notEqual(sdk.data.image(readFileSync("addon/content/icons/topk-48.png")), undefined);
});

test("packaged helper refuses unsupported Node versions before starting", () => {
	for (const version of ["18.20.8", "20.20.0", "22.12.0"]) {
		const preload = "data:text/javascript," + encodeURIComponent(
			`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`
		);
		const result = spawnSync(process.execPath, ["--import", preload, "server.js"], {
			cwd: join(extracted, "bridge"), encoding: "utf8", timeout: 5000,
			env: { ...process.env, TOPK_BRIDGE_TOKEN: "test-token-".repeat(4), TOPK_BRIDGE_FAKE: "1" },
		});
		assert.ifError(result.error);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Node.js 22\.13\.0 or newer is required/);
		assert.ok(result.stderr.includes(`found ${version}`));
		assert.ok(!result.stdout.includes(BRIDGE_READY_PREFIX));
	}
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
		cwd: join(extracted, "bridge"),
		env: { ...process.env, TOPK_BRIDGE_TOKEN: token, TOPK_BRIDGE_FAKE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = once(child, "exit");
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	try {
		let stdout = "";
		for await (const chunk of child.stdout) {
			stdout += chunk;
			if (stdout.includes("\n")) break;
		}
		assert.ok(stdout, `Helper exited before READY: ${stderr}`);
		assert.equal(stdout.startsWith(BRIDGE_READY_PREFIX), true);
		const ready: BridgeReady = JSON.parse(stdout.slice(BRIDGE_READY_PREFIX.length).split("\n")[0]);
		assert.equal(ready.version, version);
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
