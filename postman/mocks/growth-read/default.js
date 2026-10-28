// Local contract fixture from backend/docs/{auth,families,children}.md; never production data.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const tokens = new Map();
let approved = false, created = false;
let nickname = '测试用户';
let records = [], requests = new Map();
const family = { id: '11111111-1111-4111-8111-111111111111', name: '测试家庭', ownerId: 'user', createdAt: '2026-01-01T00:00:00.000Z' };
const child = { id: '22222222-2222-4222-8222-222222222222', familyId: family.id, creatorId: 'user', name: '测试宝宝', birthday: '2025-01-01', genderLabel: '宝宝', avatarColor: '#F0A58A', createdAt: family.createdAt };
http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? undefined : JSON.stringify(data)); };
  const url = new URL(req.url, 'http://simulation');
  const path = url.pathname;
  if (req.method === 'POST' && path === '/api/v1/auth/wechat/login') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let code;
    try { code = JSON.parse(body).code; } catch { return send(400, {}); }
    if (!['valid', 'no-family', 'no-child', 'expired', 'writes', 'records'].includes(code)) return send(400, {});
    if (code === 'records') { records = []; requests = new Map(); }
    if (code === 'writes') { approved = false; created = false; nickname = '测试用户'; }
    child.name = '测试宝宝';
    const accessToken = `simulation-${code}`;
    tokens.set(accessToken, code);
    return send(200, { accessToken, tokenType: 'Bearer', expiresAt: new Date(Date.now() + 3600000).toISOString(), user: { id: 'user', nickname: '测试用户', avatarText: '我' } });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const code = tokens.get(token);
  if (!code || code === 'expired') return send(401, {});
  if (req.method === 'POST' && path === '/api/v1/auth/logout') { tokens.delete(token); return send(204); }
  const entryPath = `/api/v1/families/${family.id}/entries`;
  if (code === 'records' && (path.startsWith(entryPath) || path === `/api/v1/families/${family.id}/metrics`)) {
    if (req.method === 'GET') {
      if (path.endsWith('/metrics')) {
        const start = Number(url.searchParams.get('cursor') || 0);
        const items = Array.from({ length: Math.min(100, 205 - start) }, (_, offset) => ({
          id: `00000000-0000-4000-8000-${String(205 - start - offset).padStart(12, '0')}`,
          familyId: family.id, childId: child.id, creatorId: 'user', entryId: child.id,
          type: 'HEIGHT', value: 205 - start - offset, unit: 'cm', measuredAt: '2025-01-01',
        }));
        return send(200, { items, ...(start + 100 < 205 ? { nextCursor: String(start + 100) } : {}) });
      }
      if (path.endsWith('/years')) return send(200, [...new Set(records.map(record => record.occurredAt.slice(0, 4)))].sort().reverse());
      if (path === entryPath) {
        const year = url.searchParams.get('year'), size = Number(url.searchParams.get('pageSize') || 20), start = Number(url.searchParams.get('cursor') || 0);
        const found = records.filter(record => !year || record.occurredAt.startsWith(year)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
        return send(200, { items: found.slice(start, start + size), ...(start + size < found.length ? { nextCursor: String(start + size) } : {}) });
      }
      const record = records.find(record => path === `${entryPath}/${record.id}`);
      return send(record ? 200 : 404, record || {});
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, {}); }
    if (req.method === 'POST' && path === entryPath) {
      if (!body.requestId) return send(400, {});
      const prior = requests.get(body.requestId);
      const encoded = JSON.stringify(body);
      if (prior) {
        if (prior.body !== encoded) return send(409, {});
        const record = records.find(record => record.id === prior.id);
        return send(record ? 201 : 404, record || {});
      }
      const record = { ...body, id: randomUUID(), familyId: family.id, creatorId: 'user', createdAt: family.createdAt, updatedAt: family.createdAt };
      delete record.requestId;
      records.push(record); requests.set(body.requestId, { id: record.id, body: encoded });
      return send(201, record);
    }
    const record = records.find(record => path === `${entryPath}/${record.id}`);
    if (!record) return send(404, {});
    if (req.method === 'PUT') { Object.assign(record, body); return send(200, record); }
    if (req.method === 'DELETE') { records = records.filter(item => item.id !== record.id); return send(204); }
    return send(501, {});
  }
  if (code === 'writes' && req.method !== 'GET') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, {}); }
    if (req.method === 'PUT' && path === '/api/v1/auth/me') { nickname = body.nickname; return send(200, { user: { id: 'user', nickname, avatarText: '我' } }); }
    if (req.method === 'PUT' && path === '/api/v1/admin/users/user/family-creation') {
      if (!body.reason) return send(400, {});
      approved = true; return send(200, { userId: 'user', canCreate: true });
    }
    if (req.method === 'POST' && path === '/api/v1/families') {
      if (!approved || created) return send(403, {});
      created = true; return send(201, { ...family, name: body.name });
    }
    if (req.method === 'POST' && path === '/api/v1/families/join') return send(200, family);
    if (req.method === 'POST' && path === `/api/v1/families/${family.id}/invites`) return send(201, { id: 'invite', familyId: family.id, creatorId: 'user', code: 'ABCDEF0123456789', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    if ((req.method === 'POST' && path === `/api/v1/families/${family.id}/children`) || (req.method === 'PUT' && path === `/api/v1/families/${family.id}/children/${child.id}`)) {
      if (body.id || body.familyId || body.creatorId) return send(400, {});
      Object.assign(child, body); return send(req.method === 'POST' ? 201 : 200, child);
    }
    if (path === `/api/v1/families/${family.id}/members/member`) {
      if (req.method === 'DELETE') return send(204);
      if (req.method === 'PUT') return send(200, { id: 'member', familyId: family.id, userId: 'other', role: body.role, user: { id: 'other', nickname: '亲友', avatarText: '亲' } });
    }
  }
  if (req.method !== 'GET') return send(501, {});
  if (path === '/api/v1/families/creation-status') return send(200, { canCreate: code === 'writes' && approved && !created });
  if (path === '/api/v1/auth/me') return send(200, { user: { id: 'user', nickname: '测试用户', avatarText: '我' } });
  if (path === '/api/v1/families') return send(200, code === 'no-family' ? [] : [family]);
  if (code === 'no-family') return send(404, {});
  const prefix = `/api/v1/families/${family.id}`;
  if (path === prefix) return send(200, family);
  if (path === `${prefix}/members`) return send(200, [{ id: 'owner', familyId: family.id, userId: 'user', role: 'OWNER', user: { id: 'user', nickname, avatarText: '我' } }]);
  if (path === `${prefix}/children`) return send(200, code === 'no-child' ? [] : [child]);
  if (path === `${prefix}/children/${child.id}`) return send(code === 'no-child' ? 404 : 200, code === 'no-child' ? {} : child);
  return send(501, {});
}).listen(process.env.PORT);
