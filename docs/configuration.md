# Configuration

[Back to README](../README.md)

Open **Zotero Settings → TopK Semantic Search** to set your API key, region,
collection, and Node.js executable. Use **Test connection** before indexing.
Advanced preferences use the `extensions.zotero-topk.` prefix in Zotero's config editor.

## Preferences

| key | default | meaning |
| --- | --- | --- |
| `apiKey` | – | TopK API key |
| `region` | `aws-us-east-1-elastica` | TopK region |
| `host` | – (topk.io) | advanced: API host; the endpoint is `https://<region>.api.<host>` |
| `collection` | `zotero-pages` | collection name (created if missing) |
| `nodePath` | auto | Node.js executable |
| `autoIndex` | `true` | index new/changed attachments automatically |
| `indexSnapshots` | `true` | include HTML snapshots (printed to A4 pages) |
| `maxPages` | `500` | pages per document |
| `maxFileMB` | `200` | attachments larger than this are skipped |
| `docTimeoutMinutes` | `30` | give up on a document that takes longer than this |
| `maxEdge` / `jpegQuality` | `1536` / `85` | page image size and quality (images are re‑encoded to stay under TopK's 512 KB image limit) |
| `resultLimit` | `60` | page hits per search |
| `renderConcurrency` | `8` | pages rendered concurrently |
| `uploadBatch` | `8` | pages per upload request (also bounded by payload size) |
| `uploadConcurrency` | `4` | upload requests in flight across documents, including completion records (clamped to 1–16) |

The `debug` preference enables detailed logging. `bridgeFake` and `selftest` are
for development builds only; production builds ignore them.

## Troubleshooting

- **Helper not found:** run `node --version`, then select the Node.js executable in
  settings. Zotero launched from a desktop may have a different PATH from a shell.
- **Connection failed:** check the region, collection, API key, and network access.
  The first run also needs network access to install the TopK SDK.
- **Indexing stalled:** the indexer cancels a document after four minutes without
  progress and retries within its limits. Size, page, and total-time limits are
  configurable above.
- **Debug output:** enable Debug in plugin settings, then use **Help → Debug
  Output Logging → View Output**. Plugin messages are prefixed with `[TopK]`.

Include the plugin, Zotero, Node.js, and operating-system versions when
[reporting a bug](https://github.com/matospiso/zotero-topk/issues/new). Remove API
keys and private document contents from reports.
