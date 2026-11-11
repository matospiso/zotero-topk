/* Preference pane logic. Loaded by Zotero into a sandbox whose prototype is the
   preferences window, so `window`, `document` and `Zotero` are in scope. */
(function () {
	"use strict";

	const PREF = "extensions.zotero-topk.";
	const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null;

	function setStatus(id: string, text: string, cls?: string) {
		const el = $(id);
		if (!el) return;
		el.textContent = text;
		el.classList.remove("ok", "error");
		if (cls) el.classList.add(cls);
	}

	async function testConnection() {
		const btn = $("zotero-topk-test")!;
		btn.disabled = true;
		setStatus("zotero-topk-status", "Starting helper and connecting…");
		try {
			const info = await Zotero.TopK.testConnection();
			const parts = [`Connected to collection "${info.collection}" in ${info.region}${info.host ? ` (${info.host})` : ""}`];
			if (info.created) parts.push("(collection created)");
			if (info.docCount != null) parts.push(`– ${info.docCount} page(s) indexed`);
			if (info.fake) parts.push("[FAKE backend]");
			setStatus("zotero-topk-status", parts.join(" "), "ok");
		}
		catch (e) {
			setStatus("zotero-topk-status", String(e instanceof Error ? e.message : e), "error");
		}
		finally {
			btn.disabled = false;
		}
	}

	async function browseNode() {
		const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		const fp = new FilePicker();
		fp.init(window, "Select the Node.js executable", fp.modeOpen);
		if ((await fp.show()) === fp.returnOK && fp.path) {
			Zotero.Prefs.set(PREF + "nodePath", fp.path, true);
			$("zotero-topk-node")!.value = fp.path;
		}
	}

	function refreshIndexStatus() {
		const el = $("zotero-topk-index-status");
		if (!el || !Zotero.TopK) return;
		try {
			el.textContent = Zotero.TopK.getStatusText();
		}
		catch (e) {
			el.textContent = "";
		}
	}

	function init() {
		if (!$("zotero-topk-test")) {
			window.setTimeout(init, 50);
			return;
		}
		$("zotero-topk-test")!.addEventListener("command", testConnection);
		$("zotero-topk-node-browse")!.addEventListener("command", browseNode);
		$("zotero-topk-index-now")!.addEventListener("command", () => {
			Zotero.TopK.indexAllLibraries({ force: false });
			refreshIndexStatus();
		});
		$("zotero-topk-rebuild")!.addEventListener("command", () => {
			if (Services.prompt.confirm(window, "TopK Semantic Search",
				"Re-render and re-upload every PDF and snapshot in all libraries? This can take a long time.")) {
				Zotero.TopK.indexAllLibraries({ force: true });
				refreshIndexStatus();
			}
		});
		const maxPages = $("zotero-topk-maxpages")!;
		maxPages.value = Zotero.Prefs.get(PREF + "maxPages", true) || 500;
		maxPages.addEventListener("change", () => {
			const n = parseInt(maxPages.value, 10);
			if (Number.isFinite(n) && n > 0) Zotero.Prefs.set(PREF + "maxPages", n, true);
		});
		refreshIndexStatus();
		const timer = window.setInterval(refreshIndexStatus, 2000);
		window.addEventListener("unload", () => window.clearInterval(timer), { once: true });
	}

	init();
})();
