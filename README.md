# Visual Document Search for Zotero (powered by TopK)

[![Build](https://github.com/matospiso/zotero-topk/actions/workflows/build.yml/badge.svg)](https://github.com/matospiso/zotero-topk/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Search the **pages** of your PDFs and saved web snapshots by meaning, directly
inside Zotero. The plugin renders pages as images and uses
[TopK](https://www.topk.io/) to find the pages that match your query.

For example, search for "diagram explaining the reranker architecture", then
open a matching paper and jump to the relevant PDF page.

> TopK includes **$10 in free credits** to get started. Text and image embeddings
> cost **$0.05 per million input tokens**, and storage costs **$0.10 per GiB per
> month**. Writes, queries, and data retrieval also incur charges; see
> [current pricing](https://www.topk.io/pricing).
>
> Automatic indexing is off by default. Choose which attachments to index, or
> opt in to automatic indexing of your personal and group libraries (see
> [Getting started](#getting-started)).

[Getting started](#getting-started) · [Configuration](docs/configuration.md) ·
[Privacy](#network-use-and-privacy) ·
[Development](docs/development.md) · [Architecture](docs/architecture.md) ·
[Contributing](CONTRIBUTING.md)

## See it in action

Search is all about the details. **"Mirror selfie at the gym"** finds a tiny
thumbnail inside a phone screenshot embedded in a PDF page, among hundreds of
papers in a Zotero library.

https://github.com/user-attachments/assets/4086a475-1531-47c2-b51a-605267efbf77

More examples: ["Loss curve … with a sudden spike"](#loss-curve-with-a-sudden-spike)
· [Various results for "kernels"](#various-results-for-kernels).

## Features

- **Page-level search:** a *TopK semantic (pages)* mode in Zotero's search bar,
  with a sortable relevance-score column.
- **Visual results:** a *TopK pages* item-pane section with thumbnails and links
  that open PDFs at the matching page.
- **Optional background indexing:** automatically index new and changed
  PDF/snapshot attachments; trashed and deleted attachments are removed from the index.
- **Index management:** settings and menu actions to check connectivity, index
  selected attachments, rebuild a library, and remove indexed items.

## Requirements

- **Zotero 10.0.x** (tested with 10.0.9). Earlier versions lack the search-filter API
  used by this plugin.
- **[Node.js 22.13.0+](https://nodejs.org/) and npm** for the local helper process.
  Use the latest patch of a supported LTS release; Node.js 18 and 20 are end-of-life.
- **[A TopK account and API key](https://console.topk.io/)**, plus network access.

Node.js runs the helper and development tooling. The helper uses TopK's native SDK, which cannot load inside Zotero's Gecko
runtime. See [runtime boundaries](docs/architecture.md#runtime-boundaries).

## Getting started

1. Open the [latest release](https://github.com/matospiso/zotero-topk/releases/latest)
   and download `zotero-topk-<version>.xpi` from **Assets**.
2. In Zotero, open **Tools → Plugins → ⚙ → Install Plugin From File…** and select
   `zotero-topk-<version>.xpi`.
3. Open **Settings → TopK Semantic Search**. **Automatically index new PDFs and
   snapshots** is off by default. Enable it only if you want automatic indexing,
   including existing attachments in your personal and group libraries.
4. Enter your API key, region, and collection, then click **Test connection**.
   The helper installs its pinned SDK on first use. If automatic indexing is
   enabled, a successful connection starts indexing your libraries. Otherwise,
   select attachments, right-click, and choose **TopK: Index Selected Items**.
5. Once pages are indexed, select **TopK semantic (pages)** in the search bar's
   mode menu and enter a query. Open a result's **TopK pages** section and click
   a page to jump to it in the PDF.

If Node.js cannot be discovered, select its executable in settings.

## More examples

### Loss curve with a sudden spike

Start with **"loss curve"**, then add **"with a sudden spike"**. The top result
changes from a smooth training-loss plot to a figure with a sharp spike.

https://github.com/user-attachments/assets/7c1810d6-4336-4b36-aec2-1be6e76de38b

### Various results for "kernels"

A longer walkthrough (about 1.5 minutes): search in plain words, compare TopK
scores, and jump from a matching page thumbnail straight into the PDF.

https://github.com/user-attachments/assets/dd2c39e5-5ddb-4fab-a8eb-22318b8c9e49

## Indexing behavior and limits

Automatic indexing is off by default. Existing explicitly saved settings are
preserved on upgrade; check the setting if you used an earlier version.

With automatic indexing enabled, the plugin checks existing libraries at startup
and indexes new or changed PDF and snapshot attachments. **Index new documents
now** scans all personal and group libraries, skipping attachments whose content
has not changed since successful indexing. Rebuilding re-renders and re-uploads
attachments, incurring usage again. Trashing or deleting attachments in Zotero
removes their indexed pages; failed remote deletions are queued for retry.

By default, only the first **500 pages per document** are indexed, and attachments
larger than **200 MB** are skipped. Saved HTML snapshots are rendered as A4 pages.
Check indexing progress and errors in the plugin's settings; see
[Configuration](docs/configuration.md) for limits and controls.

## Network use and privacy

The plugin uploads an image of each indexed page to your configured TopK
collection, together with its title (which can include a filename), Zotero
library/user/group and item identifiers, page numbers and counts, and a file
content hash. TopK stores the page images and metadata for search. Query text is
also sent to TopK. Review what your documents contain before indexing them.

Your API key is stored as a Zotero preference in your local profile. The local
helper connects to your configured TopK endpoint; on first use it also downloads
the pinned SDK and platform packages from npm. Zotero checks for plugin updates
on GitHub. See [data handling](docs/architecture.md#security-and-data-handling)
for implementation details.

**TopK: Remove Selected Items from Index** removes selected attachments' remote
entries, but a later indexing run can upload them again. Uninstalling the plugin
cleans up local settings and index state; it does **not** delete the TopK
collection. To remove all uploaded data from a collection dedicated to this
plugin, disable or uninstall the plugin, then delete that collection in TopK.

## Development

Install Node.js 22.13.0 or newer from a supported LTS release, npm, and the `zip`/`unzip` command-line tools, then:

```sh
npm ci
npm ci --prefix bridge --ignore-scripts
npm run check
```

This runs type checks, behavioral tests, and an XPI build. The output is
`build/zotero-topk-<version>.xpi`.

CI runs the same checks and publishes the resulting XPI for testing.

See the [development guide](docs/development.md) for a disposable Zotero profile,
end-to-end tests, fixtures, and release instructions.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and testing
expectations. Report bugs and propose changes through
[GitHub Issues](https://github.com/matospiso/zotero-topk/issues).

For setup failures, start with the
[troubleshooting guide](docs/configuration.md#troubleshooting). Include relevant
versions and sanitized logs in reports.

## License

[MIT](LICENSE). Bundled third-party dependencies retain their own licenses.
