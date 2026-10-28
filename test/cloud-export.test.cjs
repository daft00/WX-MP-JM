const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
function fixture(call) {
  const saved = new Map(), removed = []; let scope = 'family', downloaded = 0;
  const wx = { getStorageSync: k => saved.get(k), setStorageSync: (k, v) => saved.set(k, v), removeStorageSync: k => saved.delete(k),
    downloadFile: args => { downloaded++; args.success({ statusCode: 200, tempFilePath: '/tmp/export.zip' }); },
    getFileSystemManager: () => ({ getFileInfo: args => args.success({ size: 10 }), unlink: args => removed.push(args.filePath) }) };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync('miniprogram/services/http-exports.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { exports, wx, require: () => ({ createRequestId: async () => 'request' }) });
  return { service: exports.createExportService(call, async () => {}, () => scope), saved, removed, downloaded: () => downloaded, change: () => { scope = 'other'; } };
}
test('cloud export preserves request ID after lost response and clears it on success', async () => {
  const requests = []; let fail = true;
  const f = fixture(async (_, method, body) => { requests.push(body); if (fail) { fail = false; throw Error('lost'); } return { id: 'job' }; });
  await assert.rejects(f.service.create('child', '2026'), /lost/);
  await assert.rejects(f.service.create('child', '2025'), /重试/);
  await f.service.create('child', '2026');
  assert.equal(requests[0].requestId, requests[1].requestId); assert.equal(f.saved.size, 0);
});
test('definitive export rejection allows correcting the range', async () => {
  const f = fixture(async () => { throw Object.assign(Error('busy'), { status: 409 }); });
  await assert.rejects(f.service.create('child', '2026')); assert.equal(f.saved.size, 0);
});
test('cloud package download checks size, scope and destination before exposing the path', async () => {
  let size = 10, host = 'https://test-123.cos.ap-guangzhou.myqcloud.com/exports/1.zip';
  const f = fixture(async () => ({ url: host, sizeBytes: size }));
  assert.equal(await f.service.getArchivePath('job', 2), '/tmp/export.zip');
  size = 11; await assert.rejects(f.service.getArchivePath('job', 2), /不完整/); assert.equal(f.removed.length, 1);
  host = 'https://evil.example/file'; await assert.rejects(f.service.getArchivePath('job', 2), /地址/); assert.equal(f.downloaded(), 2);
  let scoped; scoped = fixture(async () => { scoped.change(); return { url: host, sizeBytes: 10 }; });
  await assert.rejects(scoped.service.getArchivePath('job', 1), /切换/); assert.equal(scoped.downloaded(), 0);
});
