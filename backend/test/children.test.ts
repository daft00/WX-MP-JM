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
import { ChildrenService } from "../src/children/children.service";
import { isBirthday } from "../src/children/children.dto";
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";

const user = randomUUID(), family = randomUUID(), child = randomUUID();
const draft = { name: "乐乐", birthday: "2024-02-29", genderLabel: "宝宝", avatarColor: "#F0A58A" };
const row = { id: child, family_id: family, creator_id: user, ...draft, gender_label: draft.genderLabel, avatar_color: draft.avatarColor, created_at: new Date() };
const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
function fixture(replies: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const manager = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    assert.ok(replies.length, "Unexpected SQL");
    const result = replies.shift();
    if (result instanceof Error) throw result;
    return result;
  } } as unknown as EntityManager;
  const database = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager) } as DatabaseService;
  return { calls, service: new ChildrenService(database, new FamiliesService(database, new ConfigService())) };
}
const access = (role = "OWNER") => [[{ id: family }], [{ role }]];

test("birthdays reject impossible, future and non-date values, using Shanghai calendar boundaries", () => {
  const now = new Date("2024-02-29T16:00:00Z");
  for (const value of [undefined, null, 2024, "2023-02-29", "2024-02-30", "2024-03-02", "2024-2-29", "2024-02-29T00:00:00Z", "0000-01-01"]) {
    assert.equal(isBirthday(value, now), false, String(value));
  }
  assert.equal(isBirthday("2024-02-29", now), true);
  assert.equal(isBirthday("2024-03-01", now), true);
  assert.equal(isBirthday("2024-03-01", new Date("2024-02-29T15:59:59Z")), false);
});

test("all child operations reject nonmembers before reading or writing profiles", async () => {
  for (const action of ["list", "get", "create", "update"]) {
    const { service, calls } = fixture([[{ id: family }], []]);
    const result = action === "list" ? service.list(user, family) : action === "get" ? service.get(user, family, child) : service.save(user, family, draft, action === "update" ? child : undefined);
    await assert.rejects(result, status(404));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, [family, user]);
    assert.ok(calls.every(({ sql }) => sql.endsWith("FOR UPDATE")));
  }
});

test("members read date strings; detail and update scope child IDs to the requested family", async () => {
  const list = fixture([...access("MEMBER"), [row]]);
  assert.equal((await list.service.list(user, family))[0].birthday, draft.birthday);
  assert.deepEqual(list.calls[2].params, [family]);
  assert.deepEqual(await fixture([...access(), []]).service.list(user, family), []);
  for (const update of [false, true]) {
    const { service, calls } = fixture([...access(), []]);
    await assert.rejects(update ? service.save(user, family, draft, child) : service.get(user, family, child), status(404));
    assert.deepEqual(calls[2].params, [family, child]);
    assert.ok(calls.every(({ sql }) => sql.startsWith("SELECT")));
  }
});

test("only OWNER and ADMIN write; updates preserve creator and family; writes include audit", async () => {
  for (const update of [false, true]) {
    await assert.rejects(fixture(access("MEMBER")).service.save(user, family, draft, update ? child : undefined), status(403));
    for (const role of ["OWNER", "ADMIN"]) {
      const { service, calls } = fixture([...access(role), ...(update ? [[row]] : []), {}, {}, [row]]);
      const result = await service.save(user, family, draft, update ? child : undefined);
      assert.equal(result.creatorId, user);
      const write = calls[update ? 3 : 2];
      if (update) {
        assert.deepEqual(write.params, [draft.name, draft.birthday, draft.genderLabel, draft.avatarColor, family, child]);
        assert.doesNotMatch(write.sql, /SET.*creator_id/);
      } else assert.deepEqual(write.params.slice(1), [family, user, draft.name, draft.birthday, draft.genderLabel, draft.avatarColor]);
      const audit = calls.at(-2)!;
      assert.match(audit.sql, /^INSERT INTO audit_logs/);
      assert.deepEqual(audit.params.slice(1, 5), [user, family, update ? "CHILD_UPDATE" : "CHILD_CREATE", "child"]);
    }
  }
  await assert.rejects(fixture([...access(), {}, new Error("audit failed")]).service.save(user, family, draft), /audit failed/);
});

test("HTTP child routes authenticate, validate full forms, reject forged ownership and return no-store", async () => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = "mysql://user:test@127.0.0.1/db";
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  const calls: unknown[][] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ChildrenService).useValue({
      list: async (...args: unknown[]) => { calls.push(args); return []; },
      get: async (...args: unknown[]) => { calls.push(args); return {}; },
      save: async (...args: unknown[]) => { calls.push(args); return { id: child }; },
    })
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => {
      if (header !== "Bearer test") throw new HttpException("Authentication required", 401);
      return { user: { id: user, systemRole: "SYSTEM_ADMIN" } };
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1/families/${family}/children`;
    const request = (method: string, path: string, body?: unknown) => fetch(base + path, {
      method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const [method, path] of [["GET", ""], ["GET", `/${child}`], ["POST", ""], ["PUT", `/${child}`]]) {
      assert.equal((await fetch(base + path, { method })).status, 401);
    }
    const created = await request("POST", "", { name: " 乐乐 ", birthday: draft.birthday });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal(calls[0][0], user);
    assert.equal(calls[0][1], family);
    assert.deepEqual({ ...calls[0][2] as object }, draft);
    assert.equal((await request("PUT", `/${child}`, draft)).status, 200);
    assert.equal(calls.at(-1)![3], child);
    for (const body of [{}, { ...draft, name: " " }, { ...draft, name: "a".repeat(13) }, { ...draft, genderLabel: "a".repeat(9) },
      { ...draft, birthday: "2025-02-29" }, { ...draft, birthday: "9999-01-01" }, { ...draft, avatarColor: "red" },
      { ...draft, genderLabel: null }, { ...draft, birthday: null }, { ...draft, avatarColor: null },
      ...["id", "familyId", "creatorId", "role"].map((key) => ({ ...draft, [key]: user }))]) {
      assert.equal((await request("POST", "", body)).status, 400, JSON.stringify(body));
      assert.equal((await request("PUT", `/${child}`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await request("GET", "/not-a-uuid")).status, 400);
    assert.equal((await fetch(base.replace(family, "bad-id"), { headers: { Authorization: "Bearer test" } })).status, 400);
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});
