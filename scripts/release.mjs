// Builds the release xpi and writes update.json with the xpi's sha256, so Zotero's updater
// verifies the bytes it downloads (update_hash) against what this reviewed commit published.
//
//   node scripts/release.mjs            # build/zotero-topk-<version>.xpi + update.json
//
// Release flow: bump "version" in package.json, run this script, commit update.json, tag
// v<version>, create a GitHub release for that tag and upload the xpi as the asset named below.
// update_link must point at that immutable release asset, never at a branch path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "addon", "manifest.json"), "utf8"));
const repo = process.env.TOPK_PLUGIN_REPO || "topk-io/zotero-topk";

execFileSync("node", [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
const xpiName = `zotero-topk-${pkg.version}.xpi`;
const xpi = readFileSync(join(root, "build", xpiName));
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
