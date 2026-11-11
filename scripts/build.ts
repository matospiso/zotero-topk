import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { root, pkg, addonDir as addonOut, xpiPath } from "./project";
import { HELPER_FILES } from "../shared/runtime";

const dev = process.argv.includes("--dev");
const xpiRequested = process.argv.includes("--xpi") || !dev;

rmSync(addonOut, { recursive: true, force: true });
mkdirSync(addonOut, { recursive: true });
cpSync(join(root, "addon"), addonOut, { recursive: true, filter: (src) => !src.endsWith(".ts") });
mkdirSync(join(addonOut, "bridge"), { recursive: true });
for (const file of HELPER_FILES) {
	if (file === "server.js") continue;
	if (file === "package.json") {
		const helperPackage = JSON.parse(readFileSync(join(root, "bridge", file), "utf8"));
		writeFileSync(join(addonOut, "bridge", file), JSON.stringify({ ...helperPackage, version: pkg.version }, null, 2) + "\n");
		continue;
	}
	cpSync(join(root, "bridge", file), join(addonOut, "bridge", file));
}
cpSync(join(root, "LICENSE"), join(addonOut, "LICENSE"));
await build({
	entryPoints: [join(root, "bridge/server.ts")], bundle: true,
	platform: "node", target: "node18", format: "esm", outfile: join(addonOut, "bridge/server.js"),
	external: ["topk-js", "topk-js/*"],
});

// The legacy pdf.js build supports Zotero's Gecko and loads from the renderer's own origin.
const pdfjs = join(root, "node_modules", "pdfjs-dist");
const pdfOut = join(addonOut, "content", "pdfjs");
mkdirSync(pdfOut, { recursive: true });
cpSync(join(pdfjs, "LICENSE"), join(pdfOut, "LICENSE"));
cpSync(join(pdfjs, "legacy", "build", "pdf.min.mjs"), join(pdfOut, "pdf.mjs"));
cpSync(join(pdfjs, "legacy", "build", "pdf.worker.min.mjs"), join(pdfOut, "pdf.worker.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(pdfjs, dir), join(pdfOut, dir), { recursive: true });

const manifestPath = join(addonOut, "manifest.json");
writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("__version__", pkg.version));

await build({
	entryPoints: [join(root, "src/index.ts")], bundle: true,
	platform: "browser", target: "firefox115", format: "iife", outfile: join(addonOut, "content/zotero-topk.js"),
	sourcemap: dev ? "inline" : false, define: { __DEV__: String(dev) },
});

// Bootstrap explicitly publishes its callbacks to Zotero's script sandbox.
for (const name of ["bootstrap", "prefs", "content/preferences"]) {
	await build({
		entryPoints: [join(root, "addon", `${name}.ts`)], bundle: true,
		platform: "browser", target: "firefox115", format: "iife", outfile: join(addonOut, `${name}.js`),
	});
}
await build({
	entryPoints: [join(root, "addon/content/renderer.ts")], bundle: true,
	platform: "browser", target: "firefox115", format: "esm", outfile: join(addonOut, "content/renderer.js"),
	plugins: [{ name: "packaged-pdfjs", setup(build) {
		build.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: "./pdfjs/pdf.mjs", external: true }));
	} }],
});

if (xpiRequested) {
	rmSync(xpiPath, { force: true });
	execFileSync("zip", ["-qr", "-X", xpiPath, "."], { cwd: addonOut, stdio: "inherit" });
	console.log("wrote", xpiPath);
}
console.log("build complete:", addonOut);
