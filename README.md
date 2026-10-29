# TopK Semantic Search for Zotero

A Zotero plugin that makes the **pages** of your PDFs and web snapshots
searchable by meaning, using [TopK](https://www.topk.io/)'s built‑in semantic
index on images (visual document retrieval). Every page is rendered to a JPEG
(longest edge 1536 px, quality 85) and upserted into a TopK collection; a
search sends your text to TopK and gets back the best matching pages.

## How it fits into Zotero

- **Automatic ingest** – new or changed PDF / HTML‑snapshot attachments are
  rendered and uploaded in the background (a progress popup shows what is
  happening). Trashed/deleted attachments are removed from the index.
  On startup the plugin reconciles with the collection and indexes anything
  missing.
- **Search bar mode** – the quick‑search dropdown gets a *TopK semantic
  (pages)* mode. Type a query and the items list is filtered to the matching
  items with a sortable **TopK score** column.
- **"TopK pages" item‑pane section** – for the selected item it lists the
  best matching pages with thumbnails; clicking a page opens the PDF reader
  at that page. Outside a search it shows the index status and an *Index now*
  button.
- **Tools ▸ TopK Semantic Search** menu and item context‑menu entries to
  index / re‑index / remove items, and a settings pane (API key, region,
  collection, Node.js path, indexing options, *Test connection*).

## Architecture

```
Zotero (Gecko)                                   Node.js helper (bridge/server.js)
┌──────────────────────────────┐   localhost     ┌──────────────────────────────┐
│ indexer ─► renderer          │  HTTP + token   │  topk-js (official JS SDK)   │
│   PDF  → Zotero's pdf.js     │ ──────────────► │  collection "zotero-pages"   │
│   HTML → print-to-PDF → pdf.js│  JSON/base64   │  page_image: image()         │
│ quick search / item pane     │ ◄────────────── │     .index(semanticIndex())   │
└──────────────────────────────┘                 └──────────────────────────────┘
```

TopK's JavaScript SDK is a native Node module, which Zotero's Gecko runtime
cannot load. The plugin therefore starts a tiny helper process with Node.js
(auto‑detected, or set in settings), installs `topk-js` into
`<Zotero data dir>/topk-bridge/` on first run, and talks to it over
`127.0.0.1` with a per‑session bearer token. All TopK reads and writes go
through the SDK in that process.

One TopK document per page:

| field            | type                               |
| ---------------- | ---------------------------------- |
| `_id`            | `"<libraryID>/<attachmentKey>/<page>"` |
| `page_image`     | `image().required().index(semanticIndex())` |
| `library_id`     | `int()`                            |
| `attachment_key` | `text()`                           |
| `item_key`       | `text()` (parent item, or the attachment itself) |
| `page`, `page_count` | `int()`                        |
| `title`          | `text()`                           |
| `file_hash`      | `text()` (sha256 of the file, used to skip unchanged files) |

Search: `select({score: fn.semanticSimilarity("page_image", query), …}).filter(field("library_id").in(ids)).sort(field("score"), false).limit(n)`.

## Requirements

- Zotero 7 or later (developed and tested with Zotero 10.0.6).
- Node.js 18+ on the machine (https://nodejs.org). npm is used once to
  install the SDK into the helper directory.
- A TopK account and API key (https://console.topk.io).

## Install

1. Download `zotero-topk-<version>.xpi` (or build it, see below).
2. Zotero ▸ Tools ▸ Plugins ▸ ⚙ ▸ *Install Plugin From File…*
3. Settings ▸ *TopK Semantic Search*: paste the API key, pick the region
   (and optionally a collection name), click *Test connection*.
4. Indexing of existing libraries starts automatically (or use
   *Index new documents now*). Pick *TopK semantic (pages)* in the search
   bar's mode menu and search.

## Development

```sh
npm install
npm run build            # → build/addon + build/zotero-topk-<version>.xpi
export ZOTERO_BIN=/path/to/zotero
npm start                # dev build + launch Zotero with a throwaway profile (.zotero-dev/)
node scripts/run-zotero.mjs --headless --fake   # in-memory fake backend, no API key needed
npm run e2e              # headless end-to-end test with the fake backend
TOPK_API_KEY=… node scripts/e2e.mjs --real --collection zotero-e2e            # against TopK
TOPK_API_KEY=… node scripts/e2e.mjs --real --region strawberry --host topk.dev  # against a dev deployment
```

`scripts/e2e.mjs` imports a PDF and an HTML snapshot, waits for indexing,
searches through the real quick‑search code path, checks the item pane data,
and verifies that trashing an attachment removes it from the index. It reads
`TOPK_API_KEY` / `TOPK_REGION` / `TOPK_HOST` from a local `.env` file (git‑ignored)
if present. Any PDFs dropped into `test/papers/` (git‑ignored) are imported too and
the probe queries in `test/queries.json` are run against them, saving the top
hit of each as `q<i>.jpg` in the e2e output directory.

### Layout

```
addon/      manifest, bootstrap, preferences pane, hidden renderer frame, icons, locale
src/        plugin code (TypeScript, bundled by esbuild into addon/content/zotero-topk.js)
bridge/     Node.js helper that wraps topk-js (copied to the Zotero data dir at runtime)
scripts/    build, dev launcher, headless e2e
test/       fixtures and probe queries
```

### Troubleshooting

- Enable *Debug* in the plugin settings, then Help ▸ Debug Output Logging ▸
  View Output. All plugin messages are prefixed with `[TopK]`.
- *Test connection* fails with "Node.js not found": install Node 18+ or set
  the path in settings.
- Indexing stalls: a watchdog cancels a document after 4 minutes without
  progress and retries it; the debug log shows which document and page.

## Preferences (`extensions.zotero-topk.*`)

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
| `maxEdge` / `jpegQuality` | `1536` / `85` | page image size and quality (images are re‑encoded to stay under TopK's 512 KB image limit) |
| `resultLimit` | `60` | page hits per search |
