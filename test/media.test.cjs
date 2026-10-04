const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(require.resolve('../miniprogram/services/media-policy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const MB = 1024 * 1024;

function fixture(kind, originalSize, outputs = [], type = 'jpeg') {
  const sizes = new Map([['original', originalSize]]), calls = [], removed = [];
  let cancelled = false;
  const compress = async (options) => {
    calls.push(options);
    const path = `compressed-${calls.length}`;
    sizes.set(path, outputs[calls.length - 1] ?? originalSize);
    return { tempFilePath: path, size: 1 }; // 故意伪造返回值，必须以文件系统字节数为准。
  };
  const exports = {};
  vm.runInNewContext(source, { exports, wx: {
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, success }) => success({ size: sizes.get(filePath) }),
      unlink: ({ filePath, complete }) => { removed.push(filePath); complete(); },
    }),
    getImageInfo: async () => ({ type, width: 4000, height: 3000 }),
    getVideoInfo: async () => ({ duration: 120, width: 1920, height: 1080, fps: 25, bitrate: 8000 }),
    compressImage: compress, compressVideo: compress,
  } });
  const file = { tempFilePath: 'original', size: 1, fileType: kind };
  const options = { cancelled: () => cancelled, progress: () => {}, toJpeg: async () => {
    sizes.set('jpeg', 5 * MB); return 'jpeg';
  } };
  return { ...exports, file, options, calls, removed, cancel: () => { cancelled = true; } };
}

test('exact limits pass unchanged; invalid sizes and unsupported types fail', async () => {
  for (const [kind, size] of [['image', 10 * MB], ['video', 50 * MB]]) {
    const f = fixture(kind, size);
    const result = await f.prepareMedia([f.file], f.options);
    assert.equal(result.files[0].tempFilePath, 'original');
    assert.equal(result.files[0].size, size);
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.assertMediaSize(kind, size + 1));
    for (const value of [0, -1, NaN, 0.5]) assert.throws(() => f.assertMediaSize(kind, value));
    assert.throws(() => f.assertMediaSize('audio', 1));
  }
});

test('image retries use measured bytes and only clean generated files', async () => {
  const f = fixture('image', 20 * MB, [11 * MB, 8 * MB]);
  const result = await f.prepareMedia([f.file], f.options);
  assert.equal(f.calls.length, 2);
  assert.equal(result.files[0].size, 8 * MB);
  assert.deepEqual(f.removed, ['compressed-1']);
  await result.dispose(['compressed-2']);
  assert.deepEqual(f.removed, ['compressed-1']);
  await result.dispose();
  assert.deepEqual(f.removed, ['compressed-1', 'compressed-2']);
});

test('PNG JPEG fallback is measured; oversized GIF is not flattened', async () => {
  const f = fixture('image', 20 * MB, [15 * MB], 'png');
  const result = await f.prepareMedia([f.file], f.options);
  assert.equal(result.files[0].tempFilePath, 'jpeg');
  const gif = fixture('image', 20 * MB, [], 'gif');
  await assert.rejects(gif.prepareMedia([gif.file], gif.options), /动图/);
  assert.equal(gif.calls.length, 0);
});

test('video uses at most two attempts and never trusts encoder size', async () => {
  const f = fixture('video', 80 * MB, [60 * MB, 51 * MB]);
  await assert.rejects(f.prepareMedia([f.file], f.options), /50MB/);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].bitrate < f.calls[0].bitrate);
  assert.ok(f.calls.every(call => call.fps <= 25 && call.resolution <= 1 && !call.quality));
  assert.deepEqual(f.removed, ['compressed-1', 'compressed-2']);
});

test('cancellation after native completion cleans the result and stops the batch', async () => {
  const f = fixture('image', 20 * MB, [8 * MB]);
  f.options.progress = (message) => { if (message.includes('压缩')) f.cancel(); };
  await assert.rejects(f.prepareMedia([f.file, f.file], f.options), /取消/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.removed, ['compressed-1']);
});

test('three failed image rounds reject; native failure rejects without saving', async () => {
  const f = fixture('image', 20 * MB);
  await assert.rejects(f.prepareMedia([f.file], f.options), /10MB/);
  assert.equal(f.calls.length, 3);
  const png = fixture('image', 20 * MB, [], 'png');
  png.options.toJpeg = async () => { throw new Error('decoder failure'); };
  await assert.rejects(png.prepareMedia([png.file], png.options), /decoder failure/);
  assert.deepEqual(png.removed, ['compressed-1']);
});
