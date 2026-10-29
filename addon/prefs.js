// Default preferences for the TopK Semantic Search plugin.
pref("extensions.zotero-topk.apiKey", "");
pref("extensions.zotero-topk.region", "aws-us-east-1-elastica");
// Advanced: API host; empty = TopK production (topk.io). Endpoint is https://<region>.api.<host>
pref("extensions.zotero-topk.host", "");
pref("extensions.zotero-topk.collection", "zotero-pages");
pref("extensions.zotero-topk.nodePath", "");
pref("extensions.zotero-topk.autoIndex", true);
pref("extensions.zotero-topk.indexSnapshots", true);
pref("extensions.zotero-topk.maxPages", 500);
pref("extensions.zotero-topk.maxEdge", 1536);
pref("extensions.zotero-topk.jpegQuality", 85);
pref("extensions.zotero-topk.resultLimit", 60);
// Pages rendered concurrently, and pages per upsert request
pref("extensions.zotero-topk.renderConcurrency", 8);
pref("extensions.zotero-topk.uploadBatch", 8);
pref("extensions.zotero-topk.debug", false);
// Development only: run the bridge with an in-memory fake instead of TopK.
pref("extensions.zotero-topk.bridgeFake", false);
// Development only: path of a JSON file to write self-test results to.
pref("extensions.zotero-topk.selftest", "");
