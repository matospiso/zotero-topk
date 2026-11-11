import type { TopKAddon } from "./addon";
import { delay, withTimeout } from "../shared/async";
import { log, errorMessage } from "./log";

export async function verifyRemoval(addon: Pick<TopKAddon, "bridge" | "indexer">, item: any, timeoutMs = 30000) {
	let finished = false;
	let stillIndexed = true;
	let remoteExists = true;
	const check = async () => {
		while (!finished) {
			stillIndexed = !!addon.indexer.getState(item);
			remoteExists = await addon.bridge.hasAttachment(item.libraryID, item.key);
			if (!stillIndexed && !remoteExists) return { stillIndexed, remoteExists };
			if (!finished) await delay(200);
		}
		throw new Error("Attachment removal check expired");
	};
	try {
		return await withTimeout(check(), timeoutMs, () => new Error(
			`Attachment removal timed out (local state: ${stillIndexed}, remote pages: ${remoteExists})`));
	}
	finally { finished = true; }
}

export async function waitForMainWindow(timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const win = Zotero.getMainWindow();
		const searchBox = win?.document?.getElementById("zotero-tb-search");
		if (win?.ZoteroPane?.itemsView && searchBox?.searchTextbox) return win;
		if (Date.now() >= deadline) throw new Error("Zotero main window and quick-search UI did not become ready");
		await delay(Math.min(100, deadline - Date.now()));
	}
}

async function writeImage(path: string, base64: string) {
	const binary = atob(base64);
	await IOUtils.write(path, Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export async function runSelfTest(addon: TopKAddon, outPath: string) {
	const report: any = { ok: false, steps: [], errors: [] };
	const step = (name: string, data?: any) => { report.steps.push({ name, ...(data || {}) }); log(`selftest: ${name}`); };
	const write = () => IOUtils.writeUTF8(outPath, JSON.stringify(report, null, 2));
	const fixtureDir = PathUtils.parent(outPath);
	try {
		const win = await waitForMainWindow();
		step("main window", { hasWindow: !!win, hasPane: !!win?.ZoteroPane, hasItemsView: !!win?.ZoteroPane?.itemsView });
		const libraryID = Zotero.Libraries.userLibraryID;

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

		await addon.indexer.whenIdle(900000);
		const pdfState = addon.indexer.getState(pdfItem);
		step("papers indexed", { papers: paperItems.map((it) => ({ title: it.getDisplayTitle(), state: addon.indexer.getState(it) })) });
		for (const it of paperItems) if (addon.indexer.getState(it)?.status !== "ok") report.errors.push(`paper not indexed: ${it.getDisplayTitle()} (${addon.indexer.lastError})`);
		const htmlState = snapshotItem ? addon.indexer.getState(snapshotItem) : null;
		step("indexed", { pdf: pdfState, html: htmlState, status: addon.getStatusText() });
		if (pdfState?.status !== "ok") report.errors.push("PDF was not indexed: " + addon.indexer.lastError);
		if (snapshotItem && htmlState?.status !== "ok") report.errors.push("Snapshot was not indexed: " + addon.indexer.lastError);

		const hits = await addon.bridge.search("elephants", { limit: 10, libraryIDs: [libraryID] });
		step("bridge search", { hits: hits.map((h) => ({ id: h._id, key: h.attachment_key, page: h.page, score: h.score })) });
		if (!hits.length) report.errors.push("search returned no hits");
		if (hits.length) {
			const images = await addon.bridge.images([hits[0]._id]);
			const img = images[hits[0]._id];
			step("images", { got: !!img, bytes: img ? Math.round(img.b64.length * 0.75) : 0 });
			if (img) {
				await writeImage(PathUtils.join(fixtureDir, "hit.jpg"), img.b64);
			}
			if (!img) report.errors.push("no image returned for top hit");
		}

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
						await writeImage(PathUtils.join(fixtureDir, `q${i}.jpg`), im.b64);
					}
				}
			}
			step("probes", { probes });
		}

		const pane = win.ZoteroPane;
		Zotero.Prefs.set("search.quicksearch-mode", "topk");
		const searchBox = win.document.getElementById("zotero-tb-search");
		searchBox.updateMode();
		searchBox.searchTextbox.value = "elephants";
		await pane.search(true);
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
		searchBox.searchTextbox.value = "";
		await pane.search(true);
		step("cleared", { active: addon.search.active, rowCount: pane.itemsView.rowCount });
		Zotero.Prefs.set("search.quicksearch-mode", "fields");

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
	Zotero.Utilities.Internal.quit();
}
