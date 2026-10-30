import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';

const bundle = (await build({ stdin: { contents: `export * from './src/indexer'; export * from './src/bridge'; export * from './src/search'; export * from './src/itemPane'; export * from './src/addon'; export * from './src/library'; export * from './src/selftest';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', define: { __DEV__: 'false' } })).outputFiles[0].text;
const backendContext = vm.createContext({ require: createRequire(new URL('../bridge/server.js', import.meta.url)), process: { env: { TOPK_BRIDGE_TOKEN: 'x'.repeat(32) } }, console, Buffer, setTimeout });
vm.runInContext(readFileSync('bridge/server.js', 'utf8').split('const backend = FAKE')[0] + '\nglobalThis.FakeBackend = FakeBackend; globalThis.TopKBackend = TopKBackend; globalThis.serializeMutation = serializeMutation;', backendContext);
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));
async function until(predicate) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); } throw new Error('condition did not become true'); }

async function harness(t, { backend = new backendContext.FakeBackend(), files = new Map(), groupLocalID = 2 } = {}) {
 const prefs = new Map(Object.entries({ apiKey: 'account-a', region: 'test', host: '', collection: 'pages', bridgeFake: true, uploadBatch: 1, autoIndex: false }).map(([k,v]) => ['extensions.zotero-topk.' + k,v]));
 const observers = new Map(); const timers = new Set(); const items = new Map();
 const libraries = [{ libraryID: 1, libraryType: 'user' }, { libraryID: groupLocalID, libraryType: 'group' }];
 const Zotero = {
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
 const context = vm.createContext({ module: { exports: {} }, Zotero, ChromeUtils: { importESModule: () => ({}) }, PathUtils: path,
  IOUtils: { exists: async (p) => files.has(p), readUTF8: async (p) => files.get(p), writeUTF8: async (p, v) => { files.set(p,v); }, computeHexDigest: async () => 'hash' },
  setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
 });
 vm.runInContext(bundle, context);
 const api = context.module.exports; const bridge = new api.Bridge('', 'test'); const requests = [];
 bridge.ensureRunning = async () => {};
 const handlers = { '/configure': 'configure', '/status': 'status', '/upsert': 'upsert', '/manifest': 'manifest', '/delete': 'deleteAttachments', '/delete-library': 'deleteLibrary', '/search': 'search', '/images': 'images', '/attachment-status': 'hasAttachment' };
 bridge.request = async (_method, route, body) => { requests.push({ route, body }); return backend[handlers[route]](body); };
 const renderer = { calls: 0, destroy() {}, async renderPdf(_path, opts, onPage) { this.calls++; const count = Math.min(3, opts.maxPages); for (let page = 1; page <= count; page++) await onPage({ page, pageCount: 3, jpegB64: 'aW1hZ2U=' }); return { rendered: count, total: 3 }; } };
 renderer.renderHtml = (...args) => renderer.renderPdf(...args);
 const indexer = new api.Indexer(bridge, renderer); await indexer.start();
 t.after(async () => { indexer.stop(); await indexer.writes; for (const timer of timers) clearTimeout(timer); });
 const addItem = (libraryID = 1, key = 'ABCDEFGH', id = items.size + 1) => { const item = { id, libraryID, key, deleted: false, isAttachment: () => true, isFileAttachment: () => true, isPDFAttachment: () => true, getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'fixture' }; items.set(id, item); return item; };
 const setPref = (k,v) => Zotero.Prefs.set('extensions.zotero-topk.' + k,v);
 const idle = () => until(() => !indexer.running && !indexer.queue.length && !indexer.deleting);
 return { ...api, Zotero, bridge, indexer, backend, renderer, files, prefs, addItem, setPref, idle, requests, items };
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
 const h = await harness(t); const item = h.addItem(); const gate = defer(); const filters = [];
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
  const addon = { indexer: { getState: () => local ? {} : undefined }, bridge: { hasAttachment: () => remote === null ? new Promise(() => {}) : Promise.resolve(remote) } };
  await assert.rejects(h.verifyRemoval(addon, { libraryID:1, key:'ABCDEFGH' }, 10), /removal timed out/);
 });
}

test('deletion self-test passes only when local state and all remote pages are absent', async (t) => {
 const h = await harness(t);
 const result = await h.verifyRemoval({ indexer: { getState: () => undefined }, bridge: { hasAttachment: async () => false } }, { libraryID:1, key:'ABCDEFGH' }, 100);
 assert.equal(result.stillIndexed,false); assert.equal(result.remoteExists,false);
});

test('backend mutation ordering survives a disconnected upload caller', async () => {
 const gate = defer(); const order = [];
 const upload = backendContext.serializeMutation(async () => { order.push('upload started'); await gate.promise; order.push('upload finished'); });
 const remove = backendContext.serializeMutation(async () => { order.push('deleted'); });
 // The HTTP caller can time out and stop awaiting this promise; the backend must still drain it.
 const abandoned = upload(); await tick(); const deleting = remove(); await tick();
 assert.deepEqual(order,['upload started']); gate.resolve(); await deleting; await abandoned;
 assert.deepEqual(order,['upload started','upload finished','deleted']);
});

test('real backend uses stable scopes and completion markers, including partial-page deletion', async () => {
 const backend = new backendContext.TopKBackend();
 const documents = new Map(); const reads = [];
 class Expression {
  constructor(matches) { this.matches = matches; }
  and(other) { return new Expression((doc) => this.matches(doc) && other.matches(doc)); }
 }
 const field = (key) => ({ key, eq: (v) => new Expression((d) => d[key] === v), gt: (v) => new Expression((d) => d[key] > v), in: (vs) => new Expression((d) => vs.includes(d[key])) });
 const select = (fields) => ({ fields, filter(expr) { this.expr = expr; return this; }, sort(f, ascending) { this.sortField = f.key; this.ascending = ascending; return this; }, limit(n) { this.count = n; return this; } });
 backend._sdk = () => ({ query: { select, field }, data: { image: (data) => ({ data }) } });
 backend.client = { collection: () => ({
  query: async (q, options) => {
   reads.push(options);
   const rows = [...documents.values()].filter((doc) => q.expr.matches(doc));
   if (q.sortField) rows.sort((a,b) => String(a[q.sortField]).localeCompare(String(b[q.sortField])) * (q.ascending ? 1 : -1));
   return rows.slice(0,q.count);
  },
  delete: async (expr) => { for (const [id,doc] of documents) if (expr.matches(doc)) documents.delete(id); return 'delete-lsn'; },
 }) };
 documents.set('complete', { library_id:2, library_key:'group:42', attachment_key:'A', page:1, indexed_pages:2 });
 documents.set('partial', { library_id:2, library_key:'group:42', attachment_key:'B', page:2 });
 documents.set('legacy', { library_id:2, attachment_key:'C', page:1, page_count:20 });
 documents.set('foreign', { library_id:2, library_key:'group:99', attachment_key:'A', page:1, indexed_pages:2 });
 const result = await backend.manifest({ libraryKey:'group:42' });
 assert.deepEqual(Array.from(result.rows, (r) => r.attachment_key), ['A']);
 assert.equal((await backend.hasAttachment({ libraryKey:'group:42', attachmentKey:'B' })).exists,true);
 await backend.deleteAttachments({ libraryKey:'group:42', attachmentKeys:['A','B'] });
 assert.equal(documents.size,2); assert.equal(documents.has('foreign'),true); assert.equal(documents.has('legacy'),true);
 assert.equal((await backend.hasAttachment({ libraryKey:'group:42', attachmentKey:'B' })).exists,false);
 assert.equal(reads.at(-1).lsn,'delete-lsn');
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
 const output = await build({ entryPoints:['src/bridge.ts'], bundle:true, write:false, format:'cjs', platform:'node', define:{ __DEV__:'true' } });
 const context = vm.createContext({ module:{ exports:{} }, ChromeUtils:{ importESModule:() => ({}) }, Zotero:{ Prefs:{ get:(name) => name === 'extensions.zotero-topk.bridgeFake' ? true : undefined } } });
 vm.runInContext(output.outputFiles[0].text,context);
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

for (const script of ['e2e.mjs','run-zotero.mjs']) test(`${script} rejects command-line API keys without echoing them`, () => {
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
 const result = spawnSync(process.execPath,['scripts/run-zotero.mjs','--dev-dir',dir], {
  env:{ ...process.env, ZOTERO_BIN:'/bin/true', TOPK_API_KEY:'never-provisioned-test-key' }, encoding:'utf8',
 });
 assert.ifError(result.error);
 assert.equal(result.status,0,result.stderr);
 assert.equal(statSync(profile).mode & 0o777,0o700);
 assert.equal(statSync(userPrefs).mode & 0o777,0o600);
 assert.ok(readFileSync(userPrefs,'utf8').includes('never-provisioned-test-key'));
});
