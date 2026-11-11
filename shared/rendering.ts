export const MAX_IMAGE_BYTES = 500 * 1024; // TopK's per-image limit is 512 KB.

export interface RenderedPage {
	page: number;
	pageCount: number;
	jpegB64: string;
}

export interface RenderOptions {
	maxEdge: number;
	quality: number;
	maxBytes: number;
	maxPages: number;
	maxFileBytes: number;
	concurrency: number;
	signal?: { cancelled: boolean };
}

export type ContentRenderOptions = Omit<RenderOptions, "signal" | "maxFileBytes"> & { isCancelled: () => boolean };
export interface RenderResult { rendered: number; total: number }
