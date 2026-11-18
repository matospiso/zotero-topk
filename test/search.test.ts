import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/plugin-harness';
import { defer, tick, until } from './support/async';
import { cleanup } from './support/cleanup';

afterEach(cleanup);

async function searchHarness() {
 const h = await harness();
 const first = h.addItem(1, 'FIRSTPDF');
 const second = h.addItem(1, 'SECONDPD');
 const box = { searchTextbox: { value: 'first query' } };
 let provider: (item: any) => string;
 h.Zotero.ItemTreeManager.registerColumn = (options) => { provider = options.dataProvider; return 'score'; };
 h.Zotero.Search = class {
  conditions: any[] = [];
  addCondition(...args) { this.conditions.push(args); }
 };
 const hit = (item, score = 1) => ({ _id: item.key, library_id: 1, attachment_key: item.key, page: 1, page_count: 1, score });
 const queries: string[] = [];
 const backend = { search: async (text) => { queries.push(text); return [hit(first, 2), hit(second, 1)]; } };
 const search = new h.SearchIntegration(backend);
 const column = { dataKey: 'score', hidden: true, sortDirection: 0 };
 const cache = new Map<number, string>();
 const allRows = [first.id, second.id];
 let rows = [...allRows];
 let activeFilter: any = null;
 let message: string | null = null;
 let spinning = false;
 const score = (id) => {
  if (!cache.has(id)) cache.set(id, provider(h.items.get(id)));
  return cache.get(id)!;
 };
 const view = {
  _getColumns: () => [column],
  tree: {
   invalidate() {},
   _columns: {
    toggleHidden() { column.hidden = !column.hidden; },
    async toggleSort() { column.sortDirection = column.sortDirection ? -column.sortDirection : -1; await view.sort(); },
   },
  },
  invalidateRowCache(all) { assert.equal(all, true); cache.clear(); },
  async sort() { rows.sort((a, b) => column.sortDirection * score(a).localeCompare(score(b))); },
  async setFilter(type, data) {
   assert.ok(['search', 'advanced-search'].includes(type));
   if (type === 'advanced-search') activeFilter = data;
   const keys = activeFilter?.conditions.filter(([field]) => field === 'key').map(([, , key]) => key);
   rows = allRows.filter((id) => !keys || keys.includes(h.items.get(id).key));
  },
 };
 const spinner = {
  setAttribute() { spinning = true; }, removeAttribute() { spinning = false; },
  style: { visibility: '', removeProperty() {} },
 };
 const win = {
  document: {
   getElementById: (id) => id === 'zotero-tb-search' ? box : id === 'zotero-tb-search-spinner' ? spinner : null,
   createElementNS: () => ({ textContent: '' }),
  },
  ZoteroPane: {
   itemsView: view, getSelectedLibraryIDs: () => [1],
   clearItemsPaneMessage() { message = null; }, setItemsPaneMessage(el) { message = el.textContent; },
  },
 };
 h.Zotero.getMainWindows = () => [win];
 h.Zotero.Prefs.set('search.quicksearch-mode', 'topk');
 search.install();
 return { ...h, search, backend, queries, box, view, win, column, hit, first, second, score,
  rows: () => rows, message: () => message, spinning: () => spinning };
}

test('every search refreshes cached scores and re-sorts an already selected score column', async () => {
 const h = await searchHarness();
 await h.search.runSearch(h.win, true);
 assert.deepEqual(h.rows(), [h.first.id, h.second.id]);
 assert.equal(h.column.hidden, false);
 h.backend.search = async () => [h.hit(h.first, 1), h.hit(h.second, 9)];
 h.box.searchTextbox.value = 'second query';
 await h.search.runSearch(h.win, true);
 assert.equal(h.message(), null);
 assert.deepEqual(h.rows(), [h.second.id, h.first.id]);
 assert.equal(h.score(h.second.id).trim(), '9.000');
 assert.equal(h.column.sortDirection, -1);
});

test('a search waits for its explicit final sort', async () => {
 const h = await searchHarness();
 h.column.sortDirection = -1;
 const gate = defer(); let sorting = false; let finished = false;
 const original = h.view.sort;
 h.view.sort = async () => { sorting = true; await gate.promise; await original(); };
 const run = h.search.runSearch(h.win, true).then(() => { finished = true; });
 await until(() => sorting);
 assert.equal(finished, false);
 assert.equal(h.spinning(), true);
 gate.resolve(); await run;
 assert.equal(h.spinning(), false);
 assert.deepEqual(h.rows(), [h.first.id, h.second.id]);
});

for (const blockedType of ['search', 'advanced-search']) {
 test(`new results wait for an older ${blockedType} refresh before replacing it`, async () => {
  const h = await searchHarness(); const gate = defer(); let blocked = false;
  h.backend.search = async (text) => { h.queries.push(text); return [h.hit(text === 'first query' ? h.first : h.second)]; };
  const original = h.view.setFilter;
  h.view.setFilter = async (type, data) => {
   if (type === blockedType && !blocked) { blocked = true; await gate.promise; }
   await original(type, data);
  };
  const first = h.search.runSearch(h.win, true);
  await until(() => blocked);
  h.box.searchTextbox.value = 'second query';
  const second = h.search.runSearch(h.win, true);
  await until(() => h.queries.length === 2); await tick();
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(h.search.lastQuery, 'second query');
  assert.deepEqual(h.rows(), [h.second.id]);
  assert.deepEqual([...h.search.results.keys()], [h.second.id]);
  assert.equal(h.message(), null);
 });
}

test('clearing during an advanced-search refresh cannot leave its old filter applied', async () => {
 const h = await searchHarness(); const gate = defer(); let blocked = false;
 h.backend.search = async () => [h.hit(h.first)];
 const original = h.view.setFilter;
 h.view.setFilter = async (type, data) => {
  if (type === 'advanced-search' && data) { blocked = true; await gate.promise; }
  await original(type, data);
 };
 const pending = h.search.runSearch(h.win, true);
 await until(() => blocked);
 const clearing = h.search.clear(h.win);
 gate.resolve(); await Promise.all([pending, clearing]);
 assert.deepEqual(h.rows(), [h.first.id, h.second.id]);
 assert.equal(h.search.active, false);
 assert.equal(h.search.results.size, 0);
 assert.equal(h.spinning(), false);
});

test('rapid typing sends only the latest query after the debounce', async () => {
 const h = await searchHarness();
 const first = h.search.runSearch(h.win, false);
 h.box.searchTextbox.value = 'second query';
 const second = h.search.runSearch(h.win, false);
 await first;
 assert.deepEqual(h.queries, []);
 const timers = [...h.timers.entries()].filter(([, timer]) => timer.ms === 300);
 assert.equal(timers.length, 1);
 const [timer, callback] = timers[0];
 clearTimeout(timer); callback.fn();
 await second;
 assert.deepEqual(h.queries, ['second query']);
});

test('Enter cancels the pending debounce and searches immediately once', async () => {
 const h = await searchHarness();
 const pending = h.search.runSearch(h.win, false);
 await h.search.runSearch(h.win, true); await pending;
 assert.deepEqual(h.queries, ['first query']);
 assert.equal([...h.timers.values()].some((timer) => timer.ms === 300), false);
});

test('short input cancels the pending query and clears the spinner', async () => {
 const h = await searchHarness();
 const pending = h.search.runSearch(h.win, false);
 h.box.searchTextbox.value = 'ab';
 await h.search.runSearch(h.win, false); await pending;
 assert.deepEqual(h.queries, []);
 assert.equal(h.spinning(), false);
 assert.equal(h.search.active, false);
});

test('leaving TopK mode cancels a debounced query before it is billed', async () => {
 const h = await searchHarness();
 const pending = h.search.runSearch(h.win, false);
 h.Zotero.Prefs.set('search.quicksearch-mode', 'fields');
 await pending;
 assert.deepEqual(h.queries, []);
 assert.equal(h.spinning(), false);
 assert.equal([...h.timers.values()].some((timer) => timer.ms === 300), false);
});

test('a failed filter refresh does not block later searches', async () => {
 const h = await searchHarness(); const original = h.view.setFilter;
 h.view.setFilter = async () => { throw new Error('refresh failed'); };
 await h.search.runSearch(h.win, true);
 assert.match(h.message()!, /refresh failed/);
 h.view.setFilter = original;
 await h.search.runSearch(h.win, true);
 assert.equal(h.message(), null);
 assert.deepEqual(h.rows(), [h.first.id, h.second.id]);
});
