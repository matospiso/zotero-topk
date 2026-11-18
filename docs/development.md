# Development

[Back to README](../README.md)

## Setup and checks

Use the latest patch of a supported Node.js LTS release (minimum 22.13.0) and npm,
and install `zip` and `unzip`. The packaged helper has the same Node.js minimum;
development scripts run through `tsx`.

```sh
npm ci
npm ci --prefix bridge --ignore-scripts
npm run typecheck
npm test
npm run build
```

`npm run check` runs all three checks. The test suite
loads the native TopK SDK and starts the packaged helper, without API credentials
or a live TopK connection. Its regression tests cover concurrency, cancellation,
destination changes, deletion, search, and helper authorization.

Zotero receives compiled JavaScript because its plugin loader cannot execute
TypeScript; generated files stay under ignored `build/`. The packaged helper is
also compiled to JavaScript, so end users do not need `tsx` or TypeScript.

## Run in Zotero

```sh
export ZOTERO_BIN=/path/to/zotero
npm start
```

On macOS, the executable is inside `Zotero.app/Contents/MacOS/`. The launcher uses
a disposable profile and data directory under `.zotero-dev/`. It refuses external
profile/data paths unless `--allow-external-dirs` is supplied: development
preferences disable add-on signing and enable debugging.

To exercise the plugin without TopK, build in development mode and use the fake
backend:

```sh
npm run dev
npx tsx scripts/run-zotero.ts --fake
```

Production builds ignore the fake-backend and self-test preferences.

## End-to-end tests

End-to-end tests require an installed Zotero executable. They import a PDF and
HTML snapshot, index them, exercise quick search and the item pane, and verify
that trashing an attachment removes its local and remote index entries.

```sh
npm run e2e
npx tsx scripts/e2e.ts --xpi
npx tsx scripts/e2e.ts --real --collection zotero-e2e
```

Use a dedicated collection for live tests. Supply `TOPK_API_KEY` through the
environment or a local `.env` file, loaded by the end-to-end test runner. `TOPK_REGION` and `TOPK_HOST` can also be supplied there or through
`--region` / `--host`. Command-line API keys are rejected to keep them out of
process listings. Keep `.env` private (`chmod 600 .env`) and untracked.

The launcher writes logs and a JSON report to `.zotero-dev/e2e/`. `--keep` retains
the temporary profile/data for inspection; `--no-papers` skips optional PDFs from
`test/papers/`. Probe queries in `test/queries.json` save their top hits as
`q<i>.jpg` in the report directory.

Unit and package tests use mocks for Zotero APIs. A passing suite does not replace
manual UI testing in the Zotero versions and operating systems you support.

## Build and release

`npm run build` produces `build/addon/` and an installable XPI. The build bundles
the helper into one `server.js`, with `topk-js` external and installed by npm from
its lockfile. Bootstrap callbacks remain visible to Zotero's script loader.

To prepare a release:

1. Update the root `package.json` version. The build propagates it to the plugin
   manifest and packaged helper.
2. Run `npm run check` and test the XPI in Zotero.
3. Run `npx tsx scripts/release.ts` to rebuild the XPI and generate `update.json` with
   its SHA-256 hash and immutable release-asset URL.
4. Commit the version and update manifest, tag `v<version>`, create the GitHub
   release, and upload `build/zotero-topk-<version>.xpi`.

Publish the exact XPI whose hash is in `update.json`; rebuilding it afterward may
change the archive bytes. Installed plugins fetch `update.json` from `main`, so
review changes to that file carefully and protect the branch.

`npx tsx scripts/make-icons.ts` regenerates the committed PNG icons when needed.
