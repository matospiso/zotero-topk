import { build } from "esbuild";
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { FakeBackend } from '../../bridge/backend';
import { createRoutes } from '../../bridge/server';
import { onCleanup } from './cleanup';
import { until } from './async';

export async function bundleAPI(dev = false) {
 const result = await build({ entryPoints: ['test/plugin-api.ts'], bundle: true, platform: 'browser', format: 'cjs', write: false, define: { __DEV__: String(dev) } });
 return result.outputFiles[0].text;
}
const bundle = await bundleAPI();

export async function harness({ backend = new FakeBackend(), files = new Map<string, string>(), groupLocalID = 2, subprocess = {} }: { backend?: any; files?: Map<string, string>; groupLocalID?: number; subprocess?: any } = {}) {
 const prefs = new Map<string, any>(Object.entries({ apiKey: 'account-a', region: 'test', host: '', collection: 'pages', bridgeFake: true, uploadBatch: 1 }).map(([k,v]) => ['extensions.zotero-topk.' + k,v]));
 const observers = new Map(); const timers = new Map(); const items = new Map();
 const libraries = [{ libraryID: 1, libraryType: 'user' }, { libraryID: groupLocalID, libraryType: 'group' }];
 const Zotero: any = {
  Prefs: { get: (k) => prefs.get(k), set(k, v) { prefs.set(k,v); for (const [name, fn] of observers.values()) if (name === k) fn(v); }, registerObserver(k, fn) { const id = {}; observers.set(id,[k,fn]); return id; }, unregisterObserver: (id) => observers.delete(id) },
  Libraries: { userLibraryID: 1, get: (id) => libraries.find((l) => l.libraryID === id), getAll: () => libraries },
  Users: { getCurrentUserID: () => 17, getLocalUserKey: () => 'localABC' }, Groups: { getGroupIDFromLibraryID: () => 42 },
  Items: { get: (id) => Array.isArray(id) ? id.map((i) => items.get(i)) : items.get(Number(id)), getAll: async (id) => [...items.values()].filter((i) => i.libraryID === id && !i.deleted), getByLibraryAndKey: (id, key) => [...items.values()].find((i) => i.libraryID === id && i.key === key) },
  Utilities: { Internal: { md5: (v) => createHash('md5').update(v).digest('hex') } },
  DataDirectory: { dir: '/mock' }, Notifier: { registerObserver: () => 'observer', unregisterObserver() {} }, debug() {}, logError() {}, getMainWindows: () => [],
  ItemTreeManager: { registerColumn: () => 'score', unregisterColumn() {} },
  ItemPaneManager: { registerSection: (opts) => { Zotero.section = opts; return 'section'; }, unregisterSection() {} },
  Search: class { addCondition() {} },
 };
 const context = vm.createContext({ module: { exports: {} }, Zotero, ChromeUtils: { importESModule: () => ({ Subprocess: subprocess }) }, PathUtils: path,
  Services: { env: { get: (key) => key === 'HOME' ? '/mock/home' : '' } },
  IOUtils: { exists: async (p) => files.has(p), readUTF8: async (p) => files.get(p), writeUTF8: async (p, v) => { files.set(p,v); }, computeHexDigest: async () => 'hash' },
  setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.set(timer, { fn, ms }); return timer; },
  clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
 });
 vm.runInContext(bundle, context);
 const api: any = context.module.exports; const bridge = new api.Bridge('', 'test'); const requests: Array<{ route: string; body: any }> = [];
 bridge.ensureRunning = async () => {};
 const routes = createRoutes(backend);
 bridge.request = async (method, route, body) => { requests.push({ route, body }); return routes[`${method} ${route}`](body); };
 const renderer: any = { calls: 0, destroy() {}, async renderPdf(_path, opts, onPage) { this.calls++; const count = Math.min(3, opts.maxPages); for (let page = 1; page <= count; page++) await onPage({ page, pageCount: 3, jpegB64: 'aW1hZ2U=' }); return { rendered: count, total: 3 }; } };
 renderer.renderHtml = (...args) => renderer.renderPdf(...args);
 const indexer = new api.Indexer(bridge, renderer); await indexer.start();
 onCleanup(async () => { indexer.stop(); await indexer.writes; for (const timer of timers.keys()) clearTimeout(timer); });
 const addItem = (libraryID = 1, key = 'ABCDEFGH', id = items.size + 1) => { const item = { id, libraryID, key, deleted: false, isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true, getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'fixture' }; items.set(id, item); return item; };
 const setPref = (k,v) => Zotero.Prefs.set('extensions.zotero-topk.' + k,v);
 const idle = () => until(() => !indexer.running && !indexer.queue.length && !indexer.deleting);
 return { ...api, Zotero, bridge, indexer, backend, renderer, files, prefs, addItem, setPref, idle, requests, items, timers };
}
