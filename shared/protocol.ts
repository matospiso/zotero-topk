export interface SearchHit {
	_id: string;
	library_id: number;
	library_key: string;
	attachment_key: string;
	item_key: string;
	page: number;
	page_count: number;
	title: string;
	score: number;
}

export interface PageDoc {
	indexed_pages?: number;
	_id: string;
	library_id: number;
	library_key: string;
	attachment_key: string;
	item_key: string;
	page: number;
	page_count: number;
	title: string;
	file_hash: string;
	page_image_b64: string;
}

export interface ManifestRow {
	indexed_pages: number;
	attachment_key: string;
	library_id: number;
	library_key: string;
	file_hash: string;
	page_count: number;
}

export interface ConfigureRequest { apiKey: string; region: string; collection: string; host?: string }
export interface UpsertRequest { docs: PageDoc[] }
export interface SearchRequest { query: string; limit?: number; libraryKeys: string[] }
export interface ImagesRequest { ids: string[] }
export interface DeleteRequest { libraryKey: string; attachmentKeys: string[] }
export interface LibraryRequest { libraryKey: string }
export interface AttachmentRequest extends LibraryRequest { attachmentKey: string }
export interface PageImage { format: string; b64: string }

export const BRIDGE_READY_PREFIX = "TOPK_BRIDGE_READY ";
export interface BridgeReady { port: number; version: string; fake: boolean }

export interface BridgeRequests {
	"/health": undefined;
	"/status": undefined;
	"/configure": ConfigureRequest;
	"/upsert": UpsertRequest;
	"/search": SearchRequest;
	"/images": ImagesRequest;
	"/delete": DeleteRequest;
	"/delete-library": LibraryRequest;
	"/manifest": LibraryRequest;
	"/attachment-status": AttachmentRequest;
}

export interface BridgeStatus {
	configured: boolean;
	collection?: string | null;
	region?: string | null;
	host?: string | null;
	docCount?: number | null;
	fake?: boolean;
}

export interface BridgeResponses {
	"/health": { ok: true; version: string; fake: boolean; configured: boolean };
	"/status": BridgeStatus;
	"/configure": { ok: true; created: boolean; collection: string; region: string; host?: string | null; fake?: boolean };
	"/upsert": { ok: true; lsn: string; count: number };
	"/search": { hits: SearchHit[] };
	"/images": { images: Record<string, PageImage> };
	"/delete": { ok: true; deleted: number };
	"/delete-library": { ok: true; libraryKey: string };
	"/manifest": { rows: ManifestRow[]; complete: boolean };
	"/attachment-status": { exists: boolean };
}

export type BridgePath = keyof BridgeRequests;
export type BridgeMethod<P extends BridgePath> = P extends "/health" | "/status" ? "GET" : "POST";
export type BridgeRoutes = {
	[P in BridgePath as `${BridgeMethod<P>} ${P}`]: (body: BridgeRequests[P]) => BridgeResponses[P] | Promise<BridgeResponses[P]>;
};
