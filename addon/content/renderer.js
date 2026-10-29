// Runs inside a hidden, system-principal iframe in the Zotero main window.
// Renders PDF pages to JPEG using the pdf.js build that ships with Zotero's reader,
// so rendering matches what the user sees and nothing extra has to be bundled.
import * as pdfjsLib from "resource://zotero/reader/pdf/build/pdf.mjs";

const PDF_BASE = "resource://zotero/reader/pdf/";
let workerPort = null;

function ensureWorker() {
	if (!workerPort) {
		// Create the worker ourselves (and hand pdf.js the port) so pdf.js does not try
		// its same-origin / CDN-wrapper logic against the resource:// URL.
		workerPort = new Worker(PDF_BASE + "build/pdf.worker.mjs", { type: "module" });
		pdfjsLib.GlobalWorkerOptions.workerPort = workerPort;
	}
}

function toBlob(canvas, quality) {
	return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * Encode a canvas as JPEG, lowering quality and then resolution until the
 * result fits under `maxBytes` (TopK caps images at 512 KB).
 */
async function encodeJpeg(canvas, quality, maxBytes) {
	let current = canvas;
	let q = quality;
	for (let attempt = 0; attempt < 12; attempt++) {
		const blob = await toBlob(current, q);
		if (!blob) throw new Error("JPEG encoding failed");
		if (blob.size <= maxBytes) {
			return { blob, quality: q, width: current.width, height: current.height };
		}
		if (q > 0.6) {
			q = Math.max(0.55, q - 0.1);
		}
		else {
			const next = document.createElement("canvas");
			next.width = Math.max(64, Math.round(current.width * 0.85));
			next.height = Math.max(64, Math.round(current.height * 0.85));
			next.getContext("2d").drawImage(current, 0, 0, next.width, next.height);
			current = next;
			q = quality;
		}
	}
	throw new Error("could not fit page image under " + maxBytes + " bytes");
}

async function renderPdf(path, opts, onPage) {
	ensureWorker();
	const maxEdge = opts.maxEdge || 1536;
	const quality = (opts.quality || 85) / 100;
	const maxBytes = opts.maxBytes || 500 * 1024;
	const maxPages = opts.maxPages || Infinity;
	const concurrency = Math.max(1, Math.min(16, opts.concurrency || 8));
	const data = await IOUtils.read(path);
	const task = pdfjsLib.getDocument({
		data,
		cMapUrl: PDF_BASE + "web/cmaps/",
		cMapPacked: true,
		standardFontDataUrl: PDF_BASE + "web/standard_fonts/",
		wasmUrl: PDF_BASE + "web/wasm/",
		iccUrl: PDF_BASE + "web/iccs/",
		isEvalSupported: false,
		verbosity: 0,
	});
	const doc = await task.promise;
	const total = doc.numPages;
	const count = Math.min(total, maxPages);
	let next = 1;
	let rendered = 0;
	let failure = null;
	const cancelled = () => failure || (opts.signal && opts.signal.cancelled);

	// Each lane owns one canvas and pulls page numbers from a shared counter, so
	// worker-side parsing, main-thread painting and JPEG encoding overlap across pages.
	async function lane() {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d", { alpha: false });
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
					await page.render({ canvasContext: ctx, viewport, intent: "print", background: "#ffffff" }).promise;
					const jpeg = await encodeJpeg(canvas, quality, maxBytes);
					const b64 = await blobToBase64(jpeg.blob);
					if (cancelled()) return;
					rendered++;
					await onPage({
						page: i,
						pageCount: total,
						width: jpeg.width,
						height: jpeg.height,
						bytes: jpeg.blob.size,
						quality: jpeg.quality,
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

window.TopKRenderer = { version: 1, renderPdf };
