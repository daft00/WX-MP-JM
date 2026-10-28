const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
const future = () => new Date(Date.now() + 3600000).toISOString();

function load(file, context) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { exports, ...context });
  return exports;
}

function fixture(handler, options = {}) {
  const storage = new Map();
  const calls = [];
  let logins = 0;
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login: ({ success }) => { logins++; queueMicrotask(() => success({ code: options.code || 'valid' })); },
    request: args => { calls.push(args); handler(args); },
  };
  const { createHttpServices } = load('../miniprogram/services/http-services.ts', { wx, require: name => {
    if (name === './http-exports') return load('../miniprogram/services/http-exports.ts', { wx, require: () => ({ createRequestId: async () => 'test-request' }) });
    if (name === './http-uploads') return load('../miniprogram/services/http-uploads.ts', { wx, setTimeout, require: () => ({ createRequestId: async () => 'test-request' }) });
    throw new Error(name);
  } });
  const baseUrl = options.baseUrl || 'https://test.invalid/api/v1';
  return { services: createHttpServices(baseUrl), restore: () => createHttpServices(baseUrl), storage, calls, wx, logins: () => logins };
}

function normal(args) {
  const path = new URL(args.url).pathname;
  let data;
  if (path.endsWith('/auth/wechat/login')) data = { accessToken: 'test-token', expiresAt: future(), user: { id: 'user' } };
  else if (path.endsWith('/auth/me')) data = { user: { id: 'user' } };
  else if (path.endsWith('/creation-status')) data = { canCreate: false };
  else if (path.endsWith('/members')) data = [{ id: 'member', userId: 'user', role: 'OWNER', user: { id: 'user' } }];
  else if (path.endsWith('/families')) data = [];
  else if (path.endsWith('/children')) data = [];
  else if (path.includes('/children/')) data = { id: 'baby', familyId: 'family' };
  else data = { id: path.split('/').pop(), name: 'Family' };
  queueMicrotask(() => args.success({ statusCode: path.endsWith('/logout') ? 204 : 200, data }));
}

test('concurrent login shares one wx.login and POST; authenticated identity needs no family', async () => {
  const f = fixture(normal);
  const [a, b] = await Promise.all([f.services.auth.login(), f.services.auth.login()]);
  assert.equal(a.user.id, b.user.id);
  assert.equal(f.logins(), 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].header.Authorization, undefined);
  assert.deepEqual(plain(await f.services.family.listAccessibleFamilies()), []);
  assert.equal((await f.services.auth.getIdentity()).user.id, 'user');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer test-token');
  assert.deepEqual(plain(await f.services.family.getSelection()), { familyId: '', childId: '' });
  assert.equal(f.restore().auth.hasSession(), true);
});

test('401 clears credential and family/child; does not silently login or replay', async () => {
  let expired = false;
  const f = fixture(args => expired ? args.success({ statusCode: 401 }) : normal(args));
  await f.services.auth.login();
  await f.services.family.selectFamily('family');
  await f.services.family.selectChild('baby');
  expired = true;
  const before = f.calls.length;
  await assert.rejects(f.services.children.list(), e => e.status === 401);
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.logins(), 1);
  assert.equal(f.storage.size, 0);
  assert.equal(f.services.auth.hasSession(), false);
  assert.deepEqual(plain(await f.services.family.getSelection()), { familyId: '', childId: '' });
});

test('family switching clears child; late response cannot restore previous family', async () => {
  let delayed;
  const f = fixture(args => args.url.endsWith('/families/slow') ? delayed = args : normal(args));
  await f.services.auth.login();
  await f.services.family.selectFamily('family');
  await f.services.family.selectChild('baby');
  const old = f.services.family.selectFamily('slow');
  await f.services.family.selectFamily('new');
  delayed.success({ statusCode: 200, data: { id: 'slow' } });
  await assert.rejects(old, /选择已变化/);
  assert.deepEqual(plain(await f.services.family.getSelection()), { familyId: 'new', childId: '' });
});

test('late child read after switching family is rejected; forbidden scope clears selection', async () => {
  let delayed;
  let forbidden = false;
  const f = fixture(args => {
    if (args.url.endsWith('/children/baby')) delayed = args;
    else if (forbidden) args.success({ statusCode: 404 });
    else normal(args);
  });
  await f.services.auth.login();
  await f.services.family.selectFamily('family');
  const old = f.services.family.selectChild('baby');
  await f.services.family.selectFamily('new');
  delayed.success({ statusCode: 200, data: { id: 'baby' } });
  await assert.rejects(old, /选择已变化/);
  forbidden = true;
  await assert.rejects(f.services.children.list(), e => e.status === 404);
  assert.equal((await f.services.family.getSelection()).familyId, '');
  assert.equal(f.services.auth.hasSession(), true);
});

test('logout clears local selection/storage even if server cannot be reached', async () => {
  const f = fixture(args => args.url.endsWith('/logout') ? args.fail({}) : normal(args));
  await f.services.auth.login();
  await f.services.family.selectFamily('family');
  await assert.rejects(f.services.auth.logout(), /服务器退出未确认/);
  assert.equal(f.services.auth.hasSession(), false);
  assert.equal(f.storage.size, 0);
  assert.equal((await f.services.family.getSelection()).familyId, '');
});

test('late login cannot resurrect a logged-out session', async () => {
  let delayed;
  const f = fixture(args => { delayed = args; });
  const login = f.services.auth.login();
  await new Promise(resolve => setImmediate(resolve));
  await f.services.auth.logout();
  delayed.success({ statusCode: 200, data: { accessToken: 'late', expiresAt: future(), user: { id: 'user' } } });
  await assert.rejects(login, /登录已取消/);
  assert.equal(f.storage.size, 0);
});

test('old request 401 does not invalidate newer login token', async () => {
  let delayed;
  let count = 0;
  const f = fixture(args => {
    if (args.url.endsWith('/auth/wechat/login')) args.success({ statusCode: 200, data: { accessToken: `token-${++count}`, expiresAt: future(), user: { id: 'user' } } });
    else delayed = args;
  });
  await f.services.auth.login();
  const old = f.services.auth.getIdentity();
  await f.services.auth.login();
  delayed.success({ statusCode: 401 });
  await assert.rejects(old, e => e.status === 401);
  assert.equal(f.services.auth.hasSession(), true);
});

test('unimplemented services reject without Mock or network writes', async () => {
  const f = fixture(normal);
  for (const action of [
    () => f.services.auth.switchPrototypeUser('user')]) await assert.rejects(action(), /尚未接入/);
  assert.equal(f.calls.length, 0);
});

test('network, HTML 502, rate limit and invalid login are errors, retry uses a fresh code', async () => {
  let count = 0;
  const f = fixture(args => {
    count++;
    if (count === 1) args.fail({});
    else if (count === 2) args.success({ statusCode: 502, data: '<html>proxy error</html>' });
    else if (count === 3) args.success({ statusCode: 429 });
    else if (count === 4) args.success({ statusCode: 200, data: {} });
    else normal(args);
  });
  for (let i = 0; i < 4; i++) await assert.rejects(f.services.auth.login());
  await f.services.auth.login();
  assert.equal(f.logins(), 5);
});

test('expired stored session cannot be restored; storage is isolated by API host', async () => {
  const f = fixture(normal);
  f.storage.set('growth_diary_session_v1:https://test.invalid/api/v1', { accessToken: 'old', expiresAt: '2000-01-01' });
  assert.equal(f.restore().auth.hasSession(), false);
  await assert.rejects(f.restore().auth.getIdentity(), e => e.status === 401);
});

test('API override is accepted only in develop devtools; release/trial ignore it', () => {
  for (const [envVersion, platform, development] of [
    ['develop', 'devtools', true], ['release', 'devtools', false], ['trial', 'devtools', false], ['develop', 'ios', false],
  ]) {
    const wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }), getDeviceInfo: () => ({ platform }),
      getStorageSync: () => 'http://127.0.0.1:13000/api/v1',
    };
    const config = load('../miniprogram/services/api-config.ts', { wx }).getApiConfig();
    assert.equal(config.development, development);
    assert.equal(config.baseUrl, development ? 'http://127.0.0.1:13000/api/v1' : 'https://api.daftjiang.cn/api/v1');
  }
});

test('writes serialize exact DTOs and never replay after an ambiguous network failure', async () => {
  const f = fixture(normal);
  await f.services.auth.login();
  await f.services.family.selectFamily('family');
  await f.services.children.save({ id: 'baby', name: '宝宝', birthday: '2025-01-01', genderLabel: '宝宝', avatarColor: '#F0A58A', familyId: 'forged' });
  assert.equal(f.calls.at(-1).method, 'PUT');
  assert.deepEqual(plain(f.calls.at(-1).data), { name: '宝宝', birthday: '2025-01-01', genderLabel: '宝宝', avatarColor: '#F0A58A' });
  await f.services.family.updateMemberRole('member', 'ADMIN');
  assert.equal(f.calls.at(-1).method, 'PUT');
  await f.services.systemAdmin.approveFamilyCreation('user', '核实');
  assert.deepEqual(plain(f.calls.at(-1).data), { reason: '核实' });
  let writes = 0;
  const failed = fixture(args => args.url.endsWith('/families') ? (writes++, args.fail({})) : normal(args));
  await failed.services.auth.login();
  await assert.rejects(failed.services.family.createFamily('家庭'), /操作结果未确认/);
  assert.equal(writes, 1);
});

test('growth page reads all 205 metrics by cursor, deduplicates and keeps correct latest value', async () => {
  const all = Array.from({ length: 205 }, (_, index) => ({ id: String(205 - index).padStart(4, '0'), measuredAt: '2025-01-01', value: 205 - index, unit: 'cm', type: 'HEIGHT' }));
  const queries = [];
  const services = {
    family: { getSelection: async () => ({ childId: 'baby' }) },
    children: { list: async () => [{ id: 'baby' }] },
    entries: { metrics: async (child, type, cursor) => {
      queries.push([child, type, cursor]);
      const offset = Number(cursor || 0);
      return { items: all.slice(offset, offset + 100), nextCursor: offset + 100 < all.length ? String(offset + 100) : undefined };
    }, list: () => { throw new Error('Must not read entry page'); } },
  };
  let page;
  load('../miniprogram/pages/growth/index.ts', {
    Page: definition => { page = definition; },
    require: name => name.endsWith('services/index') ? { services } : name.includes('http-services') ? { ApiError: Error } : { formatDate: value => value },
  });
  page.setData = patch => Object.assign(page.data, patch);
  await page.loadData();
  assert.equal(page.data.latestLabel, '205cm');
  await page.loadMore(); await page.loadMore();
  assert.equal(page.data.metrics.length, 205);
  assert.equal(page.data.points.length, 30);
  assert.equal(page.data.latestLabel, '205cm');
  assert.equal(page.data.nextCursor, '');
  assert.equal(queries.length, 3);
  page.renderMetrics([...all, all[0]], '');
  assert.equal(page.data.metrics.length, 205);
});

test('publish retains failed draft and reuses immutable request ID; changing account cannot restore it', async () => {
  const saved = new Map();
  const writes = [];
  let actor = 'user';
  let ids = 0;
  const services = {
    uploads: { quota: async () => ({ enabled: false }) },
    auth: { getSession: async () => ({ user: { id: actor }, family: { id: 'family' } }) },
    family: { getSelection: async () => ({ childId: 'baby' }) },
    children: { list: async () => [{ id: 'baby' }] },
    entries: { save: async draft => { writes.push(plain(draft)); if (writes.length === 1) throw new Error('network timeout'); return { id: 'created' }; } },
  };
  let page;
  const wx = { getStorageSync: key => saved.get(key), setStorageSync: (key, value) => saved.set(key, plain(value)),
    removeStorageSync: key => saved.delete(key), setNavigationBarTitle() {}, showToast() {}, switchTab() {} };
  load('../miniprogram/pages/publish/index.ts', { wx, Page: definition => { page = definition; },
    require: name => {
      if (name.endsWith('services/index')) return { services };
      if (name.endsWith('entry-draft')) return { ENTRY_DRAFT_KEY: 'draft', createRequestId: async () => `request-${++ids}` };
      if (name.includes('http-services')) return { ApiError: class extends Error {} };
      return { today: () => '2025-01-01' };
    },
  });
  page.setData = patch => Object.assign(page.data, patch);
  await page.onShow();
  page.inputTitle({ detail: { value: '失败不丢失' } });
  page.data.linkedAssetIds = ['already-uploaded'];
  await page.submit();
  assert.equal(page.data.pending, true);
  assert.equal(saved.get('draft').draft.title, '失败不丢失');
  page.inputTitle({ detail: { value: '不得改变重试内容' } });
  await page.onShow();
  await page.submit();
  assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(writes[1].assetIds, ['already-uploaded']);
  assert.equal(ids, 1);
  assert.equal(saved.has('draft'), false);
  await page.onShow();
  page.inputTitle({ detail: { value: '另一个草稿' } });
  actor = 'other';
  await page.onShow();
  assert.equal(page.data.title, '');
  assert.equal(saved.has('draft'), false);
});

test('write flow through Postman HTTP: approval, creation, nickname, invite, child and member maintenance', { skip: !process.env.GROWTH_SIM_URL }, async () => {
  const f = fixture(args => {
    fetch(args.url, { method: args.method, headers: args.header, body: args.data ? JSON.stringify(args.data) : undefined,
      signal: AbortSignal.timeout(args.timeout),
    }).then(async response => args.success({ statusCode: response.status, data: response.status === 204 ? undefined : await response.json() })).catch(args.fail);
  }, { code: 'writes', baseUrl: process.env.GROWTH_SIM_URL });
  await f.services.auth.login();
  await assert.rejects(f.services.family.createFamily('测试家庭'), e => e.status === 403);
  await f.services.systemAdmin.approveFamilyCreation('user', '已核实');
  assert.equal((await f.services.family.creationStatus()).canCreate, true);
  const family = await f.services.family.createFamily('测试家庭');
  assert.equal((await f.services.family.creationStatus()).canCreate, false);
  await assert.rejects(f.services.family.createFamily('重复家庭'), e => e.status === 403);
  assert.equal((await f.services.auth.updateNickname('新昵称')).user.nickname, '新昵称');
  await f.services.family.selectFamily(family.id);
  assert.equal((await f.services.family.listMembers())[0].role, 'OWNER');
  const invite = await f.services.family.createInvite();
  assert.equal((await f.services.family.joinFamily(invite.code)).id, family.id);
  const draft = { name: '新增宝宝', birthday: '2025-01-01', genderLabel: '宝宝', avatarColor: '#F0A58A' };
  const baby = await f.services.children.save(draft);
  assert.equal((await f.services.children.save({ ...draft, id: baby.id, name: '编辑宝宝' })).name, '编辑宝宝');
  assert.equal((await f.services.family.updateMemberRole('member', 'ADMIN')).role, 'ADMIN');
  await f.services.family.removeMember('member');
  await f.services.auth.logout();
});

test('record HTTP flow: idempotent retry, years before pagination, edits, metrics over 200 and delete', { skip: !process.env.GROWTH_SIM_URL }, async () => {
  const f = fixture(args => {
    fetch(args.url, { method: args.method, headers: args.header, body: args.data ? JSON.stringify(args.data) : undefined,
      signal: AbortSignal.timeout(args.timeout),
    }).then(async response => args.success({ statusCode: response.status, data: response.status === 204 ? undefined : await response.json() })).catch(args.fail);
  }, { code: 'records', baseUrl: process.env.GROWTH_SIM_URL });
  await f.services.auth.login();
  const family = (await f.services.family.listAccessibleFamilies())[0];
  await f.services.family.selectFamily(family.id);
  const child = (await f.services.children.list())[0];
  const draft = { requestId: require('node:crypto').randomUUID(), childId: child.id, kind: 'DIARY', title: '文字记录', body: '正文', occurredAt: '2024-12-31', assetIds: [] };
  const entry = await f.services.entries.save(draft);
  assert.equal((await f.services.entries.save(draft)).id, entry.id);
  await f.services.entries.save({ ...draft, requestId: require('node:crypto').randomUUID(), occurredAt: '2025-01-01' });
  assert.deepEqual(plain(await f.services.entries.listYears(child.id)), ['2025', '2024']);
  const page = await f.services.entries.list({ childId: child.id, year: '2024', pageSize: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.nextCursor, undefined);
  await f.services.entries.save({ ...draft, id: entry.id, title: '编辑后' });
  assert.equal((await f.services.entries.get(entry.id)).title, '编辑后');
  const metrics = [];
  let cursor;
  do {
    const page = await f.services.entries.metrics(child.id, 'HEIGHT', cursor);
    metrics.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(metrics.length, 205); assert.equal(metrics[0].value, 205);
  await f.services.entries.deletePermanent(entry.id);
  await assert.rejects(f.services.entries.save(draft), error => error.status === 404);
});

test('stage 3.1 exposes only read entry and has no Mock dependency at service entry', () => {
  const app = JSON.parse(fs.readFileSync(require.resolve('../miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/wall/index'));
  assert.ok(app.pages.includes('pages/publish/index'));
  assert.ok(app.pages.includes('pages/growth/index'));
  assert.ok(!app.pages.includes('pages/profile/index'));
  assert.equal(app.tabBar.list.length, 3);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../miniprogram/services/index.ts'), 'utf8'), /mock-services/);
});

test('read page supports no-family, no-child, detail and logout without retaining prior data', async () => {
  const f = fixture(normal);
  let page;
  load('../miniprogram/pages/select-family/index.ts', {
    Page: definition => { page = definition; },
    require: name => {
      if (name.endsWith('services/index')) return { services: f.services, apiConfig: { development: true } };
      if (name.endsWith('http-services')) return { ApiError: class extends Error {} };
      return { calculateAge: () => '1岁' };
    },
  });
  page.setData = patch => Object.assign(page.data, patch);
  await page.login();
  assert.equal(page.data.session.user.id, 'user');
  assert.equal(page.data.families.length, 0);
  assert.equal(page.data.error, '');
  await page.loadFamily('family');
  assert.equal(page.data.selectedFamily.id, 'family');
  assert.equal(page.data.children.length, 0);
  await page.chooseChild({ currentTarget: { dataset: { id: 'baby' } } });
  assert.equal(page.data.selectedChild.id, 'baby');
  await page.loadFamilies();
  assert.equal(page.data.selectedChild, null);
  assert.equal(page.data.selectedFamily, null);
  await page.logout();
  assert.equal(page.data.session, null);
  assert.equal(page.data.children.length, 0);
  assert.equal(page.data.families.length, 0);
});

test('real HTTP transport against local Postman simulation: login, scope, empty lists, expiry, logout', {
  skip: !process.env.GROWTH_SIM_URL,
}, async () => {
  for (const code of ['valid', 'no-family', 'no-child', 'expired']) {
    const f = fixture(args => {
      fetch(args.url, { method: args.method, headers: args.header,
        body: args.data ? JSON.stringify(args.data) : undefined,
        signal: AbortSignal.timeout(args.timeout),
      }).then(async response => args.success({ statusCode: response.status,
        data: response.status === 204 ? undefined : await response.json(),
      })).catch(error => args.fail(error));
    }, { code, baseUrl: process.env.GROWTH_SIM_URL });
    await f.services.auth.login();
    if (code === 'expired') {
      await assert.rejects(f.services.auth.getIdentity(), e => e.status === 401);
      assert.equal(f.services.auth.hasSession(), false);
      continue;
    }
    assert.equal((await f.services.auth.getIdentity()).user.id, 'user');
    const families = await f.services.family.listAccessibleFamilies();
    if (code === 'no-family') assert.equal(families.length, 0);
    else {
      await f.services.family.selectFamily(families[0].id);
      const children = await f.services.children.list();
      if (code === 'no-child') assert.equal(children.length, 0);
      else assert.equal((await f.services.family.selectChild(children[0].id)).name, '测试宝宝');
    }
    await f.services.auth.logout();
    assert.equal(f.services.auth.hasSession(), false);
  }
});


test('governance sends explicit consent and deletion confirmation, and clears selection only on leave', async () => {
  const f = fixture(normal);
  await f.services.governance.documents();
  assert.equal(f.calls.at(-1).header.Authorization, undefined);
  await f.services.auth.login();
  await f.services.governance.accept('a'.repeat(64));
  assert.deepEqual(plain(f.calls.at(-1).data), { version: 'a'.repeat(64), accepted: true, guardian: true });
  await f.services.governance.list(2, true);
  assert.match(f.calls.at(-1).url, /governance\/admin\/requests\?page=2/);
  await f.services.family.selectFamily('family');
  await f.services.governance.submit({ requestId: 'request', kind: 'DATA_DELETE', familyId: 'family', entryId: 'entry', reason: 'selected record' });
  assert.equal(f.calls.at(-1).data.entryId, 'entry');
  await f.services.governance.execute('request');
  assert.match(f.calls.at(-1).url, /governance\/requests\/request\/execute$/);
  assert.deepEqual(plain(f.calls.at(-1).data), { confirmed: true });
  assert.equal((await f.services.family.getSelection()).familyId, 'family');
  await f.services.governance.transfer('member');
  assert.match(f.calls.at(-1).url, /families\/family\/owner\/member$/);
  await f.services.governance.leave();
  assert.equal((await f.services.family.getSelection()).familyId, '');
});
test('policy-required response routes to consent without deleting the login credential', async () => {
  let gated = false, page = '';
  const f = fixture(args => gated ? args.success({ statusCode: 428 }) : normal(args));
  f.wx.reLaunch = ({ url }) => { page = url; };
  await f.services.auth.login(); gated = true;
  await assert.rejects(f.services.family.listAccessibleFamilies(), /隐私/);
  assert.equal(page, '/pages/governance/index');
  assert.equal(f.services.auth.hasSession(), true);
});

test('admin overview uses authenticated global endpoint without selecting a family; errors are preserved', async () => {
  const counts = { familyCount: 0, userCount: 1, childCount: 0, entryCount: 0, assetCount: 0 };
  let status = 200;
  const f = fixture(args => args.url.endsWith('/admin/dashboard')
    ? args.success({ statusCode: status, data: counts }) : normal(args));
  await assert.rejects(f.services.systemAdmin.getDashboard(), e => e.status === 401);
  await f.services.auth.login();
  assert.deepEqual(plain(await f.services.systemAdmin.getDashboard()), counts);
  assert.equal(f.calls.at(-1).method, 'GET');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer test-token');
  for (status of [403, 500, 401]) await assert.rejects(f.services.systemAdmin.getDashboard(), e => e.status === status);
  assert.equal(f.services.auth.hasSession(), false);
});

function adminPage(services, prompt = async () => null, confirm = async () => false) {
  let page;
  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  load('../miniprogram/pages/system-admin/index.ts', {
    Page: value => { page = value; }, Error, wx: {},
    require: name => name.endsWith('http-services') ? { ApiError } : name.endsWith('dialog') ? { promptText: prompt, confirmAction: confirm } : { services },
  });
  page.setData = values => Object.assign(page.data, values);
  return page;
}

test('admin page denies ordinary users; zero counts display and refresh failures clear old totals', async () => {
  let role = 'USER', calls = 0, failure = false;
  const counts = { familyCount: 0, userCount: 1, childCount: 0, entryCount: 0, assetCount: 0 };
  const page = adminPage({
    auth: { getIdentity: async () => ({ user: { systemRole: role } }) },
    systemAdmin: { getDashboard: async () => { calls++; if (failure) throw new Error('无权限'); return counts; } },
  });
  await page.onShow();
  assert.equal(calls, 0);
  assert.match(page.data.error, /仅系统管理员/);
  role = 'SYSTEM_ADMIN';
  await page.loadDashboard();
  assert.deepEqual(page.data.dashboard, counts);
  assert.equal(page.data.loading, false);
  failure = true;
  await page.loadDashboard();
  assert.equal(page.data.dashboard, null);
  assert.equal(page.data.error, '无权限');
  assert.equal(page.data.updatedAt, '');
});

test('admin page discards late responses after hide and does not duplicate refresh requests', async () => {
  let finish, calls = 0;
  const page = adminPage({
    auth: { getIdentity: async () => ({ user: { systemRole: 'SYSTEM_ADMIN' } }) },
    systemAdmin: { getDashboard: () => { calls++; return new Promise(resolve => { finish = resolve; }); } },
  });
  const pending = page.onShow();
  await Promise.resolve();
  await page.loadDashboard();
  assert.equal(calls, 1);
  page.onHide();
  finish({ familyCount: 99 });
  await pending;
  assert.equal(page.data.dashboard, null);
  assert.equal(page.data.loading, false);
});

test('admin list services send bounded pagination and authorization without a family selection', async () => {
  const f = fixture(normal);
  await f.services.auth.login();
  for (const [method, path] of [['listFamilies', 'families'], ['listUsers', 'users']]) {
    await f.services.systemAdmin[method](2);
    assert.match(f.calls.at(-1).url, new RegExp(`/admin/${path}\\?page=2&pageSize=20$`));
    assert.equal(f.calls.at(-1).header.Authorization, 'Bearer test-token');
    assert.equal(f.calls.at(-1).method, 'GET');
  }
});

test('admin lists page, retry the failed page, switch kind and discard late family results', async () => {
  let fail = false, delayed, calls = [];
  const page = adminPage({ systemAdmin: {
    listFamilies: async n => {
      calls.push(n);
      if (fail) throw new Error('网络失败');
      if (n === 3) return new Promise(resolve => { delayed = resolve; });
      return { items: [{ family: { id: `f${n}`, name: '家庭' }, ownerName: '创建者', childCount: 0, entryCount: 2, assetCount: 1 }], page: n, hasMore: true };
    },
    listUsers: async n => ({ items: [{ user: { id: 'u', nickname: '用户', systemRole: 'SYSTEM_ADMIN' }, familyCount: 1, entryCount: 0 }], page: n, hasMore: false }),
  } });
  page.setData({ dashboard: {} });
  await page.refreshList();
  assert.equal(page.data.rows[0].id, 'f1');
  fail = true;
  await page.nextPage();
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.listPage, 2);
  assert.equal(page.data.listError, '网络失败');
  fail = false;
  await page.retryList();
  assert.deepEqual(calls, [1, 2, 2]);
  assert.equal(page.data.rows[0].id, 'f2');
  const pending = page.nextPage();
  await page.chooseList({ currentTarget: { dataset: { kind: 'users' } } });
  delayed({ items: [], page: 3, hasMore: true });
  await pending;
  assert.equal(page.data.rows[0].id, 'u');
  assert.match(page.data.rows[0].detail, /系统管理员/);
  assert.equal(page.data.hasMore, false);
  page.onHide();
  assert.equal(page.data.rows.length, 0);
});

test('admin lists clear every managed view on permission loss and handle empty results', async () => {
  const { ApiError } = load('../miniprogram/services/http-services.ts', { require: () => ({}) });
  // Use the same error class as the page so this exercises the authorization branch.
  let page;
  load('../miniprogram/pages/system-admin/index.ts', {
    Page: value => { page = value; }, Error, wx: {},
    require: name => name.endsWith('http-services') ? { ApiError } : { services: { systemAdmin: {
      listFamilies: async () => { throw new ApiError('权限已撤销', 403); },
      listUsers: async () => ({ items: [], page: 1, hasMore: false }),
    } } },
  });
  page.setData = values => Object.assign(page.data, values);
  page.setData({ dashboard: {} });
  await page.chooseList({ currentTarget: { dataset: { kind: 'users' } } });
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.hasMore, false);
  await page.chooseList({ currentTarget: { dataset: { kind: 'families' } } });
  assert.equal(page.data.dashboard, null);
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.error, '权限已撤销');
  assert.equal(page.data.listLoading, false);
});


test('failure API keeps kind/page and explicit reason, with no family content request', async () => {
  const f = fixture(normal); await f.services.auth.login();
  await f.services.systemAdmin.failedTasks('DELETION', 2);
  assert.match(f.calls.at(-1).url, /failed-tasks\?kind=DELETION&page=2&pageSize=20$/);
  await f.services.systemAdmin.retryMedia('task', '存储恢复');
  assert.equal(f.calls.at(-1).method, 'PUT');
  assert.match(f.calls.at(-1).url, /failed-tasks\/media\/task\/retry$/);
  assert.deepEqual(plain(f.calls.at(-1).data), { reason: '存储恢复' });
});

test('failure UI displays diagnosis and submits only eligible media with a reason', async () => {
  const calls = [];
  const page = adminPage({ systemAdmin: {
    failedTasks: async kind => ({ page: 1, hasMore: false, items: [{ id: 'job', kind, familyId: 'family', status: 'PENDING',
      error: 'PROCESSING_RETRY', updatedAt: '2026-10-27T00:00:00Z', attempts: null, nextAttemptAt: null, canRetry: kind === 'MEDIA', cleaned: null }] }),
    retryMedia: async (...args) => { calls.push(args); },
  } }, async () => '存储恢复');
  page.setData({ dashboard: {} });
  await page.chooseList({ currentTarget: { dataset: { kind: 'MEDIA' } } });
  assert.match(page.data.rows[0].detail, /PROCESSING_RETRY/);
  assert.match(page.data.rows[0].guidance, /worker/);
  await page.retryTask({ currentTarget: { dataset: { id: 'unknown' } } });
  await page.retryTask({ currentTarget: { dataset: { id: 'job' } } });
  assert.deepEqual(calls, [['job', '存储恢复']]);
  assert.match(page.data.actionMessage, /已重新排队/);
  await page.chooseList({ currentTarget: { dataset: { kind: 'EXPORT' } } });
  await page.retryTask({ currentTarget: { dataset: { id: 'job' } } });
  assert.equal(calls.length, 1);
});

test('media confirmation is discarded after leaving and empty reasons cannot submit', async () => {
  let finish, calls = 0;
  const page = adminPage({ systemAdmin: { retryMedia: async () => { calls++; } } },
    () => new Promise(resolve => { finish = resolve; }));
  page.setData({ dashboard: {}, listKind: 'MEDIA', rows: [{ id: 'task', canRetry: true }] });
  let pending = page.retryTask({ currentTarget: { dataset: { id: 'task' } } });
  finish(''); await pending;
  assert.equal(calls, 0); assert.match(page.data.actionMessage, /400/);
  pending = page.retryTask({ currentTarget: { dataset: { id: 'task' } } });
  page.onHide(); finish('存储恢复'); await pending;
  assert.equal(calls, 0); assert.equal(page.data.retrying, false);
});


test('admin member maintenance uses wx-supported PUT and DELETE with reasons; audit filters are encoded', async () => {
  const f = fixture(normal); await f.services.auth.login();
  await f.services.systemAdmin.listMembers('family', 2);
  assert.match(f.calls.at(-1).url, /admin\/families\/family\/members\?page=2&pageSize=20$/);
  await f.services.systemAdmin.updateMemberRole('family', 'member', 'ADMIN', '已核实');
  assert.equal(f.calls.at(-1).method, 'PUT');
  assert.deepEqual(plain(f.calls.at(-1).data), { role: 'ADMIN', reason: '已核实' });
  await f.services.systemAdmin.removeMember('family', 'member', '本人申请');
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.deepEqual(plain(f.calls.at(-1).data), { reason: '本人申请' });
  await f.services.systemAdmin.audits(2, { familyId: 'family', actorId: 'actor', action: 'A&B' });
  assert.match(f.calls.at(-1).url, /audit-logs\?page=2&pageSize=20&familyId=family&actorId=actor&action=A%26B$/);
});

test('member UI protects owner and self, confirms role/removal and refreshes after mutation', async () => {
  const mutations = [], confirmations = [];
  const members = ['OWNER', 'ADMIN', 'MEMBER'].map((role, i) => ({ id: `m${i}`, role, userId: `u${i}`, user: { nickname: `用户${i}` }, joinedAt: 'now' }));
  const page = adminPage({ systemAdmin: {
    listMembers: async () => ({ items: members, page: 1, hasMore: false }),
    updateMemberRole: async (...args) => { mutations.push(args); },
    removeMember: async (...args) => { mutations.push(args); },
  } }, async () => '核实申请', async (title, text) => { confirmations.push(text); return true; });
  page.setData({ dashboard: {}, actorId: 'u1', rows: [{ id: 'family', name: '家庭' }] });
  await page.openMembers({ currentTarget: { dataset: { id: 'family' } } });
  assert.deepEqual(page.data.rows.map(r => r.canManage), [false, false, true]);
  for (const id of ['m0', 'm1']) await page.maintainMember({ currentTarget: { dataset: { id, action: 'remove' } } });
  assert.equal(mutations.length, 0);
  await page.maintainMember({ currentTarget: { dataset: { id: 'm2', action: 'role' } } });
  assert.deepEqual(mutations[0], ['family', 'm2', 'ADMIN', '核实申请']);
  assert.match(confirmations[0], /m2/);
  await page.maintainMember({ currentTarget: { dataset: { id: 'm2', action: 'remove' } } });
  assert.deepEqual(mutations[1], ['family', 'm2', '核实申请']);
  assert.match(confirmations[1], /已有记录保留/);
  assert.equal(page.data.retrying, false);
});

test('member confirmation discarded on hide and uncertain write clears stale action buttons', async () => {
  let finish, writes = 0;
  const services = { systemAdmin: { removeMember: async () => { writes++; throw new Error('网络中断，请先刷新'); } } };
  const page = adminPage(services, async () => '理由', () => new Promise(resolve => { finish = resolve; }));
  page.setData({ dashboard: {}, listKind: 'members', memberFamilyId: 'family', rows: [{ id: 'm', name: '成员', canManage: true }] });
  let pending = page.maintainMember({ currentTarget: { dataset: { id: 'm', action: 'remove' } } });
  await new Promise(setImmediate); page.onHide(); finish(true); await pending;
  assert.equal(writes, 0);
  page.setData({ dashboard: {}, listKind: 'members', memberFamilyId: 'family', rows: [{ id: 'm', name: '成员', canManage: true }] });
  pending = page.maintainMember({ currentTarget: { dataset: { id: 'm', action: 'remove' } } });
  await new Promise(setImmediate); finish(true); await pending;
  assert.equal(writes, 1); assert.equal(page.data.rows.length, 0);
  assert.match(page.data.actionMessage, /刷新/);
});

test('audit query validates drafts and pagination keeps applied filters until Apply', async () => {
  const queries = [];
  const page = adminPage({ systemAdmin: { audits: async (n, filter) => {
    queries.push([n, plain(filter)]);
    return { page: n, hasMore: true, items: [{ id: 'a', actorId: 'actor', familyId: null, action: 'SYSTEM_MEMBER_REMOVE', targetType: 'membership', targetId: 'm', reason: '核实', createdAt: 'now' }] };
  } } });
  page.setData({ dashboard: {}, listKind: 'audits', auditFamily: 'invalid' });
  await page.applyAuditFilter(); assert.equal(queries.length, 0);
  page.setData({ auditFamily: '', auditAction: 'SYSTEM_MEMBER_REMOVE' });
  await page.applyAuditFilter();
  assert.match(page.data.rows[0].detail, /无关联家庭/);
  assert.equal(page.data.rows[0].guidance, '原因：核实');
  page.setData({ auditAction: 'UNAPPLIED' });
  await page.nextPage();
  assert.deepEqual(queries.at(-1), [2, { action: 'SYSTEM_MEMBER_REMOVE' }]);
  await page.clearAuditFilter(); assert.deepEqual(queries.at(-1), [1, {}]);
});


test('admin quota API uses explicit family and numeric bytes without changing selection', async () => {
  const f = fixture(normal); await f.services.auth.login();
  await f.services.systemAdmin.quota('target');
  assert.match(f.calls.at(-1).url, /admin\/families\/target\/storage$/);
  await f.services.systemAdmin.setQuota('target', 1048576, '批准调整');
  assert.equal(f.calls.at(-1).method, 'PUT');
  assert.deepEqual(plain(f.calls.at(-1).data), { quotaBytes: 1048576, reason: '批准调整' });
  assert.equal((await f.services.family.getSelection()).familyId, '');
});

test('quota UI validates units and occupied space, confirms and displays returned authoritative usage', async () => {
  const mib = 1048576, writes = [], confirmations = [];
  const quota = { enabled: false, quotaBytes: 10 * mib, usedBytes: mib, reservedBytes: mib };
  const page = adminPage({ systemAdmin: {
    quota: async () => quota,
    setQuota: async (...args) => { writes.push(args); return { ...quota, quotaBytes: args[1], reservedBytes: 2 * mib }; },
  } }, async () => '批准调整', async (_title, message) => { confirmations.push(message); return true; });
  page.setData({ dashboard: {}, rows: [{ id: 'family', name: '家庭' }] });
  await page.openQuota({ currentTarget: { dataset: { id: 'family' } } });
  assert.equal(page.data.quota.enabled, false);
  assert.equal(page.data.listPage, 0);
  for (const input of ['0', '-1', '1.5', '1e2', '1048577', '1', '10']) {
    page.setData({ quotaMiB: input }); await page.saveQuota();
  }
  assert.equal(writes.length, 0);
  page.setData({ quotaMiB: '20' }); await page.saveQuota();
  assert.deepEqual(writes[0], ['family', 20 * mib, '批准调整']);
  assert.match(confirmations[0], /family/);
  assert.equal(page.data.quota.reservedBytes, 2 * mib);
  assert.equal(page.data.quotaMiB, '');
});

test('quota write failure clears stale quota and leaving during confirmation cancels submission', async () => {
  let writes = 0, finish;
  const quota = { enabled: true, quotaBytes: 1048576, usedBytes: 0, reservedBytes: 0 };
  const page = adminPage({ systemAdmin: { setQuota: async () => { writes++; throw new Error('冲突或网络异常'); } } },
    async () => '理由', () => new Promise(resolve => { finish = resolve; }));
  const setup = () => page.setData({ dashboard: {}, listKind: 'quota', memberFamilyId: 'f', quota, quotaMiB: '2' });
  setup(); let pending = page.saveQuota();
  await new Promise(setImmediate); page.onHide(); finish(true); await pending;
  assert.equal(writes, 0);
  setup(); pending = page.saveQuota(); await new Promise(setImmediate); finish(true); await pending;
  assert.equal(writes, 1); assert.equal(page.data.quota, null); assert.equal(page.data.retrying, false);
  assert.match(page.data.actionMessage, /刷新配额/);
});
