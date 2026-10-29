// Launches Zotero with a throwaway profile that loads the plugin from build/addon.
//
//   node scripts/run-zotero.mjs [--headless] [--fake] [--selftest out.json] [--data DIR] [--profile DIR]
//
// Set ZOTERO_BIN to your Zotero executable (Linux: .../zotero, macOS: Zotero.app/Contents/MacOS/zotero).
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const zoteroBin = process.env.ZOTERO_BIN || opt("--zotero");
if (!zoteroBin || !existsSync(zoteroBin)) {
	console.error("Set ZOTERO_BIN (or --zotero) to the Zotero executable");
	process.exit(2);
}
const devDir = resolve(opt("--dev-dir", join(root, ".zotero-dev")));
const profile = resolve(opt("--profile", join(devDir, "profile")));
const data = resolve(opt("--data", join(devDir, "data")));
const fresh = flag("--fresh");
// user.js below disables add-on signing and enables the remote debugger: never write that into a real profile.
for (const [name, dir] of [["--profile", profile], ["--data", data]]) {
	if (!dir.startsWith(devDir + "/") && !flag("--allow-external-dirs")) {
		console.error(`${name} ${dir} is outside the dev directory ${devDir}; pass --allow-external-dirs if you really mean it`);
		process.exit(2);
	}
}
if (fresh) {
	rmSync(profile, { recursive: true, force: true });
	rmSync(data, { recursive: true, force: true });
}
mkdirSync(join(profile, "extensions"), { recursive: true, mode: 0o700 });
mkdirSync(data, { recursive: true, mode: 0o700 });
try { (await import("node:fs")).chmodSync(profile, 0o700); } catch (e) {}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const extDir = join(profile, "extensions");
rmSync(join(extDir, pkg.config.addonID), { force: true });
rmSync(join(extDir, pkg.config.addonID + ".xpi"), { force: true });
if (opt("--xpi")) {
	// Install the packaged xpi (exercises the jar: code paths).
	cpSync(resolve(opt("--xpi")), join(extDir, pkg.config.addonID + ".xpi"));
}
else {
	// Proxy file: tells the add-on manager to load the plugin from the build directory.
	writeFileSync(join(extDir, pkg.config.addonID), join(root, "build", "addon") + "/");
}
// Force the add-on manager to rescan.
const prefsFile = join(profile, "prefs.js");
if (existsSync(prefsFile)) {
	writeFileSync(prefsFile, readFileSync(prefsFile, "utf8").split("\n")
		.filter((l) => !/extensions\.lastAppBuildId|extensions\.lastAppVersion/.test(l)).join("\n"));
}
const prefs = {
	"extensions.zotero.firstRun2": false,
	"extensions.zotero.firstRunGuidance": false,
	"extensions.zotero.dataDir": data,
	"extensions.zotero.useDataDir": true,
	"extensions.zotero.debug.log": true,
	"extensions.zotero.automaticScraperUpdates": false,
	"extensions.zotero.sync.autoSync": false,
	"extensions.zotero.sync.server.compressData": false,
	"extensions.zotero-topk.debug": true,
	"app.update.enabled": false,
	"browser.dom.window.dump.enabled": true,
	"devtools.debugger.remote-enabled": true,
	"devtools.debugger.prompt-connection": false,
	"xpinstall.signatures.required": false,
	"extensions.autoDisableScopes": 0,
	"extensions.enabledScopes": 15,
};
if (flag("--fake")) prefs["extensions.zotero-topk.bridgeFake"] = true;
if (opt("--selftest")) prefs["extensions.zotero-topk.selftest"] = resolve(opt("--selftest"));
const apiKey = process.env.TOPK_API_KEY || opt("--apikey");
if (apiKey) prefs["extensions.zotero-topk.apiKey"] = apiKey;
if (opt("--collection")) prefs["extensions.zotero-topk.collection"] = opt("--collection");
if (opt("--region")) prefs["extensions.zotero-topk.region"] = opt("--region");
if (opt("--host")) prefs["extensions.zotero-topk.host"] = opt("--host");
if (opt("--node")) prefs["extensions.zotero-topk.nodePath"] = opt("--node");
writeFileSync(join(profile, "user.js"),
	Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n",
	{ mode: 0o600 });

const env = { ...process.env };
delete env.TOPK_API_KEY; // Zotero reads it from user.js; keep it out of the Zotero process environment
if (flag("--headless")) env.MOZ_HEADLESS = "1";
const zArgs = ["-profile", profile, "-no-remote", "-purgecaches"];
if (flag("--debug") || flag("--headless")) zArgs.push("-ZoteroDebugText");
if (flag("--jsconsole")) zArgs.push("-jsconsole");
console.log(`launching ${zoteroBin} ${zArgs.join(" ")}`);
const child = spawn(zoteroBin, zArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
const logPath = opt("--log", join(devDir, "zotero.log"));
const logStream = (await import("node:fs")).createWriteStream(logPath);
for (const s of [child.stdout, child.stderr]) {
	s.on("data", (d) => {
		logStream.write(d);
		if (flag("--verbose")) process.stdout.write(d);
	});
}
child.on("exit", (code) => {
	logStream.end();
	console.log(`zotero exited with ${code}; log at ${logPath}`);
	process.exit(code ?? 0);
});
