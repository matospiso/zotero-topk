import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopKBackend, FakeBackend } from '../bridge/backend';
import { createRoutes } from '../bridge/server';
import { defer, tick } from './support/async';

test('backend request ordering is scoped: uploads overlap, deletions wait for their attachment, configure waits for all', async () => {
 const backend: any = new FakeBackend(); const gate = defer(); const order: string[] = [];
 backend.upsert = async ({ docs }) => { order.push(`upload ${docs[0].attachment_key} started`); await gate.promise; order.push(`upload ${docs[0].attachment_key} finished`); };
 backend.deleteAttachments = async ({ attachmentKeys }) => { order.push(`deleted ${attachmentKeys.join()}`); };
 backend.deleteLibrary = async ({ libraryKey }) => { order.push(`deleted ${libraryKey}`); };
 backend.configure = async () => { order.push('configured'); };
 const routes = createRoutes(backend);
 const upload = routes['POST /upsert'], remove = routes['POST /delete'], removeLibrary = routes['POST /delete-library'], configure = routes['POST /configure'];
 const doc = (key: string, library = 'user:17') => ({ docs: [{ _id: `${library}/${key}/1`, library_key: library, library_id: 1, attachment_key: key, item_key: key, page: 1, page_count: 1, title: 'Fixture', file_hash: 'hash', page_image_b64: 'aW1hZ2U=' }] });
 // The HTTP caller can time out and stop awaiting an upload; the backend must still order deletions after it.
 const abandoned = upload(doc('A')); const other = upload(doc('B')); await tick();
 assert.deepEqual(order,['upload A started','upload B started']);
 const deletingA = remove({ libraryKey: 'user:17', attachmentKeys: ['A'] });
 const deletingC = remove({ libraryKey: 'user:17', attachmentKeys: ['C'] });
 const deletingGroup = removeLibrary({ libraryKey: 'group:42' });
 const laterA = upload(doc('A')); const configuring = configure({ apiKey: 'fake', region: 'test', collection: 'pages' }); const afterConfigure = upload(doc('D'));
 await tick(); await tick();
 assert.deepEqual(order,['upload A started','upload B started','deleted C','deleted group:42']);
 gate.resolve(); await Promise.all([abandoned, other, deletingA, deletingC, deletingGroup, laterA, configuring, afterConfigure]);
 assert.deepEqual(order.slice(4),['upload A finished','upload B finished','deleted A','upload A started','upload A finished','configured','upload D started','upload D finished']);
});

test('helper read routes wait for configure and configure drains abandoned reads', async () => {
 const backend = new FakeBackend();
 const context: any = { backend, routes: createRoutes(backend) };
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
 const backend: any = new TopKBackend(); const older = defer<string>(), newer = defer<string>();
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
 const backend: any = new TopKBackend();
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

for (const kind of ['real','fake']) test(`${kind} image responses stay below 8 MiB and still return ordinary thumbnails`, async () => {
 const backend: any = kind === 'real' ? new TopKBackend() : new FakeBackend();
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


test('separate helper instances do not share request ordering', async () => {
 const first: any = new FakeBackend(), second: any = new FakeBackend();
 const gate = defer(); let secondRead = false;
 first.configure = async () => { await gate.promise; };
 second.status = () => { secondRead = true; return { configured: false }; };
 const firstRoutes = createRoutes(first), secondRoutes = createRoutes(second);
 const configuring = firstRoutes['POST /configure']({ apiKey: 'fake', region: 'test', collection: 'pages' });
 const reading = secondRoutes['GET /status'](undefined);
 try {
  await tick();
  assert.equal(secondRead, true);
  assert.deepEqual(await reading, { configured: false });
 } finally {
  gate.resolve();
  await Promise.all([configuring, reading]);
 }
});
