const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function compile(path) {
  return ts.transpileModule(fs.readFileSync(require.resolve(path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}
const exportsObject = {};
vm.runInNewContext(compile('../miniprogram/utils/record-groups.ts'), { exports: exportsObject });
const { groupRecords } = exportsObject;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('year options cover all records and filtering precedes pagination within the active family/child', async () => {
  const entry = (id, year, childId = 'baby', familyId = 'family') => ({
    id, childId, familyId, occurredAt: `${year}-01-01`, createdAt: `${year}-01-01`,
  });
  const state = {
    version: 4, activeUserId: 'user', activeFamilyId: 'family',
    users: [{ id: 'user' }], families: [{ id: 'family' }],
    members: [{ userId: 'user', familyId: 'family' }],
    entries: [entry('new', '2026'), entry('old1', '2024'), entry('old2', '2024'),
      entry('other-baby', '2023', 'other'), entry('other-family', '2022', 'baby', 'other')],
  };
  const exported = {};
  vm.runInNewContext(compile('../miniprogram/services/mock-services.ts'), {
    exports: exported, require: () => ({}), wx: { getStorageSync: () => state },
  });
  const service = exported.mockServices.entries;
  assert.deepEqual(plain(await service.listYears('baby')), ['2026', '2024']);
  const first = await service.list({ childId: 'baby', year: '2024', pageSize: 1 });
  const second = await service.list({ childId: 'baby', year: '2024', pageSize: 1, cursor: first.nextCursor });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(second.nextCursor, undefined);
  assert.ok([...first.items, ...second.items].every(item => item.occurredAt.startsWith('2024-')));
  assert.equal((await service.list({ childId: 'baby', year: '2020' })).items.length, 0);
  state.members = [];
  await assert.rejects(service.listYears('baby'));
});

test('records group by occurrence year/month descending, with empty months omitted', () => {
  const entries = [
    { id: 'a', occurredAt: '2025-12-31' },
    { id: 'b', occurredAt: '2026-02-01' },
    { id: 'c', occurredAt: '2026-10-03' },
    { id: 'd', occurredAt: '2026-10-04' },
  ];
  const snapshot = JSON.stringify(entries);
  const years = plain(groupRecords(entries));
  assert.deepEqual(years.map(item => item.year), ['2026', '2025']);
  assert.deepEqual(years[0].months.map(item => item.label), ['10月', '2月']);
  assert.deepEqual(years[0].months[0].entries.map(item => item.id), ['d', 'c']);
  assert.equal(JSON.stringify(entries), snapshot);
  assert.deepEqual(plain(groupRecords([])), []);
});

test('pagination merges a month across page boundaries and removes repeated records', () => {
  const first = [{ id: 'a', occurredAt: '2026-10-04' }];
  const next = [{ id: 'b', occurredAt: '2026-10-01' }, ...first, { id: 'c', occurredAt: '2025-12-01' }];
  const years = plain(groupRecords([...first, ...next]));
  assert.equal(years.length, 2);
  assert.equal(years[0].months.length, 1);
  assert.deepEqual(years[0].months[0].entries.map(item => item.id), ['a', 'b']);
});

test('accordion toggles closed and switches between months across years', () => {
  let page;
  vm.runInNewContext(compile('../miniprogram/pages/wall/index.ts'), {
    exports: {},
    Page: (definition) => { page = definition; },
    require: (name) => name.includes('record-groups') ? exportsObject : {},
  });
  page.setData = (patch) => Object.assign(page.data, patch);
  page.data.years = groupRecords([
    { id: 'a', occurredAt: '2026-10-01' },
    { id: 'b', occurredAt: '2026-09-01' },
    { id: 'c', occurredAt: '2025-12-01' },
  ]);
  const event = (dataset) => ({ currentTarget: { dataset } });
  page.toggleMonth(event({ month: '2026-10' }));
  assert.equal(page.data.expandedMonth, '2026-10');
  page.toggleMonth(event({ month: '2026-09' }));
  assert.equal(page.data.expandedMonth, '2026-09');
  page.toggleMonth(event({ month: '2026-09' }));
  assert.equal(page.data.expandedMonth, '');
  page.toggleMonth(event({ month: '2025-12' }));
  assert.equal(page.data.expandedMonth, '2025-12');
  page.toggleMonth(event({ month: '2025-12' }));
  assert.equal(page.data.expandedMonth, '');
});
