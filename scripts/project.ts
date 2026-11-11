import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";
import manifest from "../addon/manifest.json";

export { pkg, manifest };
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const addonID = manifest.applications.zotero.id;
export const buildDir = join(root, "build");
export const addonDir = join(buildDir, "addon");
export const xpiName = `zotero-topk-${pkg.version}.xpi`;
export const xpiPath = join(buildDir, xpiName);
