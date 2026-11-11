import { PREF_PREFIX, UNINSTALL_PREFS } from "../shared/preferences";

let chromeHandle: { destruct(): void } | null = null;
interface AddonData { id: string; version: string; rootURI: string }
const RESOURCE_HOST = "zotero-topk";

function resourceHandler() {
	return Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsIResProtocolHandler);
}

function install() {}

/**
 * Remove everything the plugin created outside its own package: the index state,
 * the helper directory (with its node_modules) and the plugin's preferences,
 * including the API key.
 */
async function uninstall(_data: AddonData, reason: number) {
	if (typeof ADDON_UNINSTALL !== "undefined" && reason !== ADDON_UNINSTALL) return;
	try {
		const dataDir = Zotero.DataDirectory.dir;
		await IOUtils.remove(PathUtils.join(dataDir, "topk-index-state.json"), { ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(dataDir, "topk-index-state.json.tmp"), { ignoreAbsent: true });
		await IOUtils.remove(PathUtils.join(dataDir, "topk-bridge"), { ignoreAbsent: true, recursive: true });
		for (const key of UNINSTALL_PREFS) {
			try { Zotero.Prefs.clear(PREF_PREFIX + key, true); } catch (e) {}
		}
	}
	catch (e) {
		Zotero.debug(`[TopK] uninstall cleanup failed: ${e}`);
	}
}

async function startup({ version, rootURI }: AddonData) {
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zotero-topk", rootURI + "content/"],
	]);
	// resource://zotero-topk/ serves the page renderer (and its bundled pdf.js) to a
	// content-privileged browser, so untrusted PDFs are never parsed with chrome privileges.
	resourceHandler().setSubstitution(RESOURCE_HOST, Services.io.newURI(rootURI));

	const ctx = { Zotero, rootURI, pluginVersion: version };
	Services.scriptloader.loadSubScript(rootURI + "content/zotero-topk.js", ctx);
	await Zotero.TopK.startup();
}

function onMainWindowLoad({ window }: { window: Window }) {
	Zotero.TopK?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }: { window: Window }) {
	Zotero.TopK?.onMainWindowUnload(window);
}

async function shutdown(_data: AddonData, reason: number) {
	if (reason === APP_SHUTDOWN) {
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

// Zotero discovers these callbacks on the bootstrap sandbox, outside the bundled closure.
Object.assign(globalThis, { install, uninstall, startup, shutdown, onMainWindowLoad, onMainWindowUnload });
