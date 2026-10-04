const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

function load(relative, wx = {}, cache = {}) {
  const filename = path.resolve(__dirname, relative);
  if (cache[filename]) return cache[filename];
  const exports = cache[filename] = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports, wx, Uint8Array, ArrayBuffer, DataView,
    require: name => load(path.resolve(path.dirname(filename), `${name}.ts`), wx, cache),
  });
  return exports;
}
const { exportRange, archiveHtml, utf8, writeZip } = load('../miniprogram/utils/export-archive.ts');
const plain = value => JSON.parse(JSON.stringify(value));

test('month, quarter, year boundaries include leap day and cross year correctly', () => {
  assert.deepEqual(plain(exportRange('2024-02')), { start: '2024-02-01', end: '2024-03-01', label: '2024年2月' });
  assert.equal(exportRange('2024-Q1').end, '2024-04-01');
  assert.equal(exportRange('2024-Q4').end, '2025-01-01');
  assert.equal(exportRange('2024-12').end, '2025-01-01');
  assert.equal(exportRange('2024').start, '2024-01-01');
  assert.equal(exportRange('2024').end, '2025-01-01');
  for (const invalid of ['2024-13', '2024-Q0', '2024-Q5', '', '2024-2', '0000', '2024-02-01']) assert.throws(() => exportRange(invalid));
});

test('offline HTML is chronological, escapes user content and uses relative media', () => {
  const base = { body: '<script>alert(1)</script>', kind: 'DIARY', createdAt: '2024-01-01', assetIds: [] };
  const html = archiveHtml({ name: '<宝宝>' }, '2024', [
    { ...base, id: 'b', title: 'later-record', occurredAt: '2024-12-01', assetIds: ['video'] },
    { ...base, id: 'a', title: 'earlier-record', occurredAt: '2024-01-01', assetIds: ['image'] },
  ], [
    { asset: { id: 'image', kind: 'IMAGE', name: '" onerror="bad' }, path: 'media/00001.png' },
    { asset: { id: 'video', kind: 'VIDEO', name: 'video' }, path: 'media/00002.mp4' },
  ]);
  assert.ok(html.indexOf('earlier-record') < html.indexOf('later-record'));
  assert.ok(html.indexOf('2024年01月') < html.indexOf('2024年12月'));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|wxfile:|https?:\/\//);
  assert.match(html, /<video controls/);
  assert.match(html, /src="media\/00001.png"/);
  assert.deepEqual(Buffer.from(utf8('宝宝😀')).toString(), '宝宝😀');
});

test('ZIP writes binary bytes, standard CRC and directory offsets; rejects incomplete sources', async () => {
  const parts = [];
  const data = Buffer.from('123456789');
  await writeZip([{ name: 'media/test.bin', size: data.length, chunks: async function* () { yield data.subarray(0, 3); yield data.subarray(3); } }], async b => parts.push(Buffer.from(b)));
  const zip = Buffer.concat(parts), nameLength = zip.readUInt16LE(26);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.deepEqual(zip.subarray(30 + nameLength, 30 + nameLength + data.length), data);
  const end = zip.length - 22, central = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  assert.equal(zip.readUInt32LE(central + 16), 0xcbf43926);
  assert.equal(zip.readUInt32LE(central + 42), 0);
  assert.equal(zip.readUInt16LE(end + 10), 1);
  await assert.rejects(writeZip([{ name: '../escape', size: 0, chunks: async function* () {} }], async () => {}));
  await assert.rejects(writeZip([{ name: 'short', size: 5, chunks: async function* () { yield new Uint8Array(1); } }], async () => {}), /不完整/);
});

function fixture() {
  const files = new Map([['photo', Buffer.from([137, 80, 78, 71, 0, 255])], ['video', Buffer.from([0, 255, 128, 5])]]);
  const state = { version: 4, activeUserId: 'user', activeFamilyId: 'family',
    users: [{ id: 'user' }], families: [{ id: 'family' }], members: [{ userId: 'user', familyId: 'family', role: 'OWNER' }],
    children: [{ id: 'child', familyId: 'family', name: '宝宝' }], exports: [],
    entries: [
      { id: 'e1', familyId: 'family', childId: 'child', occurredAt: '2024-03-31', createdAt: '2024-03-31', title: 'first', body: '', kind: 'DIARY', assetIds: ['image', 'video'] },
      { id: 'e2', familyId: 'family', childId: 'child', occurredAt: '2024-04-01', createdAt: '2024-04-01', title: 'outside', body: '', kind: 'DIARY', assetIds: [] },
    ],
    assets: [{ id: 'image', familyId: 'family', childId: 'child', name: '照片', kind: 'IMAGE', localPath: 'photo' },
      { id: 'video', familyId: 'family', childId: 'child', name: '视频', kind: 'VIDEO', localPath: 'video' }],
  };
  const wx = { env: { USER_DATA_PATH: '/user' }, getStorageSync: () => state,
    setStorageSync: (_, value) => Object.assign(state, value),
    getImageInfo: async () => ({ type: 'png' }), getVideoInfo: async () => ({ type: 'mp4' }),
    getFileSystemManager: () => ({
      getFileInfo: o => files.has(o.filePath) ? o.success({ size: files.get(o.filePath).length }) : o.fail({}),
      writeFile: o => { files.set(o.filePath, Buffer.from(o.data)); o.success(); },
      appendFile: o => { files.set(o.filePath, Buffer.concat([files.get(o.filePath), Buffer.from(o.data)])); o.success(); },
      readFile: o => { const part = files.get(o.filePath).subarray(o.position, o.position + o.length); o.success({ data: Uint8Array.from(part).buffer }); },
      unlink: o => { files.delete(o.filePath); o.success?.(); o.complete?.(); },
    }),
  };
  return { files, state, wx, service: load('../miniprogram/services/mock-services.ts', wx).mockServices.exports };
}

test('export creates real package with scoped quarter records; original files survive cleanup', async () => {
  const f = fixture();
  f.state.entries.push({ ...f.state.entries[0], id: 'foreign', familyId: 'other', assetIds: ['missing'] });
  const job = await f.service.create('child', '2024-Q1');
  assert.equal(job.entryCount, 1);
  assert.equal(job.assetCount, 2);
  assert.ok(f.files.get(job.localZipPath).length > 100);
  assert.equal(await f.service.getArchivePath(job.id), job.localZipPath);
  await f.service.markDownloaded(job.id);
  await f.service.confirmManualBackup(job.id);
  await f.service.deleteArchive(job.id);
  assert.ok(f.files.has('photo') && f.files.has('video'));
  assert.equal(f.files.has(job.localZipPath), false);
});

test('empty range, missing media, foreign child and ordinary member cannot produce READY jobs', async () => {
  const f = fixture();
  await assert.rejects(f.service.create('child', '2023'), /没有记录/);
  await assert.rejects(f.service.create('other-child', '2024'));
  f.files.delete('photo');
  await assert.rejects(f.service.create('child', '2024'));
  f.state.members[0].role = 'MEMBER';
  await assert.rejects(f.service.create('child', '2024'), /管理员/);
  assert.equal(f.state.exports.length, 0);
});

test('cancellation during streaming removes partial ZIP and keeps source media', async () => {
  const f = fixture(); let cancelled = false;
  await assert.rejects(f.service.create('child', '2024', { cancelled: () => cancelled,
    progress: message => { if (message.startsWith('打包')) cancelled = true; },
  }), /取消/);
  assert.deepEqual([...f.files.keys()], ['photo', 'video']);
  assert.equal(f.state.exports.length, 0);
});

test('permission change during packaging prevents publication and cleans ZIP', async () => {
  const f = fixture();
  await assert.rejects(f.service.create('child', '2024', { progress: message => {
    if (message.startsWith('打包')) f.state.members[0].role = 'MEMBER';
  } }), /权限/);
  assert.deepEqual([...f.files.keys()], ['photo', 'video']);
  assert.equal(f.state.exports.length, 0);
});

test('disk write failure removes partial package and never marks export ready', async () => {
  const f = fixture();
  const original = f.wx.getFileSystemManager;
  f.wx.getFileSystemManager = () => ({ ...original(), appendFile: options => options.fail({ errMsg: 'no space' }) });
  await assert.rejects(f.service.create('child', '2024'), /空间不足/);
  assert.deepEqual([...f.files.keys()], ['photo', 'video']);
  assert.equal(f.state.exports.length, 0);
});
