import { DEFAULT_PREFS, PREF_PREFIX, type PreferenceKey, type Preferences } from "../shared/preferences";
export { PREF_PREFIX, PLUGIN_ID } from "../shared/preferences";

export function getPref<K extends PreferenceKey>(key: K): Preferences[K] {
	const value = Zotero.Prefs.get(PREF_PREFIX + key, true);
	return value === undefined || value === null ? DEFAULT_PREFS[key] : value;
}

export function getPrefs<K extends PreferenceKey>(keys: readonly K[]): Pick<Preferences, K> {
	return Object.fromEntries(keys.map((key) => [key, getPref(key)])) as Pick<Preferences, K>;
}
