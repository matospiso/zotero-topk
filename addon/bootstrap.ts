/* global Components, Services, Zotero, APP_SHUTDOWN, ADDON_UNINSTALL */
"use strict";

var chromeHandle: { destruct(): void } | null = null;
interface AddonData { id: string; version: string; rootURI: string }
const RESOURCE_HOST = "zotero-topk";
const PREF_KEYS = [
	"apiKey", "region", "host", "collection", "nodePath", "bunPath", "autoIndex", "indexSnapshots", "maxPages", "maxEdge",
	"jpegQuality", "resultLimit", "renderConcurrency", "uploadBatch", "uploadConcurrency", "maxFileMB", "docTimeoutMinutes", "debug",
	"bridgeFake", "selftest",
];

function resourceHandler() {
	return Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
}

function install() {}

/**
 * Remove everything the plugin created outside its own package: the index state,
 * the helper directory (with its node_modules) and the plugin's preferences,
 * including the API key.
 */
async function uninstall({ id, version, rootURI }: AddonData, reason: number) {
	if (typeof ADDON_UNINSTALL !== "undefined" && reason !== ADDON_UNINSTALL) return;
	try {
		const dataDir = Zotero.DataDirectory.dir;
		await IOUtils.remove(PathUtils.join(dataDir, "topk-index-state.json"), { ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(dataDir, "topk-index-state.json.tmp"), { ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(dataDir, "topk-bridge"), { ignoreAbsent: true, recursive: true });
		for (const key of PREF_KEYS) {
			try { Zotero.Prefs.clear(`extensions.zotero-topk.${key}`, true); } catch (e) {}
		}
	}
	catch (e) {
		Zotero.debug(`[TopK] uninstall cleanup failed: ${e}`);
	}
}

async function startup({ id, version, rootURI }: AddonData, reason: number) {
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zotero-topk", rootURI + "content/"],
	]);
	// resource://zotero-topk/ serves the page renderer (and its bundled pdf.js) to a
	// content-privileged browser, so untrusted PDFs are never parsed with chrome privileges.
	resourceHandler().setSubstitution(RESOURCE_HOST, Services.io.newURI(rootURI));

	// The bundled plugin code assigns `Zotero.TopK`.
	const ctx = { Zotero, rootURI, pluginID: id, pluginVersion: version };
	Services.scriptloader.loadSubScript(rootURI + "content/zotero-topk.js", ctx);
	await Zotero.TopK.startup({ id, version, rootURI, reason });
}

function onMainWindowLoad({ window }: { window: Window }) {
	Zotero.TopK?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }: { window: Window }) {
	Zotero.TopK?.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }: AddonData, reason: number) {
	if (reason === APP_SHUTDOWN) {
		// Still make sure the helper process doesn't outlive Zotero.
		try { Zotero.TopK?.onAppShutdown(); } catch (e) {}
		return;
	}
	try {
		await Zotero.TopK?.shutdown();
	}
	finally {
		delete Zotero.TopK;
		try { resourceHandler().setSubstitution(RESOURCE_HOST, null); } catch (e) {}
		if (chromeHandle) {
			chromeHandle.destruct();
			chromeHandle = null;
		}
	}
}
