// Headless end-to-end test: builds the plugin, runs Zotero with the fake bridge
// backend (or the real one with --real) and checks the self-test report.
//
//   ZOTERO_BIN=/path/to/zotero npx tsx scripts/e2e.ts [--real [--collection NAME] [--region R] [--host topk.dev]] [--keep] [--no-papers]
//   The API key comes from the TOPK_API_KEY environment variable or .env (never a command-line argument).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, cpSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Load KEY=value pairs from .env (TOPK_API_KEY, TOPK_REGION, TOPK_HOST, ZOTERO_BIN) without overriding the environment.
if (existsSync(join(root, ".env"))) {
	for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (m && !m[1].startsWith("#") && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
}
const args = process.argv.slice(2);
if (args.some((arg) => arg === "--apikey" || arg.startsWith("--apikey="))) {
	console.error("--apikey is no longer supported; use TOPK_API_KEY in the environment instead.");
	process.exit(2);
}
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const useXpi = flag("--xpi");
// The e2e always uses a dev build (selftest hooks are compiled out of release builds); --xpi additionally zips it.
execFileSync(process.execPath, ["--import", "tsx", join(root, "scripts", "build.ts"), "--dev", ...(useXpi ? ["--xpi"] : [])], { stdio: "inherit" });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const devDir = join(root, ".zotero-dev", "e2e");
rmSync(devDir, { recursive: true, force: true });
mkdirSync(devDir, { recursive: true });
for (const f of ["fixture.pdf", "fixture.html"]) cpSync(join(root, "test", "fixtures", f), join(devDir, f));
const report = join(devDir, "report.json");
if (!flag("--no-papers") && existsSync(join(root, "test", "papers"))) {
	mkdirSync(join(devDir, "papers"), { recursive: true });
	for (const f of readdirSync(join(root, "test", "papers"))) if (f.endsWith(".pdf")) cpSync(join(root, "test", "papers", f), join(devDir, "papers", f));
	if (existsSync(join(root, "test", "queries.json"))) cpSync(join(root, "test", "queries.json"), join(devDir, "queries.json"));
}

const runArgs = ["--import", "tsx", join(root, "scripts", "run-zotero.ts"), "--headless", "--fresh", "--dev-dir", devDir, "--selftest", report,
	"--log", join(devDir, "zotero.log")];
const childEnv = { ...process.env };
delete childEnv.TOPK_API_KEY;
if (flag("--real")) {
	const apiKey = process.env.TOPK_API_KEY;
	if (!apiKey) {
		console.error("--real needs TOPK_API_KEY in the environment or .env");
		process.exit(2);
	}
	// The key travels to the child through its environment, never through argv (visible in the process list).
	childEnv.TOPK_API_KEY = apiKey;
	if (opt("--collection")) runArgs.push("--collection", opt("--collection")!);
	const region = opt("--region") || process.env.TOPK_REGION;
	const host = opt("--host") || process.env.TOPK_HOST;
	if (region) runArgs.push("--region", region);
	if (host) runArgs.push("--host", host);
}
else {
	runArgs.push("--fake");
}
runArgs.push("--node", opt("--node") || process.execPath);
if (useXpi) runArgs.push("--xpi", join(root, "build", `zotero-topk-${pkg.version}.xpi`));
const res = spawnSync(process.execPath, runArgs, { stdio: "inherit", timeout: 15 * 60 * 1000, env: childEnv });
if (!existsSync(report)) {
	console.error("no report written; see", join(devDir, "zotero.log"));
	process.exit(1);
}
const data = JSON.parse(readFileSync(report, "utf8"));
console.log(JSON.stringify(data, null, 2));
if (!flag("--keep")) {
	// keep the log and report, drop the profile/data
	rmSync(join(devDir, "profile"), { recursive: true, force: true });
	rmSync(join(devDir, "data"), { recursive: true, force: true });
}
console.log(data.ok ? "E2E OK" : "E2E FAILED");
process.exit(data.ok ? 0 : 1);
