import manifest from "../addon/manifest.json";

export const PLUGIN_ID = manifest.applications.zotero.id;
export const PREF_PREFIX = "extensions.zotero-topk.";

// The order is part of the destination fingerprint stored in existing index state.
const DESTINATION_DEFAULTS = {
	apiKey: "",
	region: "aws-us-east-1-elastica",
	collection: "zotero-pages",
	host: "",
	bridgeFake: false,
};

export const DEFAULT_PREFS = {
	...DESTINATION_DEFAULTS,
	nodePath: "",
	autoIndex: false,
	indexSnapshots: true,
	maxPages: 500,
	maxFileMB: 200,
	docTimeoutMinutes: 30,
	maxEdge: 1536,
	jpegQuality: 85,
	resultLimit: 60,
	renderConcurrency: 8,
	uploadBatch: 8,
	uploadConcurrency: 4,
	debug: false,
	selftest: "",
};

export type Preferences = typeof DEFAULT_PREFS;
export type PreferenceKey = keyof Preferences;
export const DESTINATION_PREFS = Object.keys(DESTINATION_DEFAULTS) as Array<keyof typeof DESTINATION_DEFAULTS>;
export const UNINSTALL_PREFS = Object.keys(DEFAULT_PREFS);
