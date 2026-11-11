import { test as bunTest } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';

import * as backendModule from '../bridge/server';
// SDK and Zotero mocks intentionally expose internals so failure paths can be injected.
const backendContext: any = backendModule;
type TestContext = { after: (cleanup: () => unknown | Promise<unknown>) => void };
function test(name: string, fn: (t: TestContext) => unknown): void;
function test(name: string, options: { skip: boolean }, fn: (t: TestContext) => unknown): void;
function test(name: string, options: { skip: boolean } | ((t: TestContext) => unknown), fn?: (t: TestContext) => unknown) {
 const run = typeof options === 'function' ? options : fn!;
 const register = typeof options === 'object' && options.skip ? bunTest.skip : bunTest;
 register(name, async () => {
  const cleanups: Array<() => unknown> = [];
  try { await run({ after: (cleanup) => { cleanups.push(cleanup); } }); }
  finally { for (const cleanup of cleanups) await cleanup(); }
 });
}
async function bundleAPI(dev = false) {
 const result = await Bun.build({ entrypoints: ['test/plugin-api.ts'], target: 'browser', format: 'cjs', define: { __DEV__: String(dev) } });
 if (!result.success) throw new AggregateError(result.logs, 'Test plugin bundle failed');
 return result.outputs[0].text();
}
const bundle = await bundleAPI();
const defer = <T = void>() => {
 let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
 const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
 return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));
async function until(predicate) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); } throw new Error('condition did not become true'); }

async function harness(t: TestContext, { backend = new backendContext.FakeBackend(), files = new Map<string, string>(), groupLocalID = 2, subprocess = {} }: { backend?: any; files?: Map<string, string>; groupLocalID?: number; subprocess?: any } = {}) {
 const prefs = new Map<string, any>(Object.entries({ apiKey: 'account-a', region: 'test', host: '', collection: 'pages', bridgeFake: true, uploadBatch: 1, autoIndex: false }).map(([k,v]) => ['extensions.zotero-topk.' + k,v]));
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
 const handlers: Record<string, string> = { '/configure': 'configure', '/status': 'status', '/upsert': 'upsert', '/manifest': 'manifest', '/delete': 'deleteAttachments', '/delete-library': 'deleteLibrary', '/search': 'search', '/images': 'images', '/attachment-status': 'hasAttachment' };
 bridge.request = async (_method, route, body) => { requests.push({ route, body }); return backend[handlers[route]](body); };
 const renderer: any = { calls: 0, destroy() {}, async renderPdf(_path, opts, onPage) { this.calls++; const count = Math.min(3, opts.maxPages); for (let page = 1; page <= count; page++) await onPage({ page, pageCount: 3, jpegB64: 'aW1hZ2U=' }); return { rendered: count, total: 3 }; } };
 renderer.renderHtml = (...args) => renderer.renderPdf(...args);
 const indexer = new api.Indexer(bridge, renderer); await indexer.start();
 t.after(async () => { indexer.stop(); await indexer.writes; for (const timer of timers.keys()) clearTimeout(timer); });
 const addItem = (libraryID = 1, key = 'ABCDEFGH', id = items.size + 1) => { const item = { id, libraryID, key, deleted: false, isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true, getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'fixture' }; items.set(id, item); return item; };
 const setPref = (k,v) => Zotero.Prefs.set('extensions.zotero-topk.' + k,v);
 const idle = () => until(() => !indexer.running && !indexer.queue.length && !indexer.deleting);
 return { ...api, Zotero, bridge, indexer, backend, renderer, files, prefs, addItem, setPref, idle, requests, items, timers };
}

test('destination state is isolated for collection, region, host, and API key and survives restart', async (t) => {
 const h = await harness(t); const item = h.addItem();
 for (const [pref, value] of [['collection', 'new-pages'], ['region','new-region'], ['host','topk.dev'], ['apiKey','account-b']]) {
  h.indexer.enqueue(item, false); await h.idle(); assert.equal(h.indexer.getState(item)?.status, 'ok');
  h.indexer.reconciled.add(1);
  h.setPref(pref, value);
  assert.equal(h.indexer.getState(item), undefined); assert.equal(h.indexer.reconciled.size, 0);
  await h.indexer.indexAllLibraries({ force: false }); await h.idle(); assert.equal(h.indexer.getState(item)?.status, 'ok');
 }
 await h.indexer.saveState(true);
 assert.ok(!h.files.get('/mock/topk-index-state.json').includes('account-'));
 const originalCalls = h.renderer.calls;
 h.setPref('collection','pages'); h.setPref('region','test'); h.setPref('host',''); h.setPref('apiKey','account-a');
 await h.indexer.indexAllLibraries({ force: false }); await h.idle(); assert.equal(h.renderer.calls, originalCalls);
 await h.indexer.saveState(true);
 const restarted = await harness(t, { backend: h.backend, files: h.files }); const restored = restarted.addItem();
 assert.equal(restarted.indexer.getState(restored)?.status, 'ok');
});

test('an empty reconciled destination is invalidated on change too', async (t) => {
 const h = await harness(t); await h.indexer.indexAllLibraries({ force: false });
 assert.equal(h.indexer.reconciled.size, 2); h.setPref('apiKey','other'); assert.equal(h.indexer.reconciled.size, 0);
});

test('interrupted upload has no completion marker and a fresh install retries it', async (t) => {
 const h = await harness(t); const item = h.addItem(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { if (body.docs.some((d) => d.page === 3)) throw new Error('injected upload failure'); return original(body); };
 h.indexer.enqueue(item, false); await h.idle();
 assert.equal(h.backend.docs.size, 1); assert.equal((await h.bridge.manifest(1)).rows.length, 0);
 assert.notEqual(h.indexer.getState(item)?.status, 'ok');
 h.backend.upsert = original;
 const fresh = await harness(t, { backend: h.backend }); const other = fresh.addItem();
 await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(fresh.indexer.getState(other)?.pages, 3); assert.equal(h.backend.docs.size, 3);
 assert.equal(h.backend.docs.get('user:17/ABCDEFGH/1').indexed_pages, 3);
});

test('manifest counts intentionally limited pages and skips rendering on another install', async (t) => {
 const h = await harness(t); h.setPref('maxPages',2); h.indexer.enqueue(h.addItem(), false); await h.idle();
 const fresh = await harness(t, { backend: h.backend }); const item = fresh.addItem();
 await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(fresh.renderer.calls,0); assert.equal(fresh.indexer.getState(item)?.pages,2); assert.equal(fresh.indexer.getState(item)?.totalPages,3);
});

for (const rebuild of [false,true]) test(`removal waits for outstanding uploads (${rebuild ? 'rebuild' : 'first index'})`, async (t) => {
 const h = await harness(t); const item = h.addItem();
 if (rebuild) { h.indexer.enqueue(item, false); await h.idle(); }
 const gate = defer(); const started = defer(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started.resolve(); await gate.promise; return original(body); };
 h.indexer.enqueue(item, true); await started.promise;
 item.deleted = true; const removal = h.indexer.remove(1,item.key);
 await tick(); assert.equal(h.indexer.getState(item), undefined);
 gate.resolve(); await removal; await h.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(h.indexer.getState(item), undefined);
 assert.equal(h.requests.filter((r) => r.route === '/upsert').at(-1).body.docs.some((d) => d.indexed_pages), false);
});

test('removal before the first rendered page prevents uploads', async (t) => {
 const h = await harness(t); const item = h.addItem(); const gate = defer(); const started = defer(); const render = h.renderer.renderPdf.bind(h.renderer);
 h.renderer.renderPdf = async (...args) => { started.resolve(); await gate.promise; return render(...args); };
 h.indexer.enqueue(item, false); await started.promise; item.deleted = true;
 const removal = h.indexer.remove(1,item.key); gate.resolve(); await removal; await h.idle();
 assert.equal(h.requests.filter((r) => r.route === '/upsert').length,0); assert.equal(h.indexer.getState(item),undefined);
});

test('failed rebuild is incomplete and an ordinary scan retries unchanged files', async (t) => {
 const h = await harness(t); const item = h.addItem(); h.indexer.enqueue(item, false); await h.idle();
 const render = h.renderer.renderPdf.bind(h.renderer); h.renderer.renderPdf = async () => { throw new Error('render failed'); };
 h.indexer.enqueue(item, true); await h.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(h.indexer.stats.attachments,0); assert.equal(h.indexer.getState(item)?.status,'failed');
 h.renderer.renderPdf = render; await h.indexer.indexAllLibraries({ force: false }); await h.idle();
 assert.equal(h.indexer.getState(item)?.status,'ok'); assert.equal(h.backend.docs.size,3);
});

test('failed deletion persists through restart and retries even when there is nothing to index', async (t) => {
 const h = await harness(t); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle(); item.deleted = true;
 const original = h.backend.deleteAttachments.bind(h.backend); h.backend.deleteAttachments = async () => { throw new Error('offline'); };
 await h.indexer.remove(1,item.key); assert.equal(h.indexer.pendingDeletes.length,1); assert.equal(h.indexer.getState(item),undefined);
 const fresh = await harness(t, { backend: h.backend, files: h.files });
 assert.equal(fresh.indexer.pendingDeletes.length,1);
 h.backend.deleteAttachments = original; await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(fresh.indexer.pendingDeletes.length,0);
});

test('pending deletions remain scoped to their destination when switching away and back', async (t) => {
 const h = await harness(t); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle();
 const oldDocs = h.backend.docs; const original = h.backend.deleteAttachments.bind(h.backend);
 h.backend.deleteAttachments = async () => { throw new Error('offline'); }; await h.indexer.remove(1,item.key);
 h.backend.deleteAttachments = original; h.setPref('collection','other');
 h.indexer.enqueue(item,false); await h.idle(); assert.equal(h.backend.docs.size,3); assert.equal(oldDocs.size,3);
 h.setPref('collection','pages'); item.deleted = true; await h.indexer.indexAllLibraries({ force: false }); await h.idle();
 assert.equal(oldDocs.size,0);
});

test('stable group identity deduplicates across installations and translates search hits', async (t) => {
 const h = await harness(t); h.indexer.enqueue(h.addItem(2),false); await h.idle();
 const other = await harness(t,{ backend: h.backend, groupLocalID: 98 }); const item = other.addItem(98);
 await other.indexer.indexAllLibraries({ force: false }); await other.idle(); assert.equal(other.renderer.calls,0);
 const hits = await other.bridge.search('fixture',{ libraryIDs:[98] }); assert.equal(hits.length,3); assert.equal(hits[0].library_id,98);
 other.indexer.enqueue(item,true); await other.idle(); assert.equal(h.backend.docs.size,3);
 await other.indexer.remove(98,item.key); assert.equal(h.backend.docs.size,0);
});

test('destination changes during upload neither redirect it nor adopt its state', async (t) => {
 const h = await harness(t); const item = h.addItem(); const gate = defer(); const started = defer(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started.resolve(); await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await started.promise; const oldDocs = h.backend.docs;
 h.setPref('collection','new'); const configuring = h.bridge.testConnection(); await tick(); assert.equal(h.backend.docs,oldDocs);
 gate.resolve(); await configuring; await h.idle(); assert.equal(h.indexer.getState(item),undefined); assert.equal(h.backend.docs.size,0);
 h.backend.upsert = original; await h.indexer.indexAllLibraries({ force: false }); await h.idle(); assert.equal(h.backend.docs.size,3);
});

test('leaving TopK mode invalidates the first pending search', async (t) => {
 const h = await harness(t); const item = h.addItem(); const gate = defer<any[]>(); const filters: unknown[] = [];
 const win = { document: { getElementById: (id) => id === 'zotero-tb-search' ? { searchTextbox: { value:'query' } } : null }, ZoteroPane: { getSelectedLibraryIDs: () => [1], itemsView: { setFilter: async (...args) => filters.push(args) } } };
 h.Zotero.getMainWindows = () => [win]; h.Zotero.Prefs.set('search.quicksearch-mode','topk');
 const search = new h.SearchIntegration({ search: () => gate.promise }); search.install();
 const pending = search.runSearch(win,true); h.Zotero.Prefs.set('search.quicksearch-mode','fields');
 gate.resolve([{ library_id:1, attachment_key:item.key, page:1, page_count:1, score:1 }]); await pending;
 assert.equal(search.active,false); assert.equal(search.results.size,0); assert.equal(filters.length,0);
});

test('successful connection setup restarts scanning only when automatic indexing is enabled', async (t) => {
 const h = await harness(t); let scans = 0;
 const addon = { bridge: { testConnection: async () => ({ configured:true }) }, indexer: { retryPendingDeletes: async () => {}, indexAllLibraries: async () => { scans++; } } };
 await h.TopKAddon.prototype.testConnection.call(addon); assert.equal(scans,0);
 h.setPref('autoIndex',true); await h.TopKAddon.prototype.testConnection.call(addon); assert.equal(scans,1);
 addon.bridge.testConnection = async () => { throw new Error('bad credentials'); };
 await assert.rejects(h.TopKAddon.prototype.testConnection.call(addon)); assert.equal(scans,1);
});

test('destroying item pane bodies removes their callbacks and unregister clears the remainder', async (t) => {
 const h = await harness(t); const pane = new h.ItemPaneSection(h.bridge,h.indexer,{}); pane.register();
 let first = 0, second = 0; const body = {}, other = {};
 h.Zotero.section.onInit({ body, refresh: () => first++ }); h.Zotero.section.onInit({ body:other, refresh: () => second++ });
 h.Zotero.section.onDestroy({ paneID:'section', doc:{}, body }); pane.refresh(); assert.equal(first,0); assert.equal(second,1);
 pane.unregister(); pane.refresh(); assert.equal(second,1);
});

for (const [label, local, remote] of [['local state remains', true, false], ['remote pages remain', false, true], ['bridge never responds', false, null]]) {
 test(`deletion self-test fails when ${label}`, async (t) => {
  const h = await harness(t);
  const addon = { indexer: { getState: () => local ? {} : undefined }, bridge: { hasAttachment: () => remote === null ? new Promise<never>(() => {}) : Promise.resolve(remote) } };
  await assert.rejects(h.verifyRemoval(addon, { libraryID:1, key:'ABCDEFGH' }, 10), /removal timed out/);
 });
}

test('deletion self-test passes only when local state and all remote pages are absent', async (t) => {
 const h = await harness(t);
 const result = await h.verifyRemoval({ indexer: { getState: () => undefined }, bridge: { hasAttachment: async () => false } }, { libraryID:1, key:'ABCDEFGH' }, 100);
 assert.equal(result.stillIndexed,false); assert.equal(result.remoteExists,false);
});

test('backend request ordering is scoped: uploads overlap, deletions wait for their attachment, configure waits for all', async () => {
 const { scheduled, SCOPE } = backendContext; const gate = defer(); const order: string[] = [];
 const upload = scheduled(SCOPE.upload, async ({ docs }) => { order.push(`upload ${docs[0].attachment_key} started`); await gate.promise; order.push(`upload ${docs[0].attachment_key} finished`); });
 const remove = scheduled(SCOPE.attachments, async ({ attachmentKeys }) => { order.push(`deleted ${attachmentKeys.join()}`); });
 const removeLibrary = scheduled(SCOPE.library, async ({ libraryKey }) => { order.push(`deleted ${libraryKey}`); });
 const configure = scheduled(SCOPE.all, async () => { order.push('configured'); });
 const doc = (key, library = 'user:17') => ({ docs: [{ library_key: library, attachment_key: key }] });
 // The HTTP caller can time out and stop awaiting an upload; the backend must still order deletions after it.
 const abandoned = upload(doc('A')); const other = upload(doc('B')); await tick();
 assert.deepEqual(order,['upload A started','upload B started']);
 const deletingA = remove({ libraryKey: 'user:17', attachmentKeys: ['A'] });
 const deletingC = remove({ libraryKey: 'user:17', attachmentKeys: ['C'] });
 const deletingGroup = removeLibrary({ libraryKey: 'group:42' });
 const laterA = upload(doc('A')); const configuring = configure({}); const afterConfigure = upload(doc('D'));
 await tick(); await tick();
 // Unrelated scopes proceed at once; A's deletion, the later A upload and the configure wait in order.
 assert.deepEqual(order,['upload A started','upload B started','deleted C','deleted group:42']);
 gate.resolve(); await Promise.all([abandoned, other, deletingA, deletingC, deletingGroup, laterA, configuring, afterConfigure]);
 assert.deepEqual(order.slice(4),['upload A finished','upload B finished','deleted A','upload A started','upload A finished','configured','upload D started','upload D finished']);
});

test('uploads of one attachment are in flight together and the next attachment renders while they drain', async (t) => {
 const h = await harness(t); const a = h.addItem(1,'AAAAAAAA'); const b = h.addItem(1,'BBBBBBBB');
 const gate = defer(); let started = 0; const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 h.indexer.enqueue(a,false); h.indexer.enqueue(b,false);
 await until(() => started >= 2); // pages 2 and 3 of A (uploadBatch 1) are sent without waiting for each other
 await until(() => h.renderer.calls === 2); // B is rendered while A's uploads are still outstanding
 assert.equal(h.indexer.getState(a)?.status,'partial'); assert.equal(h.backend.docs.size,0);
 gate.resolve(); await h.idle();
 assert.equal(h.indexer.getState(a)?.status,'ok'); assert.equal(h.indexer.getState(b)?.status,'ok'); assert.equal(h.backend.docs.size,6);
 const commits = h.requests.filter((r) => r.route === '/upsert' && r.body.docs.some((d) => d.indexed_pages));
 assert.deepEqual(commits.map((r) => r.body.docs[0].attachment_key),['AAAAAAAA','BBBBBBBB']);
});

test('a destination change waits for in-flight uploads and later requests wait for it', async (t) => {
 const h = await harness(t); const item = h.addItem(); const gate = defer(); let started = 0; const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await until(() => started >= 2);
 h.bridge.configured = false; const reconfigure = h.bridge.ensureReady(); const read = h.bridge.status(); await tick(); await tick();
 assert.equal(h.requests.filter((r) => r.route === '/configure').length,1); assert.equal(h.requests.filter((r) => r.route === '/status').length,0);
 gate.resolve(); await reconfigure; await read; await h.idle();
 assert.deepEqual(h.requests.filter((r) => r.route === '/configure' || r.route === '/status').map((r) => r.route),['/configure','/configure','/status']);
 assert.equal(h.indexer.getState(item)?.status,'ok');
});

test('reindexing the same attachment waits for its previous completion record', async (t) => {
 const h = await harness(t); const item = h.addItem(); const gate = defer();
 const original = h.backend.upsert.bind(h.backend); let started = 0;
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 const render = h.renderer.renderPdf.bind(h.renderer);
 h.renderer.renderPdf = async (...args) => {
  const result = await render(...args);
  if (h.renderer.calls === 1) h.indexer.enqueue(item, true);
  return result;
 };
 t.after(() => gate.resolve());
 h.indexer.enqueue(item, false); await until(() => started >= 2);
 await tick(); await tick();
 assert.equal(h.requests.filter((r) => r.route === '/delete').length, 1);
 gate.resolve(); await h.idle();
 const writes = h.requests.filter((r) => r.route === '/delete' || r.route === '/upsert');
 const commits = writes.flatMap((r, i) => r.body.docs?.some((d) => d.indexed_pages) ? [i] : []);
 const deletes = writes.flatMap((r, i) => r.route === '/delete' ? [i] : []);
 assert.equal(commits.length, 2); assert.equal(deletes.length, 2);
 assert.ok(commits[0] < deletes[1]);
 assert.equal(h.indexer.getState(item)?.status, 'ok');
});

test('uploadConcurrency bounds uploads across both pipelined attachments including commit records', async (t) => {
 const h = await harness(t); h.setPref('uploadConcurrency', 2);
 const gates: ReturnType<typeof defer<void>>[] = []; let active = 0, peak = 0;
 const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => {
  const gate = defer(); gates.push(gate); active++; peak = Math.max(peak, active);
  try { await gate.promise; return await original(body); } finally { active--; }
 };
 t.after(() => gates.forEach((gate) => gate.resolve()));
 h.indexer.enqueue(h.addItem(1, 'AAAAAAAA'), false);
 h.indexer.enqueue(h.addItem(1, 'BBBBBBBB'), false);
 await until(() => h.renderer.calls === 2); await tick();
 assert.equal(active, 2);
 for (let i = 0; i < 6; i++) { await until(() => gates.length > i); gates[i].resolve(); }
 await h.idle(); assert.equal(peak, 2); assert.equal(h.backend.docs.size, 6);
});

test('a draining document timeout does not destroy the next document renderer', async (t) => {
 const h = await harness(t); const a = h.addItem(1, 'AAAAAAAA'), b = h.addItem(1, 'BBBBBBBB');
 const uploadGate = defer(), renderGate = defer(); let destroyed = 0, secondRendering = false;
 const original = h.backend.upsert.bind(h.backend), render = h.renderer.renderPdf.bind(h.renderer);
 h.backend.upsert = async (body) => { await uploadGate.promise; return original(body); };
 h.renderer.destroy = () => { destroyed++; };
 h.renderer.renderPdf = async (...args) => {
  if (h.renderer.calls === 1) { secondRendering = true; await renderGate.promise; }
  return render(...args);
 };
 t.after(() => { uploadGate.resolve(); renderGate.resolve(); });
 h.indexer.enqueue(a, false); h.indexer.enqueue(b, false);
 await until(() => secondRendering);
 const timeout = [...h.timers.values()].find(({ ms }) => ms === 30 * 60000);
 assert.ok(timeout); timeout.fn(); await tick();
 assert.equal(destroyed, 0);
 // Cancel the expired job's retry so the test can drain without a real backoff delay.
 for (const job of h.indexer.activeJobs) if (job.key === a.key) job.signal.cancelled = true;
 uploadGate.resolve(); renderGate.resolve(); await h.idle();
 assert.equal(h.indexer.getState(b)?.status, 'ok');
 assert.notEqual(h.indexer.getState(a)?.status, 'ok');
});

test('helper read routes wait for configure and configure drains abandoned reads', async () => {
 const backend = new backendContext.FakeBackend();
 const context: any = { backend, routes: backendModule.createRoutes(backend) };
 const reads = [['GET /status', 'status'], ['POST /search', 'search'], ['POST /images', 'images'],
  ['POST /manifest', 'manifest'], ['POST /attachment-status', 'hasAttachment']];
 for (const [route, method] of reads) {
  const readGate = defer(), configGate = defer(), order: string[] = [];
  context.backend[method] = async () => { order.push('read'); await readGate.promise; };
  context.backend.configure = async () => { order.push('configure'); await configGate.promise; };
  const before = context.routes[route]({}); await tick();
  const configure = context.routes['POST /configure']({}); const after = context.routes[route]({});
  await tick(); assert.deepEqual(order, ['read'], route);
  readGate.resolve(); await before; await tick(); assert.deepEqual(order, ['read', 'configure'], route);
  configGate.resolve(); await Promise.all([configure, after]);
  assert.deepEqual(order, ['read', 'configure', 'read'], route);
 }
});

test('out-of-order upload responses keep the newest read fence without rounding u64 LSNs', async () => {
 const backend = new backendContext.TopKBackend(); const older = defer<string>(), newer = defer<string>();
 backend._sdk = () => ({ data: { image: (data) => ({ data }) } });
 backend.client = { collection: () => ({ upsert: (docs) => docs[0]._id === 'old' ? older.promise : newer.promise }) };
 const first = backend.upsert({ docs: [{ _id: 'old', page_image_b64: 'aW1hZ2U=' }] });
 const second = backend.upsert({ docs: [{ _id: 'new', page_image_b64: 'aW1hZ2U=' }] });
 newer.resolve('9007199254740993'); await second;
 older.resolve('9007199254740992'); await first;
 assert.equal(backend.readOptions().lsn, '9007199254740993');
 backend.recordLsn('10000000000000000'); assert.equal(backend.readOptions().lsn, '10000000000000000');
});

test('real backend uses stable scopes and completion markers, including partial-page deletion', async () => {
 const backend = new backendContext.TopKBackend();
 const documents = new Map(); const reads: any[] = [];
 class Expression {
  matches: (doc: any) => boolean;
  constructor(matches: (doc: any) => boolean) { this.matches = matches; }
  and(other) { return new Expression((doc) => this.matches(doc) && other.matches(doc)); }
 }
 const field = (key) => ({ key, eq: (v) => new Expression((d) => d[key] === v), gt: (v) => new Expression((d) => d[key] > v), in: (vs) => new Expression((d) => vs.includes(d[key])) });
 const select = (fields): any => ({ fields, filter(expr) { this.expr = expr; return this; }, sort(f, ascending) { this.sortField = f.key; this.ascending = ascending; return this; }, limit(n) { this.count = n; return this; } });
 backend._sdk = () => ({ query: { select, field }, data: { image: (data) => ({ data }) } });
 backend.client = { collection: () => ({
  query: async (q, options) => {
   reads.push(options);
   const rows = [...documents.values()].filter((doc) => q.expr.matches(doc));
   if (q.sortField) rows.sort((a,b) => String(a[q.sortField]).localeCompare(String(b[q.sortField])) * (q.ascending ? 1 : -1));
   return rows.slice(0,q.count);
  },
  delete: async (expr) => { for (const [id,doc] of documents) if (expr.matches(doc)) documents.delete(id); return '42'; },
 }) };
 documents.set('complete', { library_id:2, library_key:'group:42', attachment_key:'A', page:1, indexed_pages:2 });
 documents.set('partial', { library_id:2, library_key:'group:42', attachment_key:'B', page:2 });
 documents.set('legacy', { library_id:2, attachment_key:'C', page:1, page_count:20 });
 documents.set('foreign', { library_id:2, library_key:'group:99', attachment_key:'A', page:1, indexed_pages:2 });
 const result = await backend.manifest({ libraryKey:'group:42' });
 assert.deepEqual(Array.from(result.rows, (r: any) => r.attachment_key), ['A']);
 assert.equal((await backend.hasAttachment({ libraryKey:'group:42', attachmentKey:'B' })).exists,true);
 await backend.deleteAttachments({ libraryKey:'group:42', attachmentKeys:['A','B'] });
 assert.equal(documents.size,2); assert.equal(documents.has('foreign'),true); assert.equal(documents.has('legacy'),true);
 assert.equal((await backend.hasAttachment({ libraryKey:'group:42', attachmentKey:'B' })).exists,false);
 assert.equal(reads.at(-1).lsn,'42');
 await assert.rejects(backend.deleteLibrary({ libraryKey:2 }), /qualified Zotero library identity/);
});

test('startup retries persisted removals with automatic indexing disabled', async (t) => {
 const h = await harness(t); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle();
 const original = h.backend.deleteAttachments.bind(h.backend); h.backend.deleteAttachments = async () => { throw new Error('offline'); };
 await h.indexer.remove(1,item.key); h.backend.deleteAttachments = original;
 const restarted = await harness(t, { backend:h.backend, files:h.files }); await restarted.idle();
 assert.equal(restarted.renderer.calls,0); assert.equal(h.backend.docs.size,0);
});

test('group removal drains uploads and deletes using the stable group ID after the local library disappears', async (t) => {
 const h = await harness(t); const item = h.addItem(2); const gate = defer(); const started = defer(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started.resolve(); await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await started.promise;
 h.Zotero.Libraries.getAll().pop();
 const removal = h.indexer.removeLibrary(2,'group:42'); gate.resolve(); await removal; await h.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(h.indexer.stats.attachments,0);
});


test('release builds ignore the fake-backend preference and still require credentials', async (t) => {
 const h = await harness(t);
 assert.equal(h.destination().fake,false);
 h.setPref('apiKey','');
 await assert.rejects(h.bridge.ensureReady(), /No TopK API key/);
});

test('development builds retain the fake backend', async () => {
 const output = await bundleAPI(true);
 const context = vm.createContext({ module:{ exports:{} }, ChromeUtils:{ importESModule:() => ({}) }, Zotero:{ Prefs:{ get:(name) => name === 'extensions.zotero-topk.bridgeFake' ? true : undefined } } });
 vm.runInContext(output,context);
 assert.equal(context.module.exports.destination().fake,true);
});

for (const kind of ['real','fake']) test(`${kind} image responses stay below 8 MiB and still return ordinary thumbnails`, async () => {
 const backend = kind === 'real' ? new backendContext.TopKBackend() : new backendContext.FakeBackend();
 const bytes = Buffer.alloc(500 * 1024);
 const ids = Array.from({ length:60 }, (_,i) => `image-${i}`);
 if (kind === 'real') {
  backend.client = { collection:() => ({ get:async (requested) => {
   assert.equal(requested.length,50);
   return Object.fromEntries(requested.map((id) => [id, { page_image:{ format:'jpeg', data:bytes } }]));
  } }) };
 } else {
  await backend.upsert({ docs:ids.map((_id) => ({ _id, page_image_b64:bytes.toString('base64') })) });
 }
 const result = await backend.images({ ids });
 assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024);
 assert.ok(Object.keys(result.images).length > 0);
 assert.ok(Object.keys(result.images).length < ids.length);
 assert.equal(result.images['image-0'].b64,bytes.toString('base64'));
});

for (const script of ['e2e.ts','run-zotero.ts']) test(`${script} rejects command-line API keys without echoing them`, () => {
 const secret = 'never-provisioned-test-key';
 for (const args of [['--apikey',secret],[`--apikey=${secret}`]]) {
  const result = spawnSync(process.execPath,[`scripts/${script}`,...args], { encoding:'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status,2);
  assert.match(result.stderr,/use TOPK_API_KEY/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
 }
});

test('dev launcher tightens existing profile and credential-file permissions', { skip:process.platform === 'win32' }, (t) => {
 const dir = mkdtempSync(path.join(tmpdir(),'topk-profile-test-'));
 t.after(() => rmSync(dir,{ recursive:true, force:true }));
 const profile = path.join(dir,'profile'); const userPrefs = path.join(profile,'user.js');
 mkdirSync(profile); chmodSync(profile,0o777); writeFileSync(userPrefs,'old preferences'); chmodSync(userPrefs,0o666);
 const result = spawnSync(process.execPath,['scripts/run-zotero.ts','--dev-dir',dir], {
  env:{ ...process.env, ZOTERO_BIN:'/bin/true', TOPK_API_KEY:'never-provisioned-test-key' }, encoding:'utf8',
 });
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stderr);
 assert.equal(statSync(profile).mode & 0o777,0o700);
 assert.equal(statSync(userPrefs).mode & 0o777,0o600);
 assert.ok(readFileSync(userPrefs,'utf8').includes('never-provisioned-test-key'));
});

test('Bun discovery validates the runtime and minimum version without inheriting environment options', async (t) => {
 const calls: any[] = []; let version = '1.4.4'; let exitCode = 0;
 const h = await harness(t, { subprocess: { call: async (options) => {
  calls.push(options); let read = false;
  return { stdout: { readString: async () => { if (read) return ''; read = true; return version + '\n'; } }, wait: async () => ({ exitCode }) };
 } } });
 assert.equal(await h.bridge.bunVersion('/bun'), '1.4.4');
 version = '1.4.3'; assert.equal(await h.bridge.bunVersion('/bun'), null);
 version = 'v22.0.0'; assert.equal(await h.bridge.bunVersion('/node'), null);
 version = '1.4.4'; exitCode = 1; assert.equal(await h.bridge.bunVersion('/broken'), null);
 assert.deepEqual(Array.from(calls[0].arguments), ['--no-env-file', '-e', 'console.log(Bun.version)']);
 assert.equal(calls[0].environmentAppend, false);
 assert.equal(calls[0].environment.HOME, '/mock/home');
 assert.equal(calls[0].environment.BUN_OPTIONS, undefined);
});

test('Bun installation uses a frozen lockfile and invalidates the old npm or changed-lock stamp', async (t) => {
 const calls: any[] = []; let exitCode = 0;
 const h = await harness(t, { subprocess: { call: async (options) => {
  calls.push(options); return { stdout: { readString: async () => '' }, wait: async () => ({ exitCode }) };
 } } });
 h.Zotero.ProgressWindow = class { changeHeadline() {} addDescription() {} show() {} startCloseTimer() {} };
 h.bridge.bunPath = '/bun'; h.bridge.bridgeDir = '/mock/bridge';
 h.files.set('/mock/bridge/package.json', JSON.stringify({ dependencies: { 'topk-js': '0.16.1' } }));
 h.files.set('/mock/bridge/node_modules/topk-js/package.json', '{}');
 h.files.set('/mock/bridge/bun.lock', 'first-lock'); h.files.set('/mock/bridge/.installed', 'test:0.16.1:ci');
 await h.bridge.installDependencies(); assert.equal(calls.length, 1);
 assert.deepEqual(Array.from(calls[0].arguments), ['install', '--no-env-file', '--frozen-lockfile', '--production', '--ignore-scripts', '--no-progress']);
 assert.equal(calls[0].command, '/bun');
 await h.bridge.installDependencies(); assert.equal(calls.length, 1);
 const stamp = h.files.get('/mock/bridge/.installed');
 h.files.set('/mock/bridge/bun.lock', 'changed-lock'); exitCode = 1;
 await assert.rejects(h.bridge.installDependencies(), /Bun install failed/);
 assert.equal(h.files.get('/mock/bridge/.installed'), stamp);
 exitCode = 0; await h.bridge.installDependencies(); assert.notEqual(h.files.get('/mock/bridge/.installed'), stamp);
});
