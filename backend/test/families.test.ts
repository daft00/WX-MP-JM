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
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";
import { validateEnvironment } from "../src/config";

const actorId = randomUUID(), familyId = randomUUID(), memberId = randomUUID(), targetId = randomUUID();
const family = { id: familyId, name: "测试家庭", owner_id: actorId, created_at: new Date() };
const actor = (role: string) => ({ id: randomUUID(), family_id: familyId, user_id: actorId, role });
const target = (role: string, userId = targetId) => ({ id: memberId, family_id: familyId, user_id: userId, role });
const errorStatus = (expected: number) => (error: unknown) => {
  assert.ok(error instanceof HttpException);
  assert.equal(error.getStatus(), expected);
  return true;
};

function fixture(replies: unknown[], secret = "b".repeat(64)) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const manager = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    assert.ok(replies.length, "Unexpected SQL after permission failure");
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  } } as unknown as EntityManager;
  const database = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager) } as DatabaseService;
  return { calls, service: new FamiliesService(database, new ConfigService({ INVITE_CODE_SECRET: secret })) };
}

test("invite secret configuration fails safely and is mandatory in production", () => {
  const env = { MYSQL_URL: "mysql://user:test@localhost/db" };
  assert.throws(() => validateEnvironment({ ...env, INVITE_CODE_SECRET: "short" }), /INVITE_CODE_SECRET/);
  assert.throws(() => validateEnvironment({ ...env, NODE_ENV: "production", WECHAT_APP_ID: "wx0123456789abcdef", WECHAT_APP_SECRET: "a".repeat(32) }), /INVITE_CODE_SECRET/);
  assert.equal(validateEnvironment({ ...env, INVITE_CODE_SECRET: "b".repeat(64) }).INVITE_CODE_SECRET, "b".repeat(64));
});

test("nonmembers get the same 404 as missing families, before member data is read", async () => {
  for (const method of ["get", "members", "createInvite"] as const) {
    const { service, calls } = fixture([[family], []]);
    await assert.rejects(service[method](actorId, familyId), errorStatus(404));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, [familyId, actorId]);
  }
  await assert.rejects(fixture([[]]).service.get(actorId, familyId), errorStatus(404));
});

test("only owners change roles; owner and self cannot be modified; family scopes the target", async () => {
  for (const role of ["ADMIN", "MEMBER"]) {
    const { service, calls } = fixture([[family], [actor(role)]]);
    await assert.rejects(service.changeRole(actorId, familyId, memberId, "ADMIN"), errorStatus(403));
    assert.equal(calls.length, 2);
  }
  for (const row of [target("OWNER"), target("ADMIN", actorId)]) {
    const { service, calls } = fixture([[family], [actor("OWNER")], [row]]);
    await assert.rejects(service.changeRole(actorId, familyId, memberId, "MEMBER"), errorStatus(403));
    assert.ok(calls.every(({ sql }) => sql.startsWith("SELECT")));
  }
  const { service, calls } = fixture([[family], [actor("OWNER")], []]);
  await assert.rejects(service.changeRole(actorId, familyId, memberId, "ADMIN"), errorStatus(404));
  assert.deepEqual(calls[2].params, [familyId, memberId]);
});

test("member removal role matrix, no self-removal, and invitation invalidation", async () => {
  for (const actorRole of ["OWNER", "ADMIN", "MEMBER"]) {
    for (const targetRole of ["OWNER", "ADMIN", "MEMBER"]) {
      const allowed = targetRole !== "OWNER" && (actorRole === "OWNER" || (actorRole === "ADMIN" && targetRole === "MEMBER"));
      const { service, calls } = fixture([[family], [actor(actorRole)], [target(targetRole)], {}, {}, {}]);
      if (allowed) {
        await service.remove(actorId, familyId, memberId);
        assert.match(calls[3].sql, /^DELETE FROM invites/);
        assert.deepEqual(calls[3].params, [familyId, targetId]);
        assert.deepEqual(calls[4].params, [familyId, memberId]);
        assert.match(calls[5].sql, /^INSERT INTO audit_logs/);
      } else {
        await assert.rejects(service.remove(actorId, familyId, memberId), errorStatus(403));
        assert.equal(calls.length, 3);
      }
    }
  }
  await assert.rejects(fixture([[family], [actor("ADMIN")], [target("MEMBER", actorId)]]).service.remove(actorId, familyId, memberId), errorStatus(403));
});

test("ordinary members cannot invite; generated codes are returned once and only their digest reaches SQL", async () => {
  await assert.rejects(fixture([[family], [actor("MEMBER")]]).service.createInvite(actorId, familyId), errorStatus(403));
  await assert.rejects(fixture([[family], [actor("OWNER")]], "").service.createInvite(actorId, familyId), errorStatus(503));
  const { service, calls } = fixture([[family], [actor("ADMIN")], {}, {}, [{ expires_at: new Date(Date.now() + 86400000) }]]);
  const invite = await service.createInvite(actorId, familyId);
  assert.match(invite.code, /^[A-F0-9]{16}$/);
  assert.ok(!JSON.stringify(calls).includes(invite.code));
  assert.match(String(calls[2].params[3]), /^[a-f0-9]{64}$/);
  assert.equal(invite.creatorId, actorId);
});

test("join rechecks used/expired invites and current inviter authority before consuming them", async () => {
  const code = "0123456789ABCDEF", invite = { id: randomUUID(), creator_id: targetId };
  for (const responses of [[], [{ family_id: familyId }]]) {
    const replies = responses.length ? [responses, [family], []] : [responses];
    await assert.rejects(fixture(replies).service.join(actorId, code), errorStatus(400));
  }
  for (const inviter of [[], [target("MEMBER")]]) {
    const { service, calls } = fixture([[{ family_id: familyId }], [family], [invite], inviter]);
    await assert.rejects(service.join(actorId, code), errorStatus(400));
    assert.ok(calls.every(({ sql }) => sql.startsWith("SELECT")));
  }
  const duplicate = fixture([[{ family_id: familyId }], [family], [invite], [target("ADMIN")], [actor("MEMBER")]]);
  await assert.rejects(duplicate.service.join(actorId, code), errorStatus(409));
  assert.ok(duplicate.calls.every(({ sql }) => sql.startsWith("SELECT")));
  const expiredDuringJoin = fixture([[{ family_id: familyId }], [family], [invite], [target("OWNER")], [], { affectedRows: 0 }]);
  await assert.rejects(expiredDuringJoin.service.join(actorId, code), errorStatus(400));
  assert.ok(!expiredDuringJoin.calls.some(({ sql }) => sql.startsWith("INSERT INTO family_members")));
});

test("HTTP family routes require authentication, validate DTOs and use the authenticated user", async () => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = "mysql://user:test@127.0.0.1/db";
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  const calls: unknown[][] = [];
  const service = {
    list: async (id: string) => { calls.push(["list", id]); return []; },
    create: async (id: string, name: string) => { calls.push(["create", id, name]); return { id: familyId, name }; },
    join: async (id: string, code: string) => { calls.push(["join", id, code]); return { id: familyId }; },
    changeRole: async (...args: unknown[]) => { calls.push(["role", ...args]); return {}; },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FamiliesService).useValue(service)
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => {
      if (header !== "Bearer test") throw new HttpException("Authentication required", 401);
      return { user: { id: actorId, systemRole: "SYSTEM_ADMIN" }, tokenHash: "test" };
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1/families`;
    const request = (method: string, path: string, body?: unknown) => fetch(base + path, {
      method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const [method, path] of [["GET", ""], ["POST", ""], ["POST", "/join"], ["POST", `/${familyId}/invites`],
      ["GET", `/${familyId}/members`], ["PATCH", `/${familyId}/members/${memberId}`], ["DELETE", `/${familyId}/members/${memberId}`]]) {
      assert.equal((await fetch(base + path, { method })).status, 401);
    }
    assert.equal((await request("POST", "", { name: "  我的家庭  " })).status, 201);
    assert.deepEqual(calls[0], ["create", actorId, "我的家庭"]);
    for (const body of [{ name: " " }, { name: "a".repeat(21) }, { name: "测试家庭", ownerId: targetId }]) {
      assert.equal((await request("POST", "", body)).status, 400);
    }
    assert.equal((await request("GET", "/not-a-uuid")).status, 400);
    assert.equal((await request("PATCH", `/${familyId}/members/${memberId}`, { role: "OWNER" })).status, 400);
    assert.equal((await request("POST", "/join", { code: " abcdef0123456789 " })).status, 200);
    assert.deepEqual(calls.at(-1), ["join", actorId, "ABCDEF0123456789"]);
    assert.equal((await request("POST", "/join", { code: "ABCDEF0123456789", userId: targetId })).status, 400);
    let limited = false;
    for (let attempt = 0; attempt < 11; attempt++) {
      if ((await request("POST", "/join", { code: "0000000000000000" })).status === 429) { limited = true; break; }
    }
    assert.ok(limited);
  } finally { await app.close(); }
});
