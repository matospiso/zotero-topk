import { Bridge, SearchHit } from "./bridge";
import { PLUGIN_ID, getPref } from "./prefs";
import { log, logError, errorMessage } from "./log";

export const SEARCH_MODE = "topk";
export const SCORE_COLUMN = "topkScore";

export interface PageHit {
	id: string;
	attachmentID: number;
	attachmentKey: string;
	page: number;
	pageCount: number;
	score: number;
}

export interface ItemResult {
	itemID: number;
	score: number;
	hits: PageHit[];
}

/**
 * Adds a "TopK semantic (pages)" mode to Zotero's quick search. In that mode the
 * typed text is sent to TopK, the items list is filtered to the matching items
 * and sorted by a "TopK score" column; the per-page hits feed the item pane section.
 */
export class SearchIntegration {
	public results = new Map<number, ItemResult>();        // by (parent) item ID
	public byAttachment = new Map<number, PageHit[]>();     // by attachment item ID
	public lastQuery = "";
	public active = false;
	public onResults: (() => void) | null = null;
	private seq = 0;
	public columnKey: string | false = false;
	private prefObserver: any = null;
	private patched = new Map<any, any>();

	constructor(private bridge: Bridge) {}

	install() {
		this.columnKey = Zotero.ItemTreeManager.registerColumn({
			dataKey: SCORE_COLUMN,
			label: "TopK score",
			pluginID: PLUGIN_ID,
			enabledTreeIDs: ["main"],
			flex: 0,
			width: "90",
			staticWidth: true,
			sortReverse: true,
			zoteroPersist: ["width", "hidden"],
			dataProvider: (item: any) => this.scoreText(item),
		});
		this.prefObserver = Zotero.Prefs.registerObserver("search.quicksearch-mode", (value: string) => {
			if (value !== SEARCH_MODE && this.active) {
				for (const win of Zotero.getMainWindows()) void this.clear(win);
			}
		});
	}

	uninstall() {
		for (const win of Zotero.getMainWindows()) this.detachWindow(win);
		if (this.columnKey) {
			try { Zotero.ItemTreeManager.unregisterColumn(this.columnKey); } catch (e) {}
			this.columnKey = false;
		}
		if (this.prefObserver) {
			try { Zotero.Prefs.unregisterObserver(this.prefObserver); } catch (e) {}
			this.prefObserver = null;
		}
		if (Zotero.Prefs.get("search.quicksearch-mode") === SEARCH_MODE) {
			Zotero.Prefs.set("search.quicksearch-mode", "fields");
		}
	}

	private scoreText(item: any): string {
		const r = this.results.get(item.id);
		const hits = r ? null : this.byAttachment.get(item.id);
		const score = r ? r.score : hits?.[0]?.score;
		if (score === undefined) return "";
		// Fixed width so the (string based) column sort orders numerically.
		return score.toFixed(3).padStart(8, " ");
	}

	// ----------------------------------------------------------------------
	// Per-window wiring
	// ----------------------------------------------------------------------

	attachWindow(win: any) {
		const doc = win.document;
		const searchBox = doc.getElementById("zotero-tb-search");
		if (!searchBox || this.patched.has(win)) return;
		try {
			searchBox._searchModes[SEARCH_MODE] = "TopK semantic (pages)";
			const popup = searchBox.searchModePopup;
			if (popup && !popup.querySelector(`menuitem[value="${SEARCH_MODE}"]`)) {
				const item = doc.createXULElement("menuitem");
				item.setAttribute("type", "radio");
				item.setAttribute("label", searchBox._searchModes[SEARCH_MODE]);
				item.setAttribute("value", SEARCH_MODE);
				item.id = "zotero-topk-search-mode";
				item.addEventListener("command", () => {
					Zotero.Prefs.set("search.quicksearch-mode", SEARCH_MODE);
					searchBox.updateMode();
					if (searchBox.value) searchBox.dispatchEvent(new win.Event("command"));
				});
				popup.append(item);
			}
			searchBox.updateMode();
		}
		catch (e) {
			logError("attachWindow: search mode", e);
		}

		const pane = win.ZoteroPane;
		const original = pane.search;
		const self = this;
		pane.search = async function (runAdvanced: boolean) {
			if (Zotero.Prefs.get("search.quicksearch-mode") !== SEARCH_MODE) {
				if (self.active) await self.clear(win);
				return original.apply(this, arguments as any);
			}
			return self.runSearch(win, !!runAdvanced);
		};
		this.patched.set(win, original);
	}

	detachWindow(win: any) {
		const original = this.patched.get(win);
		if (original) {
			try { win.ZoteroPane.search = original; } catch (e) {}
			this.patched.delete(win);
		}
		try {
			const searchBox = win.document.getElementById("zotero-tb-search");
			if (searchBox) {
				delete searchBox._searchModes[SEARCH_MODE];
				searchBox._searchModePopup?.querySelector(`menuitem[value="${SEARCH_MODE}"]`)?.remove();
			}
		}
		catch (e) {}
		if (this.active) void this.clear(win);
	}

	// ----------------------------------------------------------------------
	// Searching
	// ----------------------------------------------------------------------

	private spinner(win: any, on: boolean) {
		const spinner = win.document.getElementById("zotero-tb-search-spinner");
		if (!spinner) return;
		if (on) {
			spinner.setAttribute("status", "animate");
			spinner.style.visibility = "visible";
		}
		else {
			spinner.style.removeProperty("visibility");
			spinner.removeAttribute("status");
		}
	}

	async runSearch(win: any, immediate: boolean) {
		const pane = win.ZoteroPane;
		const itemsView = pane.itemsView;
		if (!itemsView) return;
		const searchBox = win.document.getElementById("zotero-tb-search");
		const text = String(searchBox?.searchTextbox?.value ?? "").trim();
		const seq = ++this.seq;
		if (!text) {
			await this.clear(win);
			return;
		}
		if (!immediate && text.length < 3) return;
		this.spinner(win, true);
		try {
			let libraryIDs: number[] = [];
			try { libraryIDs = pane.getSelectedLibraryIDs?.() ?? []; } catch (e) {}
			if (!libraryIDs.length) {
				try { libraryIDs = [pane.getSelectedLibraryID()]; } catch (e) {}
			}
			const limit = getPref<number>("resultLimit", 60);
			const hits = await this.bridge.search(text, { limit, libraryIDs });
			if (seq !== this.seq) return; // superseded by newer input
			this.lastQuery = text;
			this.applyHits(hits);
			await this.applyFilter(win, libraryIDs);
			this.active = true;
			pane.clearItemsPaneMessage?.();
			log(`search “${text}”: ${hits.length} page hit(s), ${this.results.size} item(s)`);
		}
		catch (e) {
			if (seq !== this.seq) return;
			logError("search", e);
			// setItemsPaneMessage() HTML-parses string arguments in the privileged main window, and the error
			// text can originate from the TopK service: pass an element whose text node cannot be re-parsed.
			try {
				const el = win.document.createElementNS("http://www.w3.org/1999/xhtml", "p");
				el.textContent = `TopK search failed: ${errorMessage(e)}`.slice(0, 500);
				pane.setItemsPaneMessage(el);
			}
			catch (e2) {}
		}
		finally {
			if (seq === this.seq) this.spinner(win, false);
		}
	}

	private applyHits(hits: SearchHit[]) {
		this.results.clear();
		this.byAttachment.clear();
		for (const h of hits) {
			const att = Zotero.Items.getByLibraryAndKey(h.library_id, h.attachment_key);
			if (!att) continue;
			const hit: PageHit = {
				id: h._id,
				attachmentID: att.id,
				attachmentKey: att.key,
				page: h.page,
				pageCount: h.page_count,
				score: h.score,
			};
			const list = this.byAttachment.get(att.id) || [];
			list.push(hit);
			this.byAttachment.set(att.id, list);
			const itemID = att.parentItemID || att.id;
			const r = this.results.get(itemID);
			if (r) {
				r.hits.push(hit);
				r.score = Math.max(r.score, hit.score);
			}
			else {
				this.results.set(itemID, { itemID, score: hit.score, hits: [hit] });
			}
		}
		for (const r of this.results.values()) r.hits.sort((a, b) => b.score - a.score);
		this.onResults?.();
	}

	private async applyFilter(win: any, libraryIDs: number[]) {
		const itemsView = win.ZoteroPane.itemsView;
		const search = new Zotero.Search();
		search.name = "TopK results";
		search.libraryID = libraryIDs[0] ?? Zotero.Libraries.userLibraryID;
		search.addCondition("joinMode", "any");
		let n = 0;
		for (const itemID of this.results.keys()) {
			const item = Zotero.Items.get(itemID);
			if (!item) continue;
			search.addCondition("key", "is", item.key);
			if (++n >= 300) break;
		}
		if (!n) search.addCondition("key", "is", "TOPK-NO-MATCH");
		await itemsView.setFilter("search", "");
		await itemsView.setFilter("advanced-search", search);
		this.sortByScore(itemsView);
		try { itemsView.tree?.invalidate(); } catch (e) {}
	}

	private sortByScore(itemsView: any) {
		try {
			const cols = itemsView._getColumns();
			const index = cols.findIndex((c: any) => c.dataKey === this.columnKey);
			if (index < 0) return;
			if (cols[index].hidden) itemsView.tree._columns.toggleHidden(index);
			const col = itemsView._getColumns()[index];
			if (!col.sortDirection) itemsView.tree._columns.toggleSort(index);
		}
		catch (e) {
			logError("sortByScore", e);
		}
	}

	async clear(win: any) {
		this.seq++;
		this.active = false;
		this.results.clear();
		this.byAttachment.clear();
		this.onResults?.();
		this.spinner(win, false);
		try {
			await win.ZoteroPane.itemsView?.setFilter("advanced-search", null);
		}
		catch (e) {
			logError("clear", e);
		}
	}
}
