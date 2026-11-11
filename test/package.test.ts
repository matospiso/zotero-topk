import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { TopKBackend } from "../bridge/server";
import { version } from "../package.json";

let extracted: string;
beforeAll(() => {
	execFileSync(process.execPath, ["scripts/build.ts"], { stdio: "pipe" });
	extracted = mkdtempSync(join(tmpdir(), "topk-bun-package-"));
	execFileSync("unzip", ["-q", `build/zotero-topk-${version}.xpi`, "-d", extracted]);
});
afterAll(() => { if (extracted) rmSync(extracted, { recursive: true, force: true }); });

test("XPI exposes Zotero lifecycle callbacks and compiled default preferences", () => {
	const context = vm.createContext({});
	vm.runInContext(readFileSync(join(extracted, "bootstrap.js"), "utf8"), context);
	for (const name of ["install", "uninstall", "startup", "shutdown", "onMainWindowLoad", "onMainWindowUnload"]) {
		expect(typeof context[name]).toBe("function");
	}
	const prefs = new Map<string, unknown>();
	vm.runInNewContext(readFileSync(join(extracted, "prefs.js"), "utf8"), { pref: (key: string, value: unknown) => prefs.set(key, value) });
	expect(prefs.get("extensions.zotero-topk.bunPath")).toBe("");
	expect(prefs.get("extensions.zotero-topk.uploadConcurrency")).toBe(4);
	expect(prefs.has("extensions.zotero-topk.nodePath")).toBe(false);
	const renderer = readFileSync(join(extracted, "content/renderer.js"), "utf8");
	expect(renderer).toContain('"./pdfjs/pdf.mjs"');
	expect(renderer).not.toContain('from "pdfjs-dist"');
});

test("the pinned native TopK SDK loads under Bun without credentials or network", () => {
	const backend = new TopKBackend();
	const sdk = backend._sdk();
	const client = new sdk.Client({ apiKey: "never-provisioned-test-key", region: "aws-us-east-1-elastica" });
	expect(client.collection("compatibility-probe")).toBeDefined();
	expect(sdk.data.image(readFileSync("addon/content/icons/topk-48.png"))).toBeDefined();
	expect(backend._schema().page_image).toBeDefined();
});

test("production plugin bundle loads as a classic Gecko script and ignores the fake preference", async () => {
	const context = vm.createContext({ rootURI: "resource://zotero-topk/", pluginVersion: version,
		ChromeUtils: { importESModule: () => ({}) },
		Zotero: { Prefs: { get: (key: string) => key.endsWith("bridgeFake") ? true : "" } },
	});
	vm.runInContext(readFileSync(join(extracted, "content/zotero-topk.js"), "utf8"), context);
	expect(context.Zotero.TopK.version).toBe(version);
	expect(context.Zotero.TopK.rootURI).toBe("resource://zotero-topk/");
	context.Zotero.TopK.bridge.ensureRunning = async () => {};
	await expect(context.Zotero.TopK.bridge.ensureReady()).rejects.toThrow("No TopK API key");
});

test("packaged Bun helper serves authenticated requests and exits when its parent pipe closes", async () => {
	const token = "test-session-token-".repeat(3);
	// Bun's automatic .env loading must not override the launcher's controlled environment.
	writeFileSync(join(extracted, "bridge/.env"), "TOPK_BRIDGE_TOKEN=wrong\nTOPK_BRIDGE_FAKE=0\n");
	const child = Bun.spawn([process.execPath, "--no-env-file", "server.ts"], {
		cwd: join(extracted, "bridge"),
		env: { PATH: process.env.PATH, TOPK_BRIDGE_TOKEN: token, TOPK_BRIDGE_FAKE: "1" },
		stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
	try {
		const reader = child.stdout.getReader();
		let stdout = "";
		while (!stdout.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Helper exited before READY: ${await new Response(child.stderr).text()}`);
			stdout += new TextDecoder().decode(value);
		}
		reader.releaseLock();
		const ready = JSON.parse(stdout.match(/TOPK_BRIDGE_READY (.+)\n/)![1]);
		expect(ready.fake).toBe(true);
		const base = `http://127.0.0.1:${ready.port}`;
		const request = (route: string, body?: unknown, headers = {}) => fetch(base + route, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		expect((await fetch(base + "/health")).status).toBe(401);
		expect((await request("/health", undefined, { Host: "foreign.example" })).status).toBe(403);
		expect((await request("/upsert", [])).status).toBe(400);
		expect((await request("/configure", { apiKey: "fake", region: "test", collection: "pages" })).status).toBe(200);
		const doc = { _id: "user:17/ABCDEFGH/1", library_key: "user:17", attachment_key: "ABCDEFGH",
			page: 1, page_count: 1, indexed_pages: 1, page_image_b64: "aW1hZ2U=" };
		expect((await request("/upsert", { docs: [doc] })).status).toBe(200);
		const manifest = await (await request("/manifest", { libraryKey: "user:17" })).json();
		expect(manifest.rows).toHaveLength(1);
		expect((await request("/delete", { libraryKey: "user:17", attachmentKeys: ["ABCDEFGH"] })).status).toBe(200);
		const removed = await (await request("/attachment-status", { libraryKey: "user:17", attachmentKey: "ABCDEFGH" })).json();
		expect(removed.exists).toBe(false);
		child.stdin.end();
		expect(await child.exited).toBe(0);
	} finally {
		child.kill();
		await child.exited;
	}
}, 10000);
