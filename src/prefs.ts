export const PREF_PREFIX = "extensions.zotero-topk.";
export const PLUGIN_ID = "zotero-topk@topk.io";

export function getPref<T>(key: string, fallback?: T): T {
	const v = Zotero.Prefs.get(PREF_PREFIX + key, true);
	return (v === undefined || v === null ? fallback : v) as T;
}

export function setPref(key: string, value: string | number | boolean) {
	Zotero.Prefs.set(PREF_PREFIX + key, value, true);
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
