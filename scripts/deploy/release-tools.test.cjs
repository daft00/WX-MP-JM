const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { initialize, check } = require('./release-tools.cjs');

test('initialization separates credentials, preserves existing config and treats shell text as data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-deploy-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'database.env'), 'MYSQL_URL=mysql://growth_app:$(not-executed)@127.0.0.1:3306/growth_diary\nMIGRATION_DATABASE_URL=mysql://growth_migrator:private@127.0.0.1:3306/growth_diary\n');
    initialize(directory);
    const appPath = path.join(directory, 'app.env');
    const before = fs.readFileSync(appPath, 'utf8');
    const env = parseEnv(before);
    assert.match(env.MYSQL_URL, /\$\(not-executed\)/);
    assert.equal(env.ENABLE_DEV_LOGIN, 'false');
    assert.match(env.INVITE_CODE_SECRET, /^[a-f0-9]{64}$/);
    assert.ok(!before.includes('growth_migrator'));
    assert.ok(!fs.readFileSync(path.join(directory, 'migration.env'), 'utf8').includes('growth_app'));
    initialize(directory);
    assert.equal(fs.readFileSync(appPath, 'utf8'), before);
    if (process.platform !== 'win32') assert.equal(fs.statSync(appPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('release config enforces local runtime credentials, bind address, and existing production validation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-deploy-test-'));
  const release = path.resolve(__dirname, '../../backend');
  const file = path.join(directory, 'app.env');
  const valid = 'NODE_ENV=development\nMYSQL_URL=mysql://growth_app:private@127.0.0.1:3306/growth_diary\nHOST=127.0.0.1\nPORT=3000\n';
  try {
    fs.writeFileSync(file, valid);
    await check(release, file, false);
    for (const invalid of [valid.replace('growth_app', 'root'), valid.replace('HOST=127.0.0.1', 'HOST=0.0.0.0'), valid.replace('PORT=3000', 'PORT=3001'), valid.replace('development', 'production')]) {
      fs.writeFileSync(file, invalid);
      await assert.rejects(check(release, file, false));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
