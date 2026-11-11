// Builds the plugin: bundles TypeScript with esbuild, copies static files and the
// bridge sources into build/addon/, and zips an installable .xpi.
import { build, transform } from "esbuild";
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
for (const f of ["package.json", "package-lock.json"]) cpSync(join(root, "bridge", f), join(addonOut, "bridge", f));

// pdf.js (pinned via package-lock.json; the legacy build, since Zotero's Gecko lacks newer JS APIs) is bundled so the content-privileged renderer page can load it same-origin.
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const pdfOut = join(addonOut, "content", "pdfjs");
mkdirSync(pdfOut, { recursive: true });
cpSync(join(pdfjs, "legacy", "build", "pdf.min.mjs"), join(pdfOut, "pdf.mjs"));
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(pdfOut, "pdf.worker.mjs"));
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(pdfjs, d), join(pdfOut, d), { recursive: true });

const manifestPath = join(addonOut, "manifest.json");
writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("__version__", pkg.version));

await build({
	entryPoints: [join(root, "src/index.ts")], bundle: true, format: "iife", platform: "browser", target: "firefox115",
	outfile: join(addonOut, "content/zotero-topk.js"), sourcemap: dev ? "inline" : false, define: { __DEV__: String(dev) },
});
// Keep bootstrap lifecycle functions in the script's global scope.
for (const name of ["bootstrap", "prefs", "content/preferences"]) {
	const { code } = await transform(readFileSync(join(root, "addon", `${name}.ts`), "utf8"), { loader: "ts", target: "firefox115" });
	writeFileSync(join(addonOut, `${name}.js`), code);
}
await build({
	entryPoints: [join(root, "addon/content/renderer.ts")], bundle: true, format: "esm", platform: "browser", target: "firefox115",
	outfile: join(addonOut, "content/renderer.js"),
	plugins: [{ name: "packaged-pdfjs", setup(build) {
		build.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: "./pdfjs/pdf.mjs", external: true }));
	} }],
});
// Only the SDK stays external; the helper's package version is inlined from JSON.
await build({
	entryPoints: [join(root, "bridge/server.ts")], bundle: true, format: "esm", platform: "node", target: "node18",
	outfile: join(addonOut, "bridge/server.js"), external: ["topk-js", "topk-js/*"],
});

if (xpiRequested) {
	const xpi = join(out, `zotero-topk-${pkg.version}.xpi`);
	rmSync(xpi, { force: true });
	execFileSync("zip", ["-qr", "-X", xpi, "."], { cwd: addonOut, stdio: "inherit" });
	console.log("wrote", xpi);
}
console.log("build complete:", addonOut, existsSync(join(addonOut, "content", "zotero-topk.js")) ? "(bundle ok)" : "(bundle missing!)");
