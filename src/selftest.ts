import type { TopKAddon } from "./addon";
import { delay } from "./prefs";
import { log, errorMessage } from "./log";

/** Assert both sides of deletion, with a deadline even if the bridge never responds. */
export async function verifyRemoval(addon: Pick<TopKAddon, "bridge" | "indexer">, item: any, timeoutMs = 30000) {
	let finished = false;
	let stillIndexed = true;
	let remoteExists = true;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(
			`Attachment removal timed out (local state: ${stillIndexed}, remote pages: ${remoteExists})`)), timeoutMs);
	});
	const check = async () => {
		while (!finished) {
			stillIndexed = !!addon.indexer.getState(item);
			remoteExists = await addon.bridge.hasAttachment(item.libraryID, item.key);
			if (!stillIndexed && !remoteExists) return { stillIndexed, remoteExists };
			if (!finished) await delay(200);
		}
		throw new Error("Attachment removal check expired");
	};
	try { return await Promise.race([check(), timeout]); }
	finally { finished = true; clearTimeout(timer!); }
}

/**
 * Development-only end-to-end check, driven by scripts/e2e.ts:
 * imports fixture attachments, waits for indexing, runs a search through the
 * real quick-search code path, writes a JSON report and quits Zotero.
 */
export async function runSelfTest(addon: TopKAddon, outPath: string) {
	const report: any = { ok: false, steps: [], errors: [] };
	const step = (name: string, data?: any) => { report.steps.push({ name, ...(data || {}) }); log(`selftest: ${name}`); };
	const write = () => IOUtils.writeUTF8(outPath, JSON.stringify(report, null, 2));
	const fixtureDir = PathUtils.parent(outPath);
	try {
		await delay(1500);
		const win = Zotero.getMainWindow();
		step("main window", { hasWindow: !!win, hasPane: !!win?.ZoteroPane, hasItemsView: !!win?.ZoteroPane?.itemsView });
		const libraryID = Zotero.Libraries.userLibraryID;

		// 1. Fixtures: a standalone PDF and a web page item with an HTML snapshot.
		const pdfPath = PathUtils.join(fixtureDir, "fixture.pdf");
		const htmlPath = PathUtils.join(fixtureDir, "fixture.html");
		const pdfItem = await Zotero.Attachments.importFromFile({ file: pdfPath, libraryID, title: "Fixture PDF about elephants" });
		step("imported pdf", { itemID: pdfItem.id, key: pdfItem.key });
		let snapshotItem: any = null;
		if (await IOUtils.exists(htmlPath)) {
			const parent = new Zotero.Item("webpage");
			parent.libraryID = libraryID;
			parent.setField("title", "Fixture web page about volcanoes");
			parent.setField("url", "https://example.org/volcanoes");
			await parent.saveTx();
			snapshotItem = await Zotero.Attachments.importSnapshotFromFile({
				file: htmlPath,
				url: "https://example.org/volcanoes",
				title: "Snapshot",
				contentType: "text/html",
				parentItemID: parent.id,
			});
			step("imported snapshot", { itemID: snapshotItem.id, key: snapshotItem.key, parentID: parent.id });
		}

		// 1b. Optional real papers (papers/*.pdf next to the report).
		const papersDir = PathUtils.join(fixtureDir, "papers");
		const paperItems: any[] = [];
		if (await IOUtils.exists(papersDir)) {
			for (const path of await IOUtils.getChildren(papersDir)) {
				if (!path.toLowerCase().endsWith(".pdf")) continue;
				const item = await Zotero.Attachments.importFromFile({ file: path, libraryID, title: PathUtils.filename(path) });
				paperItems.push(item);
			}
			step("imported papers", { count: paperItems.length });
		}

		// 2. Indexing is triggered by the notifier; wait for it.
		await delay(4000);
		await addon.indexer.whenIdle(900000);
		const pdfState = addon.indexer.getState(pdfItem);
		step("papers indexed", { papers: paperItems.map((it) => ({ title: it.getDisplayTitle(), state: addon.indexer.getState(it) })) });
		for (const it of paperItems) if (addon.indexer.getState(it)?.status !== "ok") report.errors.push(`paper not indexed: ${it.getDisplayTitle()} (${addon.indexer.lastError})`);
		const htmlState = snapshotItem ? addon.indexer.getState(snapshotItem) : null;
		step("indexed", { pdf: pdfState, html: htmlState, status: addon.getStatusText() });
		if (pdfState?.status !== "ok") report.errors.push("PDF was not indexed: " + addon.indexer.lastError);
		if (snapshotItem && htmlState?.status !== "ok") report.errors.push("Snapshot was not indexed: " + addon.indexer.lastError);

		// 3. Direct bridge search + image fetch.
		const hits = await addon.bridge.search("elephants", { limit: 10, libraryIDs: [libraryID] });
		step("bridge search", { hits: hits.map((h) => ({ id: h._id, key: h.attachment_key, page: h.page, score: h.score })) });
		if (!hits.length) report.errors.push("search returned no hits");
		if (hits.length) {
			const images = await addon.bridge.images([hits[0]._id]);
			const img = images[hits[0]._id];
			step("images", { got: !!img, bytes: img ? Math.round(img.b64.length * 0.75) : 0 });
			if (img) {
				const bin = atob(img.b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				await IOUtils.write(PathUtils.join(fixtureDir, "hit.jpg"), bytes);
			}
			if (!img) report.errors.push("no image returned for top hit");
		}

		// 3b. Retrieval-quality probes (queries.json next to the report), top hit image saved as q<i>.jpg.
		const queriesPath = PathUtils.join(fixtureDir, "queries.json");
		if (await IOUtils.exists(queriesPath)) {
			const queries: string[] = JSON.parse(await IOUtils.readUTF8(queriesPath));
			const probes: any[] = [];
			for (let i = 0; i < queries.length; i++) {
				const started = Date.now();
				const qh = await addon.bridge.search(queries[i], { limit: 5, libraryIDs: [libraryID] });
				const ms = Date.now() - started;
				probes.push({ query: queries[i], ms, hits: qh.map((h) => ({ title: h.title, page: h.page, score: h.score })) });
				if (qh.length) {
					const im = (await addon.bridge.images([qh[0]._id]))[qh[0]._id];
					if (im) {
						const bin = atob(im.b64);
						const bytes = new Uint8Array(bin.length);
						for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
						await IOUtils.write(PathUtils.join(fixtureDir, `q${i}.jpg`), bytes);
					}
				}
			}
			step("probes", { probes });
		}

		// 4. Quick-search mode through the real UI path.
		if (win?.ZoteroPane?.itemsView) {
			const pane = win.ZoteroPane;
			Zotero.Prefs.set("search.quicksearch-mode", "topk");
			const searchBox = win.document.getElementById("zotero-tb-search");
			searchBox.updateMode();
			searchBox.searchTextbox.value = "elephants";
			await pane.search(true);
			await delay(500);
			const view = pane.itemsView;
			const rows: any[] = [];
			for (let i = 0; i < view.rowCount; i++) {
				const row = view.getRow(i);
				if (row?.isObjectRow === false) continue;
				const ref = row?.ref;
				if (ref?.id) rows.push({ id: ref.id, key: ref.key, score: addon.search.results.get(ref.id)?.score ?? addon.search.byAttachment.get(ref.id)?.[0]?.score ?? null });
			}
			const cols = view._getColumns();
			const scoreCol = cols.find((c: any) => c.dataKey === addon.search.columnKey);
			step("quick search", {
				mode: Zotero.Prefs.get("search.quicksearch-mode"),
				modeMenuItem: !!searchBox.searchModePopup?.querySelector('menuitem[value="topk"]'),
				active: addon.search.active,
				results: addon.search.results.size,
				rows,
				scoreColumn: scoreCol ? { hidden: scoreCol.hidden, sortDirection: scoreCol.sortDirection } : null,
				columnKey: addon.search.columnKey,
				columnKeys: cols.map((c: any) => c.dataKey),
			});
			if (!rows.length) report.errors.push("quick search produced no rows in the item tree");
			// Clearing restores the normal list.
			searchBox.searchTextbox.value = "";
			await pane.search(true);
			step("cleared", { active: addon.search.active, rowCount: pane.itemsView.rowCount });
			Zotero.Prefs.set("search.quicksearch-mode", "fields");
		}

		// 5. Removal path (trash → delete from index).
		if (pdfState) {
			pdfItem.deleted = true;
			await pdfItem.saveTx();
			step("trashed", await verifyRemoval(addon, pdfItem));
		}
		report.ok = report.errors.length === 0;
	}
	catch (e) {
		report.errors.push(errorMessage(e));
		report.stack = (e as any)?.stack;
	}
	await write();
	log(`selftest done: ok=${report.ok}`);
	await delay(500);
	Zotero.Utilities.Internal.quit();
}
