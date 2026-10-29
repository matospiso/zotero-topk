/* global Components, Services, Zotero, APP_SHUTDOWN */
"use strict";

var chromeHandle = null;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zotero-topk", rootURI + "content/"],
	]);

	// The bundled plugin code assigns `Zotero.TopK`.
	const ctx = { Zotero, rootURI, pluginID: id, pluginVersion: version };
	Services.scriptloader.loadSubScript(rootURI + "content/zotero-topk.js", ctx);
	await Zotero.TopK.startup({ id, version, rootURI, reason });
}

function onMainWindowLoad({ window }) {
	Zotero.TopK?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	Zotero.TopK?.onMainWindowUnload(window);
}

async function shutdown({ id, version, rootURI }, reason) {
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
		if (chromeHandle) {
			chromeHandle.destruct();
			chromeHandle = null;
		}
	}
}
