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
	concurrency?: number;
	signal?: { cancelled: boolean };
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Turns attachments into page images. PDFs are rendered by Zotero's bundled
 * pdf.js inside a hidden chrome iframe; HTML snapshots are first printed to a
 * temporary PDF (so "pages" are real printed pages) and then rendered the same way.
 */
export class Renderer {
	private iframe: any = null;
	private api: any = null;
	private loading: Promise<any> | null = null;

	private async getApi(): Promise<any> {
		if (this.api && this.iframe?.contentWindow && !this.iframe.contentWindow.closed && this.iframe.isConnected) {
			return this.api;
		}
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
		const iframe = doc.createElementNS(XHTML_NS, "iframe");
		iframe.id = "zotero-topk-renderer";
		iframe.setAttribute("src", "chrome://zotero-topk/content/renderer.html");
		iframe.style.cssText = "position:fixed; left:-10000px; top:0; width:8px; height:8px; opacity:0; pointer-events:none;";
		doc.documentElement.appendChild(iframe);
		this.iframe = iframe;
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const api = iframe.contentWindow?.TopKRenderer;
			if (api) {
				this.api = api;
				return api;
			}
			await delay(50);
		}
		this.destroy();
		throw new Error("Renderer frame did not initialize");
	}

	destroy() {
		try { this.iframe?.remove(); } catch (e) {}
		this.iframe = null;
		this.api = null;
	}

	onWindowUnload(win: any) {
		if (this.iframe && this.iframe.ownerDocument?.defaultView === win) this.destroy();
	}

	async renderPdf(path: string, opts: RenderOptions, onPage: (p: RenderedPage) => Promise<void> | void) {
		const api = await this.getApi();
		return api.renderPdf(path, opts, onPage) as Promise<{ rendered: number; total: number }>;
	}

	async renderHtml(path: string, opts: RenderOptions, onPage: (p: RenderedPage) => Promise<void> | void) {
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
