const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(call) {
  const state = new Map(); let ids = 0, uploads = 0, scope = 'family:baby:session';
  const wx = {
    getStorageSync: k => state.get(k), setStorageSync: (k, v) => state.set(k, JSON.parse(JSON.stringify(v))), removeStorageSync: k => state.delete(k),
    getFileSystemManager: () => ({ getFileInfo: ({ success }) => success({ size: 100 }) }),
    uploadFile: args => { uploads++; queueMicrotask(() => args.success({ statusCode: 204 })); return { onProgressUpdate() {}, abort() {} }; },
  };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync('miniprogram/services/http-uploads.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(source, { exports, wx, setTimeout: fn => { fn(); }, require: () => ({ createRequestId: async () => `req-${++ids}` }) });
  return { service: exports.createUploadService(call, () => scope), state, uploads: () => uploads, changeScope: () => { scope = 'other'; } };
}
const asset = { id: 'asset', status: 'READY', familyId: 'family', childId: 'baby', kind: 'IMAGE' };
const file = { tempFilePath: '/local/a.jpg', size: 100, fileType: 'image' };
const ticket = { asset: { ...asset, status: 'PENDING' }, upload: { url: 'https://test-123.cos.ap-guangzhou.myqcloud.com/', formData: { key: 'tmp/a' } } };

test('lost completion response resumes same upload without uploading bytes twice', async () => {
  let completes = 0, creates = 0; const saved = [];
  const f = fixture(async (path, method) => {
    if (path === '/assets') { creates++; return ticket; }
    if (path.endsWith('/authorize')) return ticket;
    if (path.endsWith('/complete')) { if (++completes === 1) throw new Error('network'); return asset; }
    throw new Error(`${method} ${path}`);
  });
  await assert.rejects(f.service.saveLocalMedia('baby', [file], { saved: a => saved.push(a.id) }), /network/);
  await f.service.resumePending('baby', { saved: a => saved.push(a.id) });
  assert.equal(creates, 1); assert.equal(f.uploads(), 1);
  assert.deepEqual(saved, ['asset']); assert.equal(f.state.size, 0);
});
test('successful asset is delivered before a later file fails and is absent from retry queue', async () => {
  let creates = 0; const saved = [];
  const f = fixture(async path => {
    if (path === '/assets') { if (++creates === 2) throw new Error('quota'); return ticket; }
    if (path.endsWith('/complete')) return asset;
    throw new Error(path);
  });
  await assert.rejects(f.service.saveLocalMedia('baby', [file, file], { saved: a => saved.push(a.id) }), /quota/);
  assert.deepEqual(saved, ['asset']);
  assert.equal(f.state.get('growth_diary_upload_queue_v1').tasks.length, 1);
});
test('scope change rejects response before storing media in another family draft', async () => {
  let f; const saved = [];
  f = fixture(async () => { f.changeScope(); return ticket; });
  await assert.rejects(f.service.saveLocalMedia('baby', [file], { saved: a => saved.push(a) }), /取消/);
  assert.equal(saved.length, 0); assert.equal(f.uploads(), 0);
});
test('untrusted upload host is rejected without sending a file', async () => {
  const f = fixture(async () => ({ ...ticket, upload: { ...ticket.upload, url: 'https://evil.invalid/' } }));
  await assert.rejects(f.service.saveLocalMedia('baby', [file]), /地址无效/);
  assert.equal(f.uploads(), 0);
});
