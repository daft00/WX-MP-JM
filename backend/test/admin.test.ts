import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HttpException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { EntityManager } from "typeorm";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { AdminService } from "../src/admin/admin.service";
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";

const actor = randomUUID(), family = randomUUID(), member = randomUUID(), targetUser = randomUUID();
const paging = { page: 1, pageSize: 20 };
const admin = [{ system_role: "SYSTEM_ADMIN" }];
const target = { id: member, family_id: family, user_id: targetUser, role: "ADMIN", joined_at: new Date(), nickname: "成员", avatar_text: "成" };
const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
function fixture(replies: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const manager = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    assert.ok(replies.length, `Unexpected SQL: ${sql}`);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  } } as unknown as EntityManager;
  const database = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager) } as DatabaseService;
  return { database, calls, service: new AdminService(database, new FamiliesService(database, new ConfigService())) };
}

test("all admin services read current database system role and deny before reading any managed data", async () => {
  for (const roles of [[], [{ system_role: "USER" }]]) {
    for (const action of ["dashboard", "families", "users", "members", "audits", "role", "remove"]) {
      const { service, calls } = fixture([roles]);
      const request = action === "dashboard" ? service.dashboard(actor) : action === "families" ? service.listFamilies(actor, paging) : action === "users" ? service.listUsers(actor, paging) :
        action === "members" ? service.members(actor, family, paging) : action === "audits" ? service.audits(actor, paging) : action === "role" ? service.changeRole(actor, family, member, { role: "MEMBER", reason: "维护" }) : service.remove(actor, family, member, "维护");
      await assert.rejects(request, status(403));
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FOR SHARE$/);
      assert.deepEqual(calls[0].params, [actor]);
    }
  }
});

test("system administration cannot modify owners, self or foreign-family member IDs", async () => {
  for (const row of [{ ...target, role: "OWNER" }, { ...target, user_id: actor }]) {
    for (const remove of [false, true]) {
      const { service, calls } = fixture([admin, [{ id: family }], [row]]);
      await assert.rejects(remove ? service.remove(actor, family, member, "维护") : service.changeRole(actor, family, member, { role: "ADMIN", reason: "维护" }), status(403));
      assert.ok(calls.every((call) => call.sql.startsWith("SELECT")));
    }
  }
  const missing = fixture([admin, [{ id: family }], []]);
  await assert.rejects(missing.service.remove(actor, family, member, "维护"), status(404));
  assert.deepEqual(missing.calls[2].params, [family, member]);
  await assert.rejects(fixture([admin, []]).service.members(actor, family, paging), status(404));
});

test("role change/removal revoke invitations and audit actor, family, target, transition and reason", async () => {
  for (const role of ["ADMIN", "MEMBER"] as const) {
    const { service, calls } = fixture([admin, [{ id: family }], [target], {}, ...(role === "MEMBER" ? [{}] : []), {}, [{ ...target, role }]]);
    assert.equal((await service.changeRole(actor, family, member, { role, reason: "家庭申请修正" })).role, role);
    assert.deepEqual(calls[3].params, [role, family, member]);
    const invalidation = calls.find((call) => call.sql.startsWith("DELETE FROM invites"));
    assert.equal(Boolean(invalidation), role === "MEMBER");
    if (invalidation) assert.deepEqual(invalidation.params, [family, targetUser]);
    const audit = calls.find((call) => call.sql.startsWith("INSERT INTO audit_logs"))!;
    assert.deepEqual(audit.params.slice(1), [actor, family, "SYSTEM_MEMBER_ROLE", "membership", member, `ADMIN -> ${role}: 家庭申请修正`]);
  }
  const removed = fixture([admin, [{ id: family }], [target], {}, {}, {}]);
  await removed.service.remove(actor, family, member, "本人申请移除");
  assert.deepEqual(removed.calls[3].params, [family, targetUser]);
  assert.match(removed.calls[4].sql, /^DELETE FROM family_members/);
  assert.equal(removed.calls[5].params[3], "SYSTEM_MEMBER_REMOVE");
  assert.match(String(removed.calls[5].params[6]), /本人申请移除$/);
  await assert.rejects(fixture([admin, [{ id: family }], [target], {}, {}, new Error("audit failed")]).service.remove(actor, family, member, "维护"), /audit failed/);
});

test("admin read projections contain counts and public identities, never media/content or login credentials", async () => {
  const counts = { familyCount: "1", userCount: "2", childCount: "3", entryCount: "4", assetCount: "5", secret: "hidden" };
  assert.deepEqual(await fixture([admin, [counts]]).service.dashboard(actor), { familyCount: 1, userCount: 2, childCount: 3, entryCount: 4, assetCount: 5 });
  const families = fixture([admin, [{ id: family, name: "家庭", owner_id: targetUser, created_at: new Date(), owner_name: "用户", child_count: "1", entry_count: "2", asset_count: "3", object_key: "secret" }]]);
  assert.equal((await families.service.listFamilies(actor, { page: 2, pageSize: 1 })).items[0].childCount, 1);
  assert.deepEqual(families.calls[1].params, [2, 1]);
  const users = fixture([admin, [{ id: targetUser, nickname: "用户", avatar_text: "用", system_role: "SYSTEM_ADMIN", family_count: "2", entry_count: "3", wechat_openid: "secret", token_hash: "secret" }]]);
  const result = await users.service.listUsers(actor, paging);
  assert.deepEqual(result.items[0], { user: { id: targetUser, nickname: "用户", avatarText: "用", systemRole: "SYSTEM_ADMIN" }, familyCount: 2, entryCount: 3 });
  assert.doesNotMatch(users.calls[1].sql, /SELECT \*|wechat_openid|token_hash|e\.body|e\.title/);
  const members = await fixture([admin, [{ id: family }], [target, target]]).service.members(actor, family, { page: 1, pageSize: 1 });
  assert.equal(members.hasMore, true);
  assert.equal(members.items.length, 1);
});

test("audit filters are parameterized, newest first, and return bounded metadata", async () => {
  const row = { id: randomUUID(), actor_id: actor, family_id: family, action: "SYSTEM_MEMBER_REMOVE", target_type: "membership", target_id: member, reason: "测试理由", created_at: new Date() };
  const { service, calls } = fixture([admin, [row, row]]);
  const result = await service.audits(actor, { familyId: family, actorId: actor, action: row.action, page: 2, pageSize: 1 });
  assert.deepEqual(calls[1].params, [family, actor, row.action, 2, 1]);
  assert.match(calls[1].sql, /ORDER BY created_at DESC, id DESC/);
  assert.equal(result.hasMore, true);
  assert.equal(result.items[0].targetId, member);
  assert.equal(result.items[0].reason, "测试理由");
});

test("HTTP admin routes enforce live system authority, DTO limits, no-store and server actor identity", async () => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = "mysql://user:test@127.0.0.1/db";
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  let currentRole = "USER";
  const calls: { sql: string; params: unknown[] }[] = [];
  const manager = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT system_role")) return [{ system_role: currentRole }];
    if (sql.includes("AS familyCount")) return [{ familyCount: 1, userCount: 2, childCount: 3, entryCount: 4, assetCount: 5 }];
    if (sql.includes("FROM families WHERE id")) return [{ id: family }];
    if (sql.includes("FROM family_members WHERE")) return [target];
    if (sql.includes("FROM family_members m")) return [target];
    return [];
  } } as unknown as EntityManager;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService).useValue({ transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager) })
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => {
      if (header !== "Bearer test") throw new HttpException("Authentication required", 401);
      // 即使会话携带管理员标签，服务仍须读取当前数据库角色。
      return { user: { id: actor, systemRole: "SYSTEM_ADMIN" } };
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1/admin`, path = `/families/${family}/members/${member}`;
    const request = (method: string, route: string, body?: unknown) => fetch(base + route, { method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const routes = [["GET", "/dashboard"], ["GET", "/families"], ["GET", "/users"], ["GET", "/audit-logs"], ["GET", `/families/${family}/members`], ["PATCH", path], ["DELETE", path]];
    for (const [method, route] of routes) {
      assert.equal((await fetch(base + route, { method })).status, 401);
      assert.equal((await request(method, route, method === "PATCH" ? { role: "MEMBER", reason: "测试" } : method === "DELETE" ? { reason: "测试" } : undefined)).status, 403);
    }
    currentRole = "SYSTEM_ADMIN";
    assert.equal((await request("GET", "/dashboard")).headers.get("cache-control"), "no-store");
    assert.equal((await request("PATCH", path, { role: "MEMBER", reason: "  家庭申请  " })).status, 200);
    const audit = calls.find((call) => call.sql.startsWith("INSERT INTO audit_logs"))!;
    assert.equal(audit.params[1], actor);
    assert.equal(audit.params[6], "ADMIN -> MEMBER: 家庭申请");
    assert.equal((await request("DELETE", path, { reason: "本人申请" })).status, 204);
    const count = calls.length;
    for (const body of [{ role: "OWNER", reason: "测试" }, { role: "ADMIN" }, { role: "ADMIN", reason: " " }, { role: "ADMIN", reason: null }, { role: "ADMIN", reason: "a".repeat(401) }, { role: "ADMIN", reason: "测试", actorId: targetUser }, { role: "ADMIN", reason: "测试", systemRole: "SYSTEM_ADMIN" }]) assert.equal((await request("PATCH", path, body)).status, 400);
    for (const body of [{}, { reason: null }, { reason: " " }, { reason: "测试", role: "ADMIN" }]) assert.equal((await request("DELETE", path, body)).status, 400);
    for (const route of ["/families?pageSize=101", "/users?page=0", "/users?page=10001", "/users?page=1.5", "/users?unknown=1", "/audit-logs?familyId=bad", "/audit-logs?actorId=bad", "/audit-logs?action=x%27", "/families/bad/members"]) assert.equal((await request("GET", route)).status, 400, route);
    assert.equal(calls.length, count);
    currentRole = "USER";
    assert.equal((await request("GET", "/dashboard")).status, 403);
  } finally { await app.close(); }
});
