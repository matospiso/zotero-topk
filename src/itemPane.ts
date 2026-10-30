import { Bridge } from "./bridge";
import { Indexer, classifyAttachment } from "./indexer";
import { SearchIntegration, PageHit } from "./search";
import { PLUGIN_ID } from "./prefs";
import { logError } from "./log";

const PANE_ID = "zotero-topk-pages";

/**
 * "TopK pages" item pane section: shows the matching pages (with thumbnails)
 * for the current search, or the index status of the item's attachments.
 */
export class ItemPaneSection {
	private registered: string | false = false;
	private refreshers = new Map<any, () => void>();

	constructor(private bridge: Bridge, private indexer: Indexer, private search: SearchIntegration) {}

	register() {
		this.registered = Zotero.ItemPaneManager.registerSection({
			paneID: PANE_ID,
			pluginID: PLUGIN_ID,
			header: { l10nID: "zotero-topk-section-head", icon: "chrome://zotero-topk/content/icons/topk-16.svg" },
			sidenav: { l10nID: "zotero-topk-section-sidenav", icon: "chrome://zotero-topk/content/icons/topk-20.svg" },
			onInit: ({ body, refresh }: any) => { if (body && refresh) this.refreshers.set(body, refresh); },
			onDestroy: ({ body }: any) => { this.refreshers.delete(body); },
			onItemChange: ({ item, setEnabled }: any) => setEnabled(this.relevantAttachments(item).length > 0),
			onRender: ({ body, item, doc }: any) => {
				try { this.render(body, item, doc); } catch (e) { logError("itemPane render", e); }
			},
			onAsyncRender: async ({ body }: any) => {
				try { await this.loadThumbnails(body); } catch (e) { logError("itemPane thumbnails", e); }
			},
		});
	}

	unregister() {
		this.refreshers.clear();
		if (this.registered) {
			try { Zotero.ItemPaneManager.unregisterSection(this.registered); } catch (e) {}
			this.registered = false;
		}
	}

	/** Ask Zotero to re-render the section after search results change. */
	refresh() {
		for (const refresh of this.refreshers.values()) {
			try { refresh(); } catch (e) {}
		}
	}

	private relevantAttachments(item: any): any[] {
		if (!item) return [];
		if (item.isAttachment()) return classifyAttachment(item) ? [item] : [];
		if (item.isRegularItem()) return Zotero.Items.get(item.getAttachments()).filter((a: any) => classifyAttachment(a));
		return [];
	}

	private hitsFor(item: any): PageHit[] {
		if (item.isAttachment()) return this.search.byAttachment.get(item.id) || [];
		return this.search.results.get(item.id)?.hits || [];
	}

	private render(body: any, item: any, doc: any) {
		body.replaceChildren();
		const style = doc.createElement("style");
		style.textContent = `
			.topk-hits { display: flex; flex-direction: column; gap: 6px; }
			.topk-hit { display: flex; gap: 8px; align-items: center; cursor: pointer; border-radius: 5px; padding: 3px; }
			.topk-hit:hover { background: var(--fill-quinary, rgba(0,0,0,0.06)); }
			.topk-thumb { width: 72px; height: 96px; object-fit: contain; background: #fff; border: 1px solid var(--fill-quinary, #ddd); border-radius: 3px; flex: none; }
			.topk-thumb.empty { background: var(--fill-quinary, #eee); }
			.topk-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
			.topk-meta .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.topk-meta .sub { opacity: 0.7; font-size: 0.92em; }
			.topk-status { display: flex; flex-direction: column; gap: 4px; }
			.topk-status .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
			.topk-status .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.topk-status .state { opacity: 0.7; white-space: nowrap; }
			.topk-query { opacity: 0.7; font-size: 0.92em; margin-bottom: 4px; }
		`;
		body.append(style);

		const hits = this.hitsFor(item);
		if (hits.length) {
			const q = doc.createElement("div");
			q.className = "topk-query";
			q.textContent = `Best pages for “${this.search.lastQuery}”`;
			body.append(q);
			const list = doc.createElement("div");
			list.className = "topk-hits";
			for (const hit of hits.slice(0, 12)) {
				const att = Zotero.Items.get(hit.attachmentID);
				const row = doc.createElement("div");
				row.className = "topk-hit";
				row.dataset.pageId = hit.id;
				const img = doc.createElement("img");
				img.className = "topk-thumb empty";
				img.alt = `Page ${hit.page}`;
				const meta = doc.createElement("div");
				meta.className = "topk-meta";
				const title = doc.createElement("div");
				title.className = "title";
				title.textContent = `Page ${hit.page}${hit.pageCount ? ` of ${hit.pageCount}` : ""}`;
				const sub = doc.createElement("div");
				sub.className = "sub";
				sub.textContent = `${att?.attachmentFilename || att?.getDisplayTitle?.() || hit.attachmentKey} · score ${hit.score.toFixed(3)}`;
				meta.append(title, sub);
				row.append(img, meta);
				row.addEventListener("click", () => {
					Zotero.Reader.open(hit.attachmentID, { pageIndex: hit.page - 1 }, { allowDuplicate: false })
						.catch((e: unknown) => logError("open reader", e));
				});
				list.append(row);
			}
			body.append(list);
			return;
		}

		const status = doc.createElement("div");
		status.className = "topk-status";
		for (const att of this.relevantAttachments(item)) {
			const st = this.indexer.getState(att);
			const row = doc.createElement("div");
			row.className = "row";
			const name = doc.createElement("span");
			name.className = "name";
			name.textContent = att.attachmentFilename || att.getDisplayTitle?.() || att.key;
			const state = doc.createElement("span");
			state.className = "state";
			const current = this.indexer.current;
			if (current && current.itemID === att.id) {
				state.textContent = `indexing page ${current.page}…`;
			}
			else if (st && st.status !== "ok") {
				state.textContent = st.status === "failed" ? "indexing failed" : "indexing incomplete";
			}
			else if (st) {
				state.textContent = `${st.pages} page${st.pages === 1 ? "" : "s"} indexed`;
			}
			else {
				state.textContent = "not indexed";
			}
			row.append(name, state);
			status.append(row);
		}
		const actions = doc.createElement("div");
		actions.className = "row";
		const btn = doc.createElement("button");
		btn.textContent = "Index now";
		btn.addEventListener("click", () => {
			this.indexer.enqueueItems([item], true);
			btn.disabled = true;
			btn.textContent = "Queued…";
		});
		actions.append(btn);
		status.append(actions);
		body.append(status);
	}

	private async loadThumbnails(body: any) {
		const rows: any[] = Array.from(body.querySelectorAll(".topk-hit[data-page-id]"));
		if (!rows.length) return;
		const ids = rows.map((r) => r.dataset.pageId);
		const images = await this.bridge.images(ids);
		for (const row of rows) {
			const img = images[row.dataset.pageId];
			const el = row.querySelector("img");
			if (img && el) {
				el.src = `data:image/${img.format || "jpeg"};base64,${img.b64}`;
				el.classList.remove("empty");
			}
		}
	}
}
