import { TopKAddon } from "./addon";

// `rootURI` and `pluginVersion` are provided by bootstrap.js via the loadSubScript scope.
declare const rootURI: string;
declare const pluginVersion: string;

if (!Zotero.TopK) {
	Zotero.TopK = new TopKAddon(rootURI, pluginVersion);
}
