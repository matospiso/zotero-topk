import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/plugin-harness';
import { defer, tick, until } from './support/async';
import { cleanup, onCleanup } from './support/cleanup';

afterEach(cleanup);

test('destination state is isolated for collection, region, host, and API key and survives restart', async () => {
 const h = await harness(); const item = h.addItem();
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
 const restarted = await harness({ backend: h.backend, files: h.files }); const restored = restarted.addItem();
 assert.equal(restarted.indexer.getState(restored)?.status, 'ok');
});

test('an empty reconciled destination is invalidated on change too', async () => {
 const h = await harness(); await h.indexer.indexAllLibraries({ force: false });
 assert.equal(h.indexer.reconciled.size, 2); h.setPref('apiKey','other'); assert.equal(h.indexer.reconciled.size, 0);
});

test('interrupted upload has no completion marker and a fresh install retries it', async () => {
 const h = await harness(); const item = h.addItem(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { if (body.docs.some((d) => d.page === 3)) throw new Error('injected upload failure'); return original(body); };
 h.indexer.enqueue(item, false); await h.idle();
 assert.equal(h.backend.docs.size, 1); assert.equal((await h.bridge.manifest(1)).rows.length, 0);
 assert.notEqual(h.indexer.getState(item)?.status, 'ok');
 h.backend.upsert = original;
 const fresh = await harness({ backend: h.backend }); const other = fresh.addItem();
 await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(fresh.indexer.getState(other)?.pages, 3); assert.equal(h.backend.docs.size, 3);
 assert.equal(h.backend.docs.get('user:17/ABCDEFGH/1').indexed_pages, 3);
});

test('manifest counts intentionally limited pages and skips rendering on another install', async () => {
 const h = await harness(); h.setPref('maxPages',2); h.indexer.enqueue(h.addItem(), false); await h.idle();
 const fresh = await harness({ backend: h.backend }); const item = fresh.addItem();
 await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(fresh.renderer.calls,0); assert.equal(fresh.indexer.getState(item)?.pages,2); assert.equal(fresh.indexer.getState(item)?.totalPages,3);
});

for (const rebuild of [false,true]) test(`removal waits for outstanding uploads (${rebuild ? 'rebuild' : 'first index'})`, async () => {
 const h = await harness(); const item = h.addItem();
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

test('removal before the first rendered page prevents uploads', async () => {
 const h = await harness(); const item = h.addItem(); const gate = defer(); const started = defer(); const render = h.renderer.renderPdf.bind(h.renderer);
 h.renderer.renderPdf = async (...args) => { started.resolve(); await gate.promise; return render(...args); };
 h.indexer.enqueue(item, false); await started.promise; item.deleted = true;
 const removal = h.indexer.remove(1,item.key); gate.resolve(); await removal; await h.idle();
 assert.equal(h.requests.filter((r) => r.route === '/upsert').length,0); assert.equal(h.indexer.getState(item),undefined);
});

test('failed rebuild is incomplete and an ordinary scan retries unchanged files', async () => {
 const h = await harness(); const item = h.addItem(); h.indexer.enqueue(item, false); await h.idle();
 const render = h.renderer.renderPdf.bind(h.renderer); h.renderer.renderPdf = async () => { throw new Error('render failed'); };
 h.indexer.enqueue(item, true); await h.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(h.indexer.stats.attachments,0); assert.equal(h.indexer.getState(item)?.status,'failed');
 h.renderer.renderPdf = render; await h.indexer.indexAllLibraries({ force: false }); await h.idle();
 assert.equal(h.indexer.getState(item)?.status,'ok'); assert.equal(h.backend.docs.size,3);
});

test('failed deletion persists through restart and retries even when there is nothing to index', async () => {
 const h = await harness(); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle(); item.deleted = true;
 const original = h.backend.deleteAttachments.bind(h.backend); h.backend.deleteAttachments = async () => { throw new Error('offline'); };
 await h.indexer.remove(1,item.key); assert.equal(h.indexer.pendingDeletes.length,1); assert.equal(h.indexer.getState(item),undefined);
 const fresh = await harness({ backend: h.backend, files: h.files });
 assert.equal(fresh.indexer.pendingDeletes.length,1);
 h.backend.deleteAttachments = original; await fresh.indexer.indexAllLibraries({ force: false }); await fresh.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(fresh.indexer.pendingDeletes.length,0);
});

test('pending deletions remain scoped to their destination when switching away and back', async () => {
 const h = await harness(); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle();
 const oldDocs = h.backend.docs; const original = h.backend.deleteAttachments.bind(h.backend);
 h.backend.deleteAttachments = async () => { throw new Error('offline'); }; await h.indexer.remove(1,item.key);
 h.backend.deleteAttachments = original; h.setPref('collection','other');
 h.indexer.enqueue(item,false); await h.idle(); assert.equal(h.backend.docs.size,3); assert.equal(oldDocs.size,3);
 h.setPref('collection','pages'); item.deleted = true; await h.indexer.indexAllLibraries({ force: false }); await h.idle();
 assert.equal(oldDocs.size,0);
});

test('stable group identity deduplicates across installations and translates search hits', async () => {
 const h = await harness(); h.indexer.enqueue(h.addItem(2),false); await h.idle();
 const other = await harness({ backend: h.backend, groupLocalID: 98 }); const item = other.addItem(98);
 await other.indexer.indexAllLibraries({ force: false }); await other.idle(); assert.equal(other.renderer.calls,0);
 const hits = await other.bridge.search('fixture',{ libraryIDs:[98] }); assert.equal(hits.length,3); assert.equal(hits[0].library_id,98);
 other.indexer.enqueue(item,true); await other.idle(); assert.equal(h.backend.docs.size,3);
 await other.indexer.remove(98,item.key); assert.equal(h.backend.docs.size,0);
});

test('destination changes during upload neither redirect it nor adopt its state', async () => {
 const h = await harness(); const item = h.addItem(); const gate = defer(); const started = defer(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started.resolve(); await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await started.promise; const oldDocs = h.backend.docs;
 h.setPref('collection','new'); const configuring = h.bridge.testConnection(); await tick(); assert.equal(h.backend.docs,oldDocs);
 gate.resolve(); await configuring; await h.idle(); assert.equal(h.indexer.getState(item),undefined); assert.equal(h.backend.docs.size,0);
 h.backend.upsert = original; await h.indexer.indexAllLibraries({ force: false }); await h.idle(); assert.equal(h.backend.docs.size,3);
});

test('uploads of one attachment are in flight together and the next attachment renders while they drain', async () => {
 const h = await harness(); const a = h.addItem(1,'AAAAAAAA'); const b = h.addItem(1,'BBBBBBBB');
 const gate = defer(); let started = 0; const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 h.indexer.enqueue(a,false); h.indexer.enqueue(b,false);
 await until(() => started >= 2); // pages 2 and 3 of A (uploadBatch 1) are sent without waiting for each other
 await until(() => h.renderer.calls === 2);
 assert.equal(h.indexer.getState(a)?.status,'partial'); assert.equal(h.backend.docs.size,0);
 gate.resolve(); await h.idle();
 assert.equal(h.indexer.getState(a)?.status,'ok'); assert.equal(h.indexer.getState(b)?.status,'ok'); assert.equal(h.backend.docs.size,6);
 const commits = h.requests.filter((r) => r.route === '/upsert' && r.body.docs.some((d) => d.indexed_pages));
 assert.deepEqual(commits.map((r) => r.body.docs[0].attachment_key),['AAAAAAAA','BBBBBBBB']);
});

test('a destination change waits for in-flight uploads and later requests wait for it', async () => {
 const h = await harness(); const item = h.addItem(); const gate = defer(); let started = 0; const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await until(() => started >= 2);
 h.bridge.configured = false; const reconfigure = h.bridge.ensureReady(); const read = h.bridge.status(); await tick(); await tick();
 assert.equal(h.requests.filter((r) => r.route === '/configure').length,1); assert.equal(h.requests.filter((r) => r.route === '/status').length,0);
 gate.resolve(); await reconfigure; await read; await h.idle();
 assert.deepEqual(h.requests.filter((r) => r.route === '/configure' || r.route === '/status').map((r) => r.route),['/configure','/configure','/status']);
 assert.equal(h.indexer.getState(item)?.status,'ok');
});

test('reindexing the same attachment waits for its previous completion record', async () => {
 const h = await harness(); const item = h.addItem(); const gate = defer();
 const original = h.backend.upsert.bind(h.backend); let started = 0;
 h.backend.upsert = async (body) => { started++; await gate.promise; return original(body); };
 const render = h.renderer.renderPdf.bind(h.renderer);
 h.renderer.renderPdf = async (...args) => {
  const result = await render(...args);
  if (h.renderer.calls === 1) h.indexer.enqueue(item, true);
  return result;
 };
 onCleanup(() => gate.resolve());
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

test('uploadConcurrency bounds uploads across both pipelined attachments including commit records', async () => {
 const h = await harness(); h.setPref('uploadConcurrency', 2);
 const gates: ReturnType<typeof defer<void>>[] = []; let active = 0, peak = 0;
 const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => {
  const gate = defer(); gates.push(gate); active++; peak = Math.max(peak, active);
  try { await gate.promise; return await original(body); } finally { active--; }
 };
 onCleanup(() => gates.forEach((gate) => gate.resolve()));
 h.indexer.enqueue(h.addItem(1, 'AAAAAAAA'), false);
 h.indexer.enqueue(h.addItem(1, 'BBBBBBBB'), false);
 await until(() => h.renderer.calls === 2); await tick();
 assert.equal(active, 2);
 for (let i = 0; i < 6; i++) { await until(() => gates.length > i); gates[i].resolve(); }
 await h.idle(); assert.equal(peak, 2); assert.equal(h.backend.docs.size, 6);
});

test('a draining document timeout does not destroy the next document renderer', async () => {
 const h = await harness(); const a = h.addItem(1, 'AAAAAAAA'), b = h.addItem(1, 'BBBBBBBB');
 const uploadGate = defer(), renderGate = defer(); let destroyed = 0, secondRendering = false;
 const original = h.backend.upsert.bind(h.backend), render = h.renderer.renderPdf.bind(h.renderer);
 h.backend.upsert = async (body) => { await uploadGate.promise; return original(body); };
 h.renderer.destroy = () => { destroyed++; };
 h.renderer.renderPdf = async (...args) => {
  if (h.renderer.calls === 1) { secondRendering = true; await renderGate.promise; }
  return render(...args);
 };
 onCleanup(() => { uploadGate.resolve(); renderGate.resolve(); });
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

test('startup retries persisted removals with automatic indexing disabled', async () => {
 const h = await harness(); const item = h.addItem(); h.indexer.enqueue(item,false); await h.idle();
 const original = h.backend.deleteAttachments.bind(h.backend); h.backend.deleteAttachments = async () => { throw new Error('offline'); };
 await h.indexer.remove(1,item.key); h.backend.deleteAttachments = original;
 const restarted = await harness({ backend:h.backend, files:h.files }); await restarted.idle();
 assert.equal(restarted.renderer.calls,0); assert.equal(h.backend.docs.size,0);
});

test('group removal drains uploads and deletes using the stable group ID after the local library disappears', async () => {
 const h = await harness(); const item = h.addItem(2); const gate = defer(); const started = defer(); const original = h.backend.upsert.bind(h.backend);
 h.backend.upsert = async (body) => { started.resolve(); await gate.promise; return original(body); };
 h.indexer.enqueue(item,false); await started.promise;
 h.Zotero.Libraries.getAll().pop();
 const removal = h.indexer.removeLibrary(2,'group:42'); gate.resolve(); await removal; await h.idle();
 assert.equal(h.backend.docs.size,0); assert.equal(h.indexer.stats.attachments,0);
});


test('pre-cleanup destination state retains its credential fingerprint', async () => {
 // This target key is from a version-3 state file written before preferences were centralized.
 const state = { libraryID: 1, key: 'ABCDEFGH', hash: 'hash', pages: 3, totalPages: 3, kind: 'pdf', at: 1, status: 'ok' };
 const files = new Map([['/mock/topk-index-state.json', JSON.stringify({ version: 3,
  targets: { '96c95adc70ffaf45fe9d221769b2316e': { attachments: { 'user:17/ABCDEFGH': state }, pendingDeletes: [] } },
 })]]);
 const h = await harness({ files });
 const item = h.addItem();
 assert.equal(h.indexer.getState(item)?.status, 'ok');
 assert.equal(h.indexer.getState(item)?.pages, 3);
});
