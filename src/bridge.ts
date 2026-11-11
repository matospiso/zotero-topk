import { getPref, delay } from "./prefs";
import { libraryKey, localLibraryID } from "./library";
import { log, logError, errorMessage, debug } from "./log";

import type { SearchHit, PageDoc, ManifestRow } from "../shared/protocol";
export type { SearchHit, PageDoc, ManifestRow } from "../shared/protocol";

export function destination() {
	return {
		apiKey: getPref<string>("apiKey", ""),
		region: getPref<string>("region", ""),
		collection: getPref<string>("collection", ""),
		host: getPref<string>("host", "").trim() || "topk.io",
		fake: __DEV__ && getPref<boolean>("bridgeFake", false),
	};
}

function configKey({ apiKey, region, collection, host }: ReturnType<typeof destination>) {
	return JSON.stringify([apiKey, region, collection, host]);
}

/** Credential fingerprint only: never persist the API key in index state. */
export function destinationKey() {
	return Zotero.Utilities.Internal.md5(JSON.stringify(destination()));
}

export class BridgeError extends Error {
	constructor(message: string, public status?: number) {
		super(message);
	}
}

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

// Region and host are interpolated into https://<region>.api.<host>; accept hostname syntax only.
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;
// Environment variables the helper legitimately needs (everything else from Zotero's environment is withheld).
const CHILD_ENV_ALLOWLIST = [
	"PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
	"SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

/** Cryptographically random token (hex) for the loopback channel. */
function randomToken(bytes = 32): string {
	const gen = Components.classes["@mozilla.org/security/random-generator;1"]
		.getService(Components.interfaces.nsIRandomGenerator);
	const buf: number[] = Array.from(gen.generateRandomBytes(bytes));
	return buf.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function childEnvironment(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of CHILD_ENV_ALLOWLIST) {
		const v = Services.env.get(name);
		if (v) env[name] = v;
	}
	return { ...env, ...extra };
}

/**
 * Schedules helper requests so the client never idles while TopK has capacity: ordinary requests
 * (uploads, reads, deletions) run concurrently, while reconfiguration runs alone, after every
 * request already in flight has finished and before any later one starts. A preference change
 * therefore cannot redirect an in-flight operation (including a backend retry) to another target.
 * Ordering between uploads and deletions of the same attachment is the indexer's job on this side
 * and the helper's on the other.
 */
class OperationLock {
	private exclusive: Promise<void> = Promise.resolve();
	private pendingExclusive = 0;
	private shared = new Set<Promise<void>>();

	async runShared<T>(fn: () => Promise<T>): Promise<T> {
		while (this.pendingExclusive > 0) await this.exclusive;
		const result = fn();
		const settled = result.then(() => {}, () => {});
		this.shared.add(settled);
		try { return await result; }
		finally { this.shared.delete(settled); }
	}

	runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		this.pendingExclusive++;
		const result = this.exclusive.then(async () => {
			while (this.shared.size) await Promise.all(this.shared);
			return fn();
		});
		this.exclusive = result.then(() => {}, () => {}).then(() => { this.pendingExclusive--; });
		return result;
	}
}

const DESTINATION_CHANGED = Symbol("destination changed");

/**
 * Manages the local Node.js helper that hosts the TopK JavaScript SDK and
 * exposes a tiny JSON API on 127.0.0.1.
 */
export class Bridge {
	private proc: any = null;
	private port = 0;
	private token = "";
	private startPromise: Promise<void> | null = null;
	private configured = false;
	private configKey = "";
	private lock = new OperationLock();
	private nodePath = "";
	private bridgeDir = "";
	public lastError = "";
	public info: { version?: string; fake?: boolean } = {};

	constructor(private rootURI: string, private pluginVersion: string) {}

	get running() {
		return !!this.proc && this.port > 0;
	}

	get isConfigured() {
		return this.running && this.configured;
	}

	// ----------------------------------------------------------------------
	// Lifecycle
	// ----------------------------------------------------------------------

	async ensureRunning(): Promise<void> {
		if (this.running) return;
		if (!this.startPromise) {
			this.startPromise = this.start().finally(() => { this.startPromise = null; });
		}
		return this.startPromise;
	}

	/** Make sure the helper runs and is configured with the current preferences. */
	async ensureReady(): Promise<void> {
		await this.operation();
	}

	private async configure(config: ReturnType<typeof destination>): Promise<void> {
		await this.ensureRunning();
		const { apiKey, region, collection, host, fake } = config;
		if (!fake && !apiKey) {
			throw new BridgeError("No TopK API key set. Open Settings → TopK Semantic Search and paste your API key.");
		}
		if (!HOST_LABEL.test(region)) throw new BridgeError(`Invalid TopK region “${region}”: use a region name such as aws-us-east-1-elastica.`);
		if (host && !HOST_NAME.test(host)) throw new BridgeError(`Invalid TopK host “${host}”: use a hostname such as topk.io.`);
		if (!COLLECTION_NAME.test(collection)) throw new BridgeError("Invalid collection name: use letters, digits, “-” and “_” only.");
		const key = configKey(config);
		if (this.configuredFor(key)) return;
		const res = await this.request("POST", "/configure", { apiKey, region, collection, host: host || undefined });
		this.configured = true;
		this.configKey = key;
		log(`bridge configured: collection=${res.collection} region=${res.region}${host ? ` host=${host}` : ""}${res.created ? " (created)" : ""}`);
	}

	private async start(): Promise<void> {
		this.lastError = "";
		try {
			this.nodePath = await this.findNode();
			this.bridgeDir = await this.prepareBridgeDir();
			await this.installDependencies();
			await this.spawn();
		}
		catch (e) {
			this.lastError = errorMessage(e);
			throw e;
		}
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		this.proc = null;
		this.port = 0;
		this.configured = false;
		if (!proc) return;
		try {
			await Promise.race([proc.kill(1500), delay(2500)]);
		}
		catch (e) {
			// already gone
		}
	}

	/** Synchronous best-effort kill for application shutdown. */
	killSync() {
		const proc = this.proc;
		this.proc = null;
		this.port = 0;
		try { proc?.kill(0); } catch (e) {}
	}

	async restart() {
		await this.stop();
		await this.ensureRunning();
	}

	// ----------------------------------------------------------------------
	// Node / dependency management
	// ----------------------------------------------------------------------

	private async fileExists(path: string): Promise<boolean> {
		try {
			return await IOUtils.exists(path);
		}
		catch (e) {
			return false;
		}
	}

	private async listDir(path: string): Promise<string[]> {
		try {
			return await IOUtils.getChildren(path);
		}
		catch (e) {
			return [];
		}
	}

	private async nodeVersion(path: string): Promise<string | null> {
		try {
			const proc = await Subprocess.call({ command: path, arguments: ["--version"], stderr: "stdout" });
			let out = "";
			let chunk: string;
			while ((chunk = await proc.stdout.readString())) out += chunk;
			const { exitCode } = await proc.wait();
			const m = out.match(/v(\d+)\.(\d+)\.(\d+)/);
			if (exitCode !== 0 || !m) return null;
			if (parseInt(m[1], 10) < 18) return null;
			return m[0];
		}
		catch (e) {
			return null;
		}
	}

	private async candidateNodePaths(): Promise<string[]> {
		const out: string[] = [];
		const configured = getPref<string>("nodePath", "").trim();
		if (configured) out.push(configured);
		try {
			const found = await Subprocess.pathSearch(Zotero.isWin ? "node.exe" : "node");
			if (found) out.push(found);
		}
		catch (e) {}
		const home = Zotero.isWin
			? (Services.env.get("USERPROFILE") || "")
			: (Services.env.get("HOME") || "");
		const versionDirs = async (base: string, suffix: string[]) => {
			const children = await this.listDir(base);
			// Highest version first
			children.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			for (const c of children) out.push(PathUtils.join(c, ...suffix));
		};
		if (Zotero.isWin) {
			const pf = Services.env.get("ProgramFiles") || "C:\\Program Files";
			const local = Services.env.get("LOCALAPPDATA") || "";
			out.push(PathUtils.join(pf, "nodejs", "node.exe"));
			if (local) out.push(PathUtils.join(local, "Programs", "nodejs", "node.exe"));
			if (home) {
				await versionDirs(PathUtils.join(home, "AppData", "Roaming", "nvm"), ["node.exe"]);
				await versionDirs(PathUtils.join(home, "AppData", "Roaming", "fnm", "node-versions"), ["installation", "node.exe"]);
			}
		}
		else {
			if (home) {
				await versionDirs(PathUtils.join(home, ".nvm", "versions", "node"), ["bin", "node"]);
				await versionDirs(PathUtils.join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin", "node"]);
				await versionDirs(PathUtils.join(home, "Library", "Application Support", "fnm", "node-versions"), ["installation", "bin", "node"]);
				out.push(PathUtils.join(home, ".volta", "bin", "node"));
				out.push(PathUtils.join(home, ".local", "bin", "node"));
			}
			out.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node", "/opt/local/bin/node");
			await versionDirs("/usr/local/n/versions/node", ["bin", "node"]);
		}
		return out;
	}

	async findNode(): Promise<string> {
		for (const candidate of await this.candidateNodePaths()) {
			if (!(await this.fileExists(candidate))) continue;
			const v = await this.nodeVersion(candidate);
			if (v) {
				log(`using Node.js ${v} at ${candidate}`);
				return candidate;
			}
		}
		throw new BridgeError(
			"Node.js 18 or newer was not found. Install it from https://nodejs.org and/or set the path in "
			+ "Settings → TopK Semantic Search."
		);
	}

	private async resolveSymlink(path: string): Promise<string> {
		try {
			const file = Zotero.File.pathToFile(path);
			if (file.isSymlink()) return file.target;
		}
		catch (e) {}
		return path;
	}

	/** Locate npm-cli.js next to the node binary (works without a login shell PATH). */
	private async findNpmCli(nodePath: string): Promise<string | null> {
		const real = await this.resolveSymlink(nodePath);
		const dir = PathUtils.parent(real);
		const candidates = [
			PathUtils.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
			PathUtils.join(PathUtils.parent(dir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		];
		for (const c of candidates) {
			if (await this.fileExists(c)) return c;
		}
		return null;
	}

	private async prepareBridgeDir(): Promise<string> {
		const dir = PathUtils.join(Zotero.DataDirectory.dir, "topk-bridge");
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		for (const name of ["server.js", "package.json", "package-lock.json"]) {
			// getResourceAsync goes through an nsIChannel, so it also works for jar: URLs (installed xpi).
			const src = await Zotero.File.getResourceAsync(`${this.rootURI}bridge/${name}`);
			await IOUtils.writeUTF8(PathUtils.join(dir, name), src);
		}
		return dir;
	}

	private async installDependencies(): Promise<void> {
		const dir = this.bridgeDir;
		const stamp = PathUtils.join(dir, ".installed");
		const pkgJson = JSON.parse(await IOUtils.readUTF8(PathUtils.join(dir, "package.json")));
		const want = `${this.pluginVersion}:${pkgJson.dependencies["topk-js"]}:ci`;
		const haveModule = await this.fileExists(PathUtils.join(dir, "node_modules", "topk-js", "package.json"));
		let have = "";
		try { have = (await IOUtils.readUTF8(stamp)).trim(); } catch (e) {}
		if (haveModule && have === want) return;

		const npmCli = await this.findNpmCli(this.nodePath);
		let command = this.nodePath;
		let args: string[];
		if (npmCli) {
			args = [npmCli];
		}
		else {
			const npm = await Subprocess.pathSearch(Zotero.isWin ? "npm.cmd" : "npm").catch(() => null);
			if (!npm) throw new BridgeError("npm was not found next to Node.js; install Node.js from https://nodejs.org");
			command = npm;
			args = [];
		}
		// `ci` installs exactly what the shipped lockfile pins (with integrity checks) and fails on any drift;
		// the SDK ships prebuilt binaries as optional platform packages, so lifecycle scripts are not needed.
		args.push("ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error");

		log(`installing bridge dependencies in ${dir}`);
		const pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("TopK Semantic Search");
		pw.addDescription("Installing the TopK SDK for the local helper (one-time, needs network)…");
		pw.show();
		try {
			const proc = await Subprocess.call({
				command, arguments: args, workdir: dir, stderr: "stdout",
				environment: childEnvironment({}), environmentAppend: false,
			});
			let out = "";
			let chunk: string;
			while ((chunk = await proc.stdout.readString())) out += chunk;
			const { exitCode } = await proc.wait();
			if (exitCode !== 0) {
				throw new BridgeError(`npm install failed (exit ${exitCode}):\n${out.slice(-2000)}`);
			}
			await IOUtils.writeUTF8(stamp, want);
			log("bridge dependencies installed");
		}
		finally {
			pw.startCloseTimer(1500);
		}
	}

	// ----------------------------------------------------------------------
	// Process
	// ----------------------------------------------------------------------

	private async spawn(): Promise<void> {
		this.token = randomToken(32);
		const fake = __DEV__ && getPref<boolean>("bridgeFake", false);
		const extra: Record<string, string> = { TOPK_BRIDGE_TOKEN: this.token };
		if (fake) extra.TOPK_BRIDGE_FAKE = "1";
		const proc = await Subprocess.call({
			command: this.nodePath,
			arguments: [PathUtils.join(this.bridgeDir, "server.js")],
			workdir: this.bridgeDir,
			environment: childEnvironment(extra),
			environmentAppend: false,
			stderr: "pipe",
		});
		this.proc = proc;
		this.configured = false;

		// Forward stderr to the Zotero debug log.
		(async () => {
			try {
				let chunk: string;
				while ((chunk = await proc.stderr.readString())) {
					for (const line of chunk.split("\n")) if (line.trim()) debug(`bridge: ${line}`);
				}
			}
			catch (e) {}
		})();

		// Wait for the ready line on stdout.
		const ready = (async () => {
			let buf = "";
			let chunk: string;
			while ((chunk = await proc.stdout.readString())) {
				buf = (buf + chunk).slice(-16384);
				const m = buf.match(/TOPK_BRIDGE_READY (\{[^\n]*\})/);
				if (m) {
					const info = JSON.parse(m[1]);
					if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) throw new BridgeError("bridge reported an invalid port");
					return info;
				}
			}
			throw new BridgeError("bridge exited before becoming ready");
		})();
		const timeout = delay(30000).then(() => { throw new BridgeError("timed out waiting for the bridge to start"); });
		let info: any;
		try {
			info = await Promise.race([ready, timeout]);
		}
		catch (e) {
			try { proc.kill(0); } catch (e2) {}
			if (this.proc === proc) this.proc = null;
			throw e;
		}
		this.port = info.port;
		this.info = { version: info.version, fake: !!info.fake };
		log(`bridge ready on 127.0.0.1:${this.port} (v${info.version}${info.fake ? ", fake" : ""})`);

		// Keep draining stdout so the pipe can never fill up; note unexpected exits.
		(async () => {
			try { while (await proc.stdout.readString()) { /* discard */ } } catch (e) {}
		})();
		proc.wait().then(({ exitCode }: { exitCode: number }) => {
			if (this.proc === proc) {
				log(`bridge exited with code ${exitCode}`);
				this.proc = null;
				this.port = 0;
				this.configured = false;
			}
		}).catch(() => {});
	}

	// ----------------------------------------------------------------------
	// HTTP
	// ----------------------------------------------------------------------

	async request(method: "GET" | "POST", path: string, body?: unknown, timeout = 120000): Promise<any> {
		if (!this.running) throw new BridgeError("bridge is not running");
		const url = `http://127.0.0.1:${this.port}${path}`;
		try {
			const xhr = await Zotero.HTTP.request(method, url, {
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					"Authorization": `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				responseType: "json",
				timeout,
				logBodyLength: 0,
				errorDelayIntervals: [],
				noCache: true,
			});
			return xhr.response;
		}
		catch (e: any) {
			const status = e?.status ?? e?.xmlhttp?.status;
			const resp = e?.xmlhttp?.response;
			const msg = (resp && typeof resp === "object" && resp.error) ? resp.error : errorMessage(e);
			if (path === "/configure" || status === 409) this.configured = false;
			throw new BridgeError(msg, status);
		}
	}

	private configuredFor(key: string) {
		return this.configured && this.configKey === key;
	}

	// The destination is fixed when the operation is issued. Configuring the helper for it runs
	// exclusively; the request itself then runs alongside other requests, and is retried from the
	// start if another caller moved the helper to a different destination in between.
	private async operation(path?: string, body?: unknown, timeout = 120000): Promise<any> {
		const config = destination();
		const key = configKey(config);
		if (!path) {
			if (this.configuredFor(key)) return;
			return this.lock.runExclusive(() => this.configure(config));
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			if (!this.configuredFor(key)) await this.lock.runExclusive(() => this.configure(config));
			const result = await this.lock.runShared(async () => {
				if (!this.configuredFor(key)) return DESTINATION_CHANGED;
				return this.request(path === "/status" ? "GET" : "POST", path, body, timeout);
			});
			if (result !== DESTINATION_CHANGED) return result;
		}
		throw new BridgeError("The TopK destination changed while the request was waiting");
	}

	async status() { return this.operation("/status"); }

	async upsert(docs: PageDoc[]): Promise<{ lsn: string }> {
		return this.operation("/upsert", { docs }, 300000);
	}

	async search(query: string, opts: { limit?: number; libraryIDs?: number[] } = {}): Promise<SearchHit[]> {
		const ids = opts.libraryIDs?.length ? opts.libraryIDs : Zotero.Libraries.getAll()
			.filter((l: any) => l.libraryType !== "feed").map((l: any) => l.libraryID);
		const res = await this.operation("/search", { query, limit: opts.limit ?? 50, libraryKeys: ids.map(libraryKey) }, 60000);
		return res.hits.flatMap((hit: SearchHit) => {
			const id = localLibraryID(hit.library_key);
			return id === undefined ? [] : [{ ...hit, library_id: id }];
		});
	}

	async images(ids: string[]): Promise<Record<string, { format: string; b64: string }>> {
		return (await this.operation("/images", { ids }, 60000)).images;
	}

	async deleteAttachments(library: number | string, attachmentKeys: string[]): Promise<void> {
		if (!attachmentKeys.length) return;
		await this.operation("/delete", { libraryKey: typeof library === "string" ? library : libraryKey(library), attachmentKeys }, 300000);
	}

	async deleteLibrary(library: number | string): Promise<void> {
		await this.operation("/delete-library", { libraryKey: typeof library === "string" ? library : libraryKey(library) }, 300000);
	}

	async manifest(libraryID: number): Promise<{ rows: ManifestRow[]; complete: boolean }> {
		return this.operation("/manifest", { libraryKey: libraryKey(libraryID) }, 300000);
	}

	async hasAttachment(libraryID: number, attachmentKey: string): Promise<boolean> {
		return (await this.operation("/attachment-status", { libraryKey: libraryKey(libraryID), attachmentKey }, 300000)).exists;
	}

	async testConnection(): Promise<any> {
		try {
			await this.ensureRunning();
			// Force a (re)configure so a changed key/collection is picked up.
			this.configured = false;
			await this.ensureReady();
			const status = await this.status();
			return { ...status, fake: this.info.fake };
		}
		catch (e) {
			logError("testConnection", e);
			throw e;
		}
	}
}
