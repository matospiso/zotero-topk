# TopK Semantic Search for Zotero

[![Build](https://github.com/topk-io/zotero-topk/actions/workflows/build.yml/badge.svg)](https://github.com/topk-io/zotero-topk/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Search the **pages** of your PDFs and saved web snapshots by meaning, directly
inside Zotero. The plugin renders pages as images and uses
[TopK](https://www.topk.io/) to find the pages that match your query.

[Getting started](#getting-started) · [Configuration](docs/configuration.md) ·
[Development](docs/development.md) · [Architecture](docs/architecture.md) ·
[Contributing](CONTRIBUTING.md)

## Features

- **Page-level search:** a *TopK semantic (pages)* mode in Zotero's search bar,
  with a sortable relevance-score column.
- **Visual results:** a *TopK pages* item-pane section with thumbnails and links
  that open PDFs at the matching page.
- **Background indexing:** new and changed PDF/snapshot attachments are indexed
  automatically; trashed and deleted attachments are removed from the index.
- **Index management:** settings and menu actions to check connectivity, index
  selected attachments, rebuild a library, and remove indexed items.

## Requirements

- **Zotero 7–10.0.x**, matching the versions declared in the plugin manifest.
- **[Node.js 22.13.0+](https://nodejs.org/) and npm** for the local helper process.
  Use the latest patch of a supported LTS release; Node.js 18 and 20 are end-of-life.
- **[A TopK account and API key](https://console.topk.io/)**, plus network access.

Node.js runs the helper and development tooling. The helper uses TopK's native SDK, which cannot load inside Zotero's Gecko
runtime. See [runtime boundaries](docs/architecture.md#runtime-boundaries).

Pages are uploaded as images to your configured TopK collection. Query text is
also sent to TopK; this is not an offline search engine. See
[data handling](docs/architecture.md#security-and-data-handling) before indexing
private documents.

## Getting started

1. Download an XPI from [Releases](https://github.com/topk-io/zotero-topk/releases)
   when available, or use a successful
   [Test and build XPI run](https://github.com/topk-io/zotero-topk/actions/workflows/build.yml).
   Each run has a **Download the XPI** link in its summary; CI downloads require
   GitHub sign-in and expire after 30 days. You can also [build from source](docs/development.md).
2. In Zotero, open **Tools → Plugins → ⚙ → Install Plugin From File…** and select
   `zotero-topk-<version>.xpi`.
3. Open **Settings → TopK Semantic Search**. Enter your API key, region, and
   collection, then click **Test connection**. The helper installs its pinned SDK
   on first use.
4. Existing libraries begin indexing automatically. Select **TopK semantic
   (pages)** in the search bar's mode menu and enter a query.

If Node.js cannot be discovered, select its executable in settings.

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
[GitHub Issues](https://github.com/topk-io/zotero-topk/issues).

For setup failures, start with the
[troubleshooting guide](docs/configuration.md#troubleshooting). Include relevant
versions and sanitized logs in reports.

## License

[MIT](LICENSE). Bundled third-party dependencies retain their own licenses.
