import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { harness, bundleAPI } from './support/plugin-harness';
import { defer } from './support/async';
import { cleanup } from './support/cleanup';

afterEach(cleanup);

test('Node discovery rejects old runtimes and falls back to a compatible installation', async () => {
 let configuredVersion = 'v18.20.8';
 let fallbackVersion: string | null = null;
 const h = await harness({ subprocess: {
  pathSearch: async () => '/mock/fallback-node',
  call: async ({ command }) => {
   let output = command === '/mock/configured-node' ? configuredVersion : fallbackVersion;
   return { stdout: { readString: async () => { const chunk = output; output = null; return chunk; } }, wait: async () => ({ exitCode: 0 }) };
  },
 } });
 h.setPref('nodePath', '/mock/configured-node');
 h.files.set('/mock/configured-node', '');
 h.files.set('/mock/fallback-node', '');
 for (const version of ['v18.20.8', 'v20.20.0', 'v22.12.0', 'v22.13.0-rc.1', 'not a Node version']) {
  configuredVersion = version;
  await assert.rejects(h.bridge.findNode(), /Node.js 22\.13\.0 or newer was not found.*Settings/);
 }
 configuredVersion = 'v20.20.0';
 fallbackVersion = 'v22.13.0\n';
 assert.equal(await h.bridge.findNode(), '/mock/fallback-node');
 for (const version of ['v22.13.0', 'v22.22.2', 'v24.0.0']) {
  configuredVersion = version;
  assert.equal(await h.bridge.findNode(), '/mock/configured-node');
 }
});

test('leaving TopK mode invalidates the first pending search', async () => {
 const h = await harness(); const item = h.addItem(); const gate = defer<any[]>(); const filters: unknown[] = [];
 const win = { document: { getElementById: (id) => id === 'zotero-tb-search' ? { searchTextbox: { value:'query' } } : null }, ZoteroPane: { getSelectedLibraryIDs: () => [1], itemsView: { setFilter: async (...args) => filters.push(args) } } };
 h.Zotero.getMainWindows = () => [win]; h.Zotero.Prefs.set('search.quicksearch-mode','topk');
 const search = new h.SearchIntegration({ search: () => gate.promise }); search.install();
 const pending = search.runSearch(win,true); h.Zotero.Prefs.set('search.quicksearch-mode','fields');
 gate.resolve([{ library_id:1, attachment_key:item.key, page:1, page_count:1, score:1 }]); await pending;
 assert.equal(search.active,false); assert.equal(search.results.size,0); assert.equal(filters.length,0);
});

test('successful connection setup restarts scanning only when automatic indexing is enabled', async () => {
 const h = await harness(); let scans = 0;
 const addon = { bridge: { testConnection: async () => ({ configured:true }) }, indexer: { retryPendingDeletes: async () => {}, indexAllLibraries: async () => { scans++; } } };
 await h.TopKAddon.prototype.testConnection.call(addon); assert.equal(scans,0);
 h.setPref('autoIndex',true); await h.TopKAddon.prototype.testConnection.call(addon); assert.equal(scans,1);
 addon.bridge.testConnection = async () => { throw new Error('bad credentials'); };
 await assert.rejects(h.TopKAddon.prototype.testConnection.call(addon)); assert.equal(scans,1);
});

test('destroying item pane bodies removes their callbacks and unregister clears the remainder', async () => {
 const h = await harness(); const pane = new h.ItemPaneSection(h.bridge,h.indexer,{}); pane.register();
 let first = 0, second = 0; const body = {}, other = {};
 h.Zotero.section.onInit({ body, refresh: () => first++ }); h.Zotero.section.onInit({ body:other, refresh: () => second++ });
 h.Zotero.section.onDestroy({ paneID:'section', doc:{}, body }); pane.refresh(); assert.equal(first,0); assert.equal(second,1);
 pane.unregister(); pane.refresh(); assert.equal(second,1);
});

for (const [label, local, remote] of [['local state remains', true, false], ['remote pages remain', false, true], ['bridge never responds', false, null]]) {
 test(`deletion self-test fails when ${label}`, async () => {
  const h = await harness();
  const addon = { indexer: { getState: () => local ? {} : undefined }, bridge: { hasAttachment: () => remote === null ? new Promise<never>(() => {}) : Promise.resolve(remote) } };
  await assert.rejects(h.verifyRemoval(addon, { libraryID:1, key:'ABCDEFGH' }, 10), /removal timed out/);
 });
}

test('deletion self-test passes only when local state and all remote pages are absent', async () => {
 const h = await harness();
 const result = await h.verifyRemoval({ indexer: { getState: () => undefined }, bridge: { hasAttachment: async () => false } }, { libraryID:1, key:'ABCDEFGH' }, 100);
 assert.equal(result.stillIndexed,false); assert.equal(result.remoteExists,false);
});

test('development builds retain the fake backend', async () => {
 const output = await bundleAPI(true);
 const context = vm.createContext({ module:{ exports:{} }, ChromeUtils:{ importESModule:() => ({}) }, Zotero:{ Prefs:{ get:(name) => name === 'extensions.zotero-topk.bridgeFake' ? true : undefined } } });
 vm.runInContext(output,context);
 assert.equal(context.module.exports.destination().fake,true);
});


test('self-test fails when the main window or quick-search controls are unavailable', async () => {
 const h = await harness();
 for (const win of [undefined, { ZoteroPane: { itemsView: {} }, document: { getElementById: () => null } }]) {
  h.Zotero.getMainWindow = () => win;
  await assert.rejects(h.waitForMainWindow(0), /quick-search UI did not become ready/);
 }
});

test('self-test waits for the ready main window instead of a fixed startup delay', async () => {
 const h = await harness();
 const win = { ZoteroPane: { itemsView: {} }, document: { getElementById: () => ({ searchTextbox: {} }) } };
 let checks = 0;
 h.Zotero.getMainWindow = () => ++checks > 1 ? win : undefined;
 assert.equal(await h.waitForMainWindow(1000), win);
});
