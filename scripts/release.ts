import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, pkg, manifest, xpiName, xpiPath } from "./project";

const repo = process.env.TOPK_PLUGIN_REPO || "matospiso/zotero-topk";

execFileSync(process.execPath, ["--import", "tsx", join(root, "scripts", "build.ts")], { stdio: "inherit" });
const xpi = readFileSync(xpiPath);
const sha256 = createHash("sha256").update(xpi).digest("hex");

const update = {
	addons: {
		[manifest.applications.zotero.id]: {
			updates: [
				{
					version: pkg.version,
					update_link: `https://github.com/${repo}/releases/download/v${pkg.version}/${xpiName}`,
					update_hash: `sha256:${sha256}`,
					applications: {
						zotero: {
							strict_min_version: manifest.applications.zotero.strict_min_version,
							strict_max_version: manifest.applications.zotero.strict_max_version,
						},
					},
				},
			],
		},
	},
};
writeFileSync(join(root, "update.json"), JSON.stringify(update, null, 2) + "\n");
console.log(`wrote update.json for v${pkg.version} (sha256 ${sha256})`);
console.log(`next: commit update.json, tag v${pkg.version}, create the GitHub release and upload build/${xpiName}`);
