import { delay } from "./prefs";
import { log, logError, debug, errorMessage } from "./log";

export interface RenderedPage {
	page: number;
	pageCount: number;
	width: number;
	height: number;
	bytes: number;
	quality: number;
	jpegB64: string;
}

export interface RenderOptions {
	maxEdge: number;
	quality: number; // 1-100
	maxBytes: number;
	maxPages: number;
	maxFileBytes: number;
	concurrency?: number;
	signal?: { cancelled: boolean };
}

const RENDERER_URL = "resource://zotero-topk/content/renderer.html";
// Gecko sandbox flags (same values Zotero's HiddenBrowser uses)
const SANDBOXED_ORIGIN = 0x10;
const SANDBOXED_SCRIPTS = 0x80;

/**
 * Turns attachments into page images. PDFs are rendered by the plugin's bundled
 * pdf.js inside a hidden, content-privileged <browser> (never with chrome
 * privileges); HTML snapshots are first printed to a temporary PDF (so "pages"
 * are real printed pages, with scripts disabled) and then rendered the same way.
 */
export class Renderer {
	private browser: any = null;
	private loading: Promise<any> | null = null;

	private contentWindow(): any {
		const cw = this.browser?.contentWindow;
		return cw && !cw.closed && this.browser.isConnected ? cw : null;
	}

	private async getApi(): Promise<any> {
		const cw = this.contentWindow();
		const api = cw?.wrappedJSObject?.TopKRenderer;
		if (api) return api;
		if (!this.loading) {
			this.loading = this.createFrame().finally(() => { this.loading = null; });
		}
		return this.loading;
	}

	private async createFrame(): Promise<any> {
		this.destroy();
		const win = Zotero.getMainWindow();
		if (!win) throw new Error("No main window available for rendering");
		const doc = win.document;
		// type="content" without "remote": an in-process content docshell, like Zotero's own
		// reader. The resource:// page gets a content principal, so a parser bug cannot reach
		// chrome APIs; the bytes are handed in with cloneInto below.
		const browser = doc.createXULElement("browser");
		browser.setAttribute("type", "content");
		browser.setAttribute("disableglobalhistory", "true");
		browser.setAttribute("src", RENDERER_URL);
		browser.id = "zotero-topk-renderer";
		browser.style.cssText = "position:fixed; left:-10000px; top:0; width:8px; height:8px; opacity:0; pointer-events:none;";
		doc.documentElement.appendChild(browser);
		this.browser = browser;
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const api = this.contentWindow()?.wrappedJSObject?.TopKRenderer;
			if (api) {
				const principal = browser.contentPrincipal;
				debug(`renderer frame ready (${principal?.isSystemPrincipal ? "SYSTEM principal!" : principal?.origin || "content principal"})`);
				if (principal?.isSystemPrincipal) {
					this.destroy();
					throw new Error("renderer frame unexpectedly has chrome privileges; refusing to render");
				}
				return api;
			}
			await delay(50);
		}
		this.destroy();
		throw new Error("Renderer frame did not initialize");
	}

	destroy() {
		try { this.browser?.remove(); } catch (e) {}
		this.browser = null;
	}

	onWindowUnload(win: any) {
		if (this.browser && this.browser.ownerDocument?.defaultView === win) this.destroy();
	}

	private async checkSize(path: string, maxFileBytes: number) {
		const stat = await IOUtils.stat(path);
		if (stat.size > maxFileBytes) {
			throw new Error(`file is ${(stat.size / 1048576).toFixed(0)} MB, above the ${Math.round(maxFileBytes / 1048576)} MB limit (extensions.zotero-topk.maxFileMB)`);
		}
	}

	async renderPdf(path: string, opts: RenderOptions, onPage: (p: RenderedPage) => Promise<void> | void) {
		await this.checkSize(path, opts.maxFileBytes);
		const api = await this.getApi();
		const cw = this.contentWindow();
		if (!cw) throw new Error("renderer frame is gone");
		const Cu = Components.utils;
		const bytes = await IOUtils.read(path);
		const { signal, ...plain } = opts;
		const data = Cu.cloneInto(bytes, cw);
		const contentOpts = Cu.cloneInto({ ...plain, isCancelled: () => !!signal?.cancelled }, cw, { cloneFunctions: true });
		// The callback runs with chrome privileges but only copies plain values out of the content
		// object. Content code cannot touch a chrome Promise, so the result is handed back through
		// a promise created in the content compartment.
		const callback = Cu.exportFunction((p: any) => {
			const page: RenderedPage = {
				page: Number(p.page),
				pageCount: Number(p.pageCount),
				width: Number(p.width),
				height: Number(p.height),
				bytes: Number(p.bytes),
				quality: Number(p.quality),
				jpegB64: String(p.jpegB64),
			};
			return new cw.Promise((resolve: (v?: unknown) => void, reject: (e: unknown) => void) => {
				Promise.resolve().then(() => onPage(page)).then(
					() => resolve(),
					(e) => reject(new cw.Error(errorMessage(e)))
				);
			});
		}, cw);
		const result = await api.renderPdf(data, contentOpts, callback);
		return { rendered: Number(result.rendered), total: Number(result.total) };
	}

	async renderHtml(path: string, opts: RenderOptions, onPage: (p: RenderedPage) => Promise<void> | void) {
		await this.checkSize(path, opts.maxFileBytes);
		const tmpDir = Zotero.getTempDirectory().path;
		const pdfPath = PathUtils.join(tmpDir, `topk-${Zotero.Utilities.randomString(8)}.pdf`);
		try {
			await this.printToPdf(Zotero.File.pathToFileURI(path), pdfPath);
			return await this.renderPdf(pdfPath, opts, onPage);
		}
		finally {
			try { await IOUtils.remove(pdfPath, { ignoreAbsent: true }); } catch (e) {}
		}
	}

	private async printToPdf(fileURI: string, pdfPath: string) {
		const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");
		// useHiddenFrame: false is required for printing (per Zotero's HiddenBrowser).
		const browser = new HiddenBrowser({ useHiddenFrame: false, blockRemoteResources: true });
		try {
			// The snapshot is untrusted HTML: give it a unique origin and no script before it loads.
			await browser._createdPromise;
			browser.browsingContext.sandboxFlags |= SANDBOXED_ORIGIN | SANDBOXED_SCRIPTS;
			const ok = await browser.load(fileURI);
			if (!ok) throw new Error(`could not load ${fileURI} for printing`);
			const printTimeout = delay(180000).then(() => { throw new Error("printing the snapshot timed out"); });
			// Give layout and local images a moment to settle.
			await delay(750);
			const Ci = Components.interfaces;
			const settings = Components.classes["@mozilla.org/gfx/printsettings-service;1"]
				.getService(Ci.nsIPrintSettingsService).createNewPrintSettings();
			// Property names differ slightly across Gecko versions; apply what exists.
			const assign = (props: Record<string, unknown>) => {
				for (const [k, v] of Object.entries(props)) {
					try { settings[k] = v; }
					catch (e) { debug(`print setting ${k} not supported: ${errorMessage(e)}`); }
				}
			};
			assign({
				outputFormat: Ci.nsIPrintSettings.kOutputFormatPDF,
				outputDestination: Ci.nsIPrintSettings.kOutputDestinationFile,
				toFileName: pdfPath,
				printSilent: true,
				showPrintProgress: false,
				printBGColors: true,
				printBGImages: true,
				shrinkToFit: true,
				paperSizeUnit: Ci.nsIPrintSettings.kPaperSizeInches,
				paperWidth: 8.27, // A4
				paperHeight: 11.69,
				headerStrLeft: "", headerStrCenter: "", headerStrRight: "",
				footerStrLeft: "", footerStrCenter: "", footerStrRight: "",
			});
			await Promise.race([browser.browsingContext.print(settings), printTimeout]);
			if (!(await IOUtils.exists(pdfPath))) throw new Error("printing produced no PDF");
			log(`printed snapshot to ${pdfPath}`);
		}
		catch (e) {
			logError("printToPdf", e);
			throw e;
		}
		finally {
			try { browser.destroy(); } catch (e) {}
		}
	}
}
