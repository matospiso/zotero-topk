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
