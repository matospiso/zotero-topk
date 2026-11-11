import { DEFAULT_PREFS, PREF_PREFIX } from "../shared/preferences";

for (const [key, value] of Object.entries(DEFAULT_PREFS)) pref(PREF_PREFIX + key, value);
