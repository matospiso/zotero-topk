import { getPref } from "./prefs";

export function log(msg: string) {
	Zotero.debug(`[TopK] ${msg}`);
}

export function debug(msg: string) {
	if (getPref("debug")) Zotero.debug(`[TopK] ${msg}`);
}

export function logError(context: string, e: unknown) {
	const err = e instanceof Error ? e : new Error(String(e));
	Zotero.debug(`[TopK] ${context}: ${err.message}`);
	Zotero.logError(err);
}

export function errorMessage(e: unknown): string {
	if (e && typeof e === "object" && "message" in e) return String((e as any).message);
	return String(e);
}
