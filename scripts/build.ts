// Builds the plugin: bundles TypeScript with Bun, copies static files and the
// bridge sources into build/addon/, and zips an installable .xpi.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const xpiRequested = process.argv.includes("--xpi") || !dev;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build");
const addonOut = join(out, "addon");

rmSync(addonOut, { recursive: true, force: true });
mkdirSync(addonOut, { recursive: true });
cpSync(join(root, "addon"), addonOut, { recursive: true, filter: (src) => !src.endsWith(".ts") });
mkdirSync(join(addonOut, "bridge"), { recursive: true });
for (const f of ["server.ts", "package.json", "bun.lock"]) cpSync(join(root, "bridge", f), join(addonOut, "bridge", f));

// pdf.js (pinned via bun.lock; the legacy build, since Zotero's Gecko lacks newer JS APIs) is bundled so the content-privileged renderer page can load it same-origin.
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const pdfOut = join(addonOut, "content", "pdfjs");
mkdirSync(pdfOut, { recursive: true });
cpSync(join(pdfjs, "legacy", "build", "pdf.min.mjs"), join(pdfOut, "pdf.mjs"));
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(pdfOut, "pdf.worker.mjs"));
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(pdfjs, d), join(pdfOut, d), { recursive: true });

const manifestPath = join(addonOut, "manifest.json");
writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("__version__", pkg.version));

const result = await Bun.build({
	entrypoints: [join(root, "src", "index.ts")],
	format: "iife",
	target: "browser",
	outdir: join(addonOut, "content"),
	naming: "zotero-topk.js",
	sourcemap: dev ? "inline" : "none",
	minify: false,
	define: { __DEV__: String(dev) },
});
if (!result.success) throw new AggregateError(result.logs, "Plugin bundle failed");

// Bootstrap callbacks and pref() calls must remain in the script's global scope.
// Bundling them into an IIFE would hide the lifecycle functions from Zotero.
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
for (const name of ["bootstrap", "prefs", "content/preferences"]) {
	writeFileSync(join(addonOut, `${name}.js`), transpiler.transformSync(readFileSync(join(root, "addon", `${name}.ts`), "utf8")));
}
const renderer = await Bun.build({
	entrypoints: [join(root, "addon/content/renderer.ts")],
	target: "browser", format: "esm", outdir: join(addonOut, "content"),
	plugins: [{ name: "packaged-pdfjs", setup(build) {
		build.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: "./pdfjs/pdf.mjs", external: true }));
	} }],
});
if (!renderer.success) throw new AggregateError(renderer.logs, "Renderer bundle failed");

if (xpiRequested) {
	const xpi = join(out, `zotero-topk-${pkg.version}.xpi`);
	rmSync(xpi, { force: true });
	execFileSync("zip", ["-qr", "-X", xpi, "."], { cwd: addonOut, stdio: "inherit" });
	console.log("wrote", xpi);
}
console.log("build complete:", addonOut, existsSync(join(addonOut, "content", "zotero-topk.js")) ? "(bundle ok)" : "(bundle missing!)");
