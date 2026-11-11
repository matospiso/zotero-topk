import { Bridge } from "./bridge";
import { Renderer } from "./renderer";
import { Indexer } from "./indexer";
import { SearchIntegration } from "./search";
import { ItemPaneSection } from "./itemPane";
import { Menus } from "./menus";
import { PLUGIN_ID, getPref } from "./prefs";
import { log, logError, errorMessage } from "./log";
import { runSelfTest } from "./selftest";
import { selectedLibraryIDs } from "./library";

export class TopKAddon {
	public readonly bridge: Bridge;
	public readonly renderer: Renderer;
	public readonly indexer: Indexer;
	public readonly search: SearchIntegration;
	public readonly itemPane: ItemPaneSection;
	public readonly menus: Menus;
	public readonly version: string;
	public readonly rootURI: string;
	private prefPaneID: string | null = null;

	constructor(rootURI: string, version: string) {
		this.rootURI = rootURI;
		this.version = version;
		this.bridge = new Bridge(rootURI, version);
		this.renderer = new Renderer();
		this.indexer = new Indexer(this.bridge, this.renderer);
		this.search = new SearchIntegration(this.bridge);
		this.itemPane = new ItemPaneSection(this.bridge, this.indexer, this.search);
		this.menus = new Menus();
		this.search.onResults = () => this.itemPane.refresh();
		this.indexer.onChange = () => this.itemPane.refresh();
	}

	async startup() {
		await Zotero.initializationPromise;
		await Zotero.uiReadyPromise;
		log(`starting v${this.version}`);

		this.prefPaneID = await Zotero.PreferencePanes.register({
			pluginID: PLUGIN_ID,
			src: this.rootURI + "content/preferences.xhtml",
			scripts: [this.rootURI + "content/preferences.js"],
			stylesheets: [this.rootURI + "content/preferences.css"],
			label: "TopK Semantic Search",
			image: this.rootURI + "content/icons/topk-20.svg",
			helpURL: "https://docs.topk.io/",
		});

		this.search.install();
		this.itemPane.register();
		this.menus.register({
			indexNew: () => void this.indexAllLibraries({ force: false }),
			rebuildLibrary: (win) => this.rebuildSelectedLibrary(win),
			openSettings: () => this.openSettings(),
			indexSelected: (items) => this.indexer.enqueueItems(items, true),
			removeSelected: (items) => void this.indexer.removeItems(items).catch((e) => logError("removeItems", e)),
		});
		for (const win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
		await this.indexer.start();

		if (__DEV__) {
			const selftest = getPref("selftest");
			if (selftest) {
				runSelfTest(this, selftest).catch((e) => logError("selftest", e));
			}
		}
	}

	onMainWindowLoad(win: any) {
		try {
			win.MozXULElement.insertFTLIfNeeded("zotero-topk.ftl");
			this.search.attachWindow(win);
		}
		catch (e) {
			logError("onMainWindowLoad", e);
		}
	}

	onMainWindowUnload(win: any) {
		this.search.detachWindow(win);
		this.renderer.onWindowUnload(win);
	}

	async shutdown() {
		log("shutting down");
		this.indexer.stop();
		this.search.uninstall();
		this.itemPane.unregister();
		this.menus.unregister();
		this.renderer.destroy();
		if (this.prefPaneID) {
			try { Zotero.PreferencePanes.unregister(this.prefPaneID); } catch (e) {}
		}
		await this.bridge.stop();
	}

	onAppShutdown() {
		this.bridge.killSync();
	}

	async testConnection() {
		const result = await this.bridge.testConnection();
		void this.indexer.retryPendingDeletes().catch((e) => logError("deletions after connection", e));
		if (getPref("autoIndex")) {
			void this.indexer.indexAllLibraries({ force: false }).catch((e) => logError("sync after connection", e));
		}
		return result;
	}

	getStatusText(): string {
		const bridge = this.bridge.running
			? `Helper running${this.bridge.info.fake ? " (fake backend)" : ""}.`
			: (this.bridge.lastError ? `Helper not running: ${this.bridge.lastError}` : "Helper not started yet.");
		return `${bridge} ${this.indexer.getStatusText()}`;
	}

	async indexAllLibraries({ force }: { force: boolean }) {
		try {
			await this.bridge.ensureReady();
			await this.indexer.indexAllLibraries({ force });
		}
		catch (e) {
			this.alert(`TopK indexing could not start: ${errorMessage(e)}`);
		}
	}

	private rebuildSelectedLibrary(win: any) {
		win = win || Zotero.getMainWindow();
		const libraryIDs = selectedLibraryIDs(win.ZoteroPane);
		if (!libraryIDs.length) return;
		const names = libraryIDs.map((id) => Zotero.Libraries.get(id)?.name || id).join(", ");
		if (!Services.prompt.confirm(win, "TopK Semantic Search",
			`Re-render and re-upload every PDF and snapshot in “${names}”? This can take a long time.`)) {
			return;
		}
		(async () => {
			try {
				await this.bridge.ensureReady();
				for (const id of libraryIDs) await this.indexer.indexLibrary(id, { force: true });
			}
			catch (e) {
				this.alert(`TopK indexing could not start: ${errorMessage(e)}`);
			}
		})();
	}

	openSettings() {
		Zotero.Utilities.Internal.openPreferences(this.prefPaneID || undefined);
	}

	private alert(msg: string) {
		log(msg);
		try {
			const pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline("TopK Semantic Search");
			pw.addDescription(msg);
			pw.show();
			pw.startCloseTimer(8000);
		}
		catch (e) {}
	}
}
