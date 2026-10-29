import { getPref, delay } from "./prefs";
import { log, logError, errorMessage, debug } from "./log";

export interface SearchHit {
	_id: string;
	library_id: number;
	attachment_key: string;
	item_key: string;
	page: number;
	page_count: number;
	title: string;
	score: number;
}

export interface PageDoc {
	_id: string;
	library_id: number;
	attachment_key: string;
	item_key: string;
	page: number;
	page_count: number;
	title: string;
	file_hash: string;
	page_image_b64: string;
}

export interface ManifestRow {
	attachment_key: string;
	library_id: number;
	file_hash: string;
	page_count: number;
}

export class BridgeError extends Error {
	constructor(message: string, public status?: number) {
		super(message);
	}
}

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

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
		await this.ensureRunning();
		const apiKey = getPref<string>("apiKey", "");
		const region = getPref<string>("region", "");
		const collection = getPref<string>("collection", "");
		const host = getPref<string>("host", "").trim();
		const fake = getPref<boolean>("bridgeFake", false);
		if (!fake && !apiKey) {
			throw new BridgeError("No TopK API key set. Open Settings → TopK Semantic Search and paste your API key.");
		}
		const key = JSON.stringify([apiKey, region, collection, host]);
		if (this.configured && this.configKey === key) return;
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
		for (const name of ["server.js", "package.json"]) {
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
		const want = `${this.pluginVersion}:${pkgJson.dependencies["topk-js"]}`;
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
		args.push("install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error");

		log(`installing bridge dependencies in ${dir}`);
		const pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline("TopK Semantic Search");
		pw.addDescription("Installing the TopK SDK for the local helper (one-time, needs network)…");
		pw.show();
		try {
			const proc = await Subprocess.call({ command, arguments: args, workdir: dir, stderr: "stdout" });
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
		this.token = Zotero.Utilities.randomString(40);
		const fake = getPref<boolean>("bridgeFake", false);
		const environment: Record<string, string> = { TOPK_BRIDGE_TOKEN: this.token };
		if (fake) environment.TOPK_BRIDGE_FAKE = "1";
		const proc = await Subprocess.call({
			command: this.nodePath,
			arguments: [PathUtils.join(this.bridgeDir, "server.js")],
			workdir: this.bridgeDir,
			environment,
			environmentAppend: true,
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
				buf += chunk;
				const m = buf.match(/TOPK_BRIDGE_READY (\{.*\})/);
				if (m) return JSON.parse(m[1]);
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

		// Keep draining stdout; note unexpected exits.
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

	async status() {
		await this.ensureReady();
		return this.request("GET", "/status");
	}

	async upsert(docs: PageDoc[]): Promise<{ lsn: string }> {
		await this.ensureReady();
		return this.request("POST", "/upsert", { docs }, 300000);
	}

	async search(query: string, opts: { limit?: number; libraryIDs?: number[] } = {}): Promise<SearchHit[]> {
		await this.ensureReady();
		const res = await this.request("POST", "/search", { query, limit: opts.limit ?? 50, libraryIDs: opts.libraryIDs }, 60000);
		return res.hits as SearchHit[];
	}

	async images(ids: string[]): Promise<Record<string, { format: string; b64: string }>> {
		await this.ensureReady();
		const res = await this.request("POST", "/images", { ids }, 60000);
		return res.images;
	}

	async deleteAttachments(libraryID: number, attachmentKeys: string[]): Promise<void> {
		if (!attachmentKeys.length) return;
		await this.ensureReady();
		await this.request("POST", "/delete", { libraryID, attachmentKeys });
	}

	async manifest(libraryID: number): Promise<{ rows: ManifestRow[]; complete: boolean }> {
		await this.ensureReady();
		return this.request("POST", "/manifest", { libraryID }, 300000);
	}

	async testConnection(): Promise<any> {
		try {
			await this.ensureRunning();
			// Force a (re)configure so a changed key/collection is picked up.
			this.configured = false;
			await this.ensureReady();
			const status = await this.request("GET", "/status");
			return { ...status, fake: this.info.fake };
		}
		catch (e) {
			logError("testConnection", e);
			throw e;
		}
	}
}
