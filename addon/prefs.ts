// Default preferences for the TopK Semantic Search plugin.
pref("extensions.zotero-topk.apiKey", "");
pref("extensions.zotero-topk.region", "aws-us-east-1-elastica");
// Advanced: API host; empty = TopK production (topk.io). Endpoint is https://<region>.api.<host>
pref("extensions.zotero-topk.host", "");
pref("extensions.zotero-topk.collection", "zotero-pages");
pref("extensions.zotero-topk.bunPath", "");
pref("extensions.zotero-topk.autoIndex", true);
pref("extensions.zotero-topk.indexSnapshots", true);
pref("extensions.zotero-topk.maxPages", 500);
// Attachments larger than this are skipped (the whole file is read into memory for rendering)
pref("extensions.zotero-topk.maxFileMB", 200);
// Give up on a document that takes longer than this to render and upload
pref("extensions.zotero-topk.docTimeoutMinutes", 30);
pref("extensions.zotero-topk.maxEdge", 1536);
pref("extensions.zotero-topk.jpegQuality", 85);
pref("extensions.zotero-topk.resultLimit", 60);
// Pages rendered concurrently, pages per upsert request, and upsert requests in flight at once
pref("extensions.zotero-topk.renderConcurrency", 8);
pref("extensions.zotero-topk.uploadBatch", 8);
pref("extensions.zotero-topk.uploadConcurrency", 4);
pref("extensions.zotero-topk.debug", false);
// Development only: run the bridge with an in-memory fake instead of TopK.
pref("extensions.zotero-topk.bridgeFake", false);
// Development only: path of a JSON file to write self-test results to.
pref("extensions.zotero-topk.selftest", "");
