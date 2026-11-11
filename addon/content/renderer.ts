// Runs inside a content-privileged <browser> (origin resource://zotero-topk), NOT with chrome
// privileges: a malformed PDF can only reach this page and its worker. The privileged side
// (src/renderer.ts) reads the file, hands the bytes in, and receives page images back through
// an exported callback. pdf.js is bundled with the plugin (content/pdfjs/) so everything the
// parser fetches is same-origin.
import { MAX_IMAGE_BYTES, type RenderedPage, type ContentRenderOptions } from "../../shared/rendering";
import { DEFAULT_PREFS } from "../../shared/preferences";
declare global { interface Window { TopKRenderer: { renderPdf: typeof renderPdf } } }

import * as pdfjsLib from "pdfjs-dist";

const PDF_BASE = new URL("./pdfjs/", import.meta.url).href;
let workerPort: Worker | null = null;

function ensureWorker() {
	if (!workerPort) {
		// Create the worker ourselves (and hand pdf.js the port) so pdf.js does not try
		// its same-origin / CDN-wrapper logic against the resource:// URL.
		workerPort = new Worker(PDF_BASE + "pdf.worker.mjs", { type: "module" });
		pdfjsLib.GlobalWorkerOptions.workerPort = workerPort;
	}
}

function toBlob(canvas: HTMLCanvasElement, quality: number) {
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function blobToBase64(blob: Blob) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number, maxBytes: number) {
	let current = canvas;
	let q = quality;
	for (let attempt = 0; attempt < 12; attempt++) {
		const blob = await toBlob(current, q);
		if (!blob) throw new Error("JPEG encoding failed");
		if (blob.size <= maxBytes) {
			return blob;
		}
		if (q > 0.6) {
			q = Math.max(0.55, q - 0.1);
		}
		else {
			const next = document.createElement("canvas");
			next.width = Math.max(64, Math.round(current.width * 0.85));
			next.height = Math.max(64, Math.round(current.height * 0.85));
			next.getContext("2d")!.drawImage(current, 0, 0, next.width, next.height);
			current = next;
			q = quality;
		}
	}
	throw new Error("could not fit page image under " + maxBytes + " bytes");
}

async function renderPdf(data: Uint8Array, opts: ContentRenderOptions, onPage: (page: RenderedPage) => Promise<void>) {
	ensureWorker();
	const maxEdge = Math.max(256, Math.min(4096, opts.maxEdge || DEFAULT_PREFS.maxEdge));
	const quality = Math.max(0.3, Math.min(1, (opts.quality || DEFAULT_PREFS.jpegQuality) / 100));
	const maxBytes = opts.maxBytes || MAX_IMAGE_BYTES;
	const maxPages = Math.max(1, opts.maxPages || DEFAULT_PREFS.maxPages);
	const concurrency = Math.max(1, Math.min(16, opts.concurrency || DEFAULT_PREFS.renderConcurrency));
	const isCancelled = typeof opts.isCancelled === "function" ? opts.isCancelled : () => false;
	const task = pdfjsLib.getDocument({
		data,
		cMapUrl: PDF_BASE + "cmaps/",
		cMapPacked: true,
		standardFontDataUrl: PDF_BASE + "standard_fonts/",
		wasmUrl: PDF_BASE + "wasm/",
		iccUrl: PDF_BASE + "iccs/",
		verbosity: 0,
	});
	const doc = await task.promise;
	const total = doc.numPages;
	const count = Math.min(total, maxPages);
	let next = 1;
	let rendered = 0;
	let failure: unknown = null;
	const cancelled = () => failure || isCancelled();

	async function lane() {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d", { alpha: false })!;
		try {
			while (!cancelled()) {
				const i = next++;
				if (i > count) return;
				const page = await doc.getPage(i);
				try {
					const base = page.getViewport({ scale: 1 });
					const scale = maxEdge / Math.max(base.width, base.height);
					const viewport = page.getViewport({ scale });
					canvas.width = Math.max(1, Math.round(viewport.width));
					canvas.height = Math.max(1, Math.round(viewport.height));
					ctx.fillStyle = "#ffffff";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
					// intent "print": full quality and no requestAnimationFrame pacing
					// (rAF is throttled in hidden frames, which made rendering crawl).
					await page.render({ canvas, canvasContext: ctx, viewport, intent: "print", background: "#ffffff" }).promise;
					const jpeg = await encodeJpeg(canvas, quality, maxBytes);
					const b64 = await blobToBase64(jpeg);
					if (cancelled()) return;
					rendered++;
					await onPage({
						page: i,
						pageCount: total,
						jpegB64: b64,
					});
				}
				finally {
					page.cleanup();
				}
			}
		}
		catch (e) {
			failure = failure || e;
		}
		finally {
			canvas.width = canvas.height = 1;
		}
	}

	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, count) }, lane));
	}
	finally {
		await doc.destroy();
	}
	if (failure) throw failure;
	return { rendered, total };
}

window.TopKRenderer = { renderPdf };
