export const HELPER_FILES = ["server.js", "package.json", "package-lock.json"] as const;

export const MIN_NODE_VERSION = "22.13.0";

export function supportsNodeVersion(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (!match) return false;
	const minimum = MIN_NODE_VERSION.split(".").map(Number);
	for (let i = 0; i < minimum.length; i++) {
		const part = Number(match[i + 1]);
		if (part !== minimum[i]) return part > minimum[i];
	}
	return true;
}
