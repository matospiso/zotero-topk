# Contributing

Thanks for helping improve TopK Semantic Search for Zotero.

## Before making a change

Search [existing issues](https://github.com/topk-io/zotero-topk/issues) first. For
large behavior or architecture changes, describe the problem and proposed
approach in an issue so the scope can be discussed.

The [development guide](docs/development.md) covers installation, local Zotero
profiles, tests, and releases. The [architecture guide](docs/architecture.md)
explains the boundaries between Zotero, the renderer, and the helper.

## Pull requests

- Keep each PR focused on one change and describe the observable behavior it
  changes.
- Use TypeScript for maintained source. Keep generated bundles, XPI files,
  credentials, local profiles, and private test documents out of commits.
- Put shared wire contracts and preference definitions in `shared/`, so changes
  are checked on both sides of a runtime boundary.
- Add regression coverage for changed behavior, particularly indexing order,
  cancellation, and deletion. Prefer externally observable results over private
  implementation details.
- Run `npm run check` before submitting.
- Describe manual Zotero testing, including the version and operating system,
  and identify anything you could not test.

## Bug reports

Include reproduction steps, expected and actual behavior, plugin/Zotero/Node.js/OS
versions, and relevant debug output. Remove API keys and private document data.
For rendering problems, provide a minimal shareable document when possible.

## License

This project is distributed under the [MIT License](LICENSE).
