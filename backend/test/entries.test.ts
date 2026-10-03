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
import { EntriesService } from "../src/entries/entries.service";
import { SaveEntryDto } from "../src/entries/entries.dto";
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";

const user = randomUUID(), family = randomUUID(), child = randomUUID(), entry = randomUUID(), asset = randomUUID();
const draft: SaveEntryDto = { childId: child, kind: "MILESTONE", title: "第一次站立", body: "记录", occurredAt: "2024-02-29", assetIds: [] };
const row = { id: entry, family_id: family, child_id: child, creator_id: user, kind: draft.kind, title: draft.title, body: draft.body,
  custom_event: null, occurred_at: new Date("2024-02-29T00:00:00Z"), created_at: new Date(), updated_at: new Date() };
const access = (role = "MEMBER") => [[{ id: family }], [{ role }]];
const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
function fixture(replies: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const manager = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    assert.ok(replies.length, `Unexpected SQL: ${sql}`);
    const result = replies.shift();
    if (result instanceof Error) throw result;
    return result;
  } } as unknown as EntityManager;
  const database = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => work(manager) } as DatabaseService;
  return { calls, service: new EntriesService(database, new FamiliesService(database, new ConfigService())) };
}

test("every entry and metric operation rechecks family membership before accessing content", async () => {
  for (const action of ["list", "get", "save", "remove", "metrics"] as const) {
    const { service, calls } = fixture([[{ id: family }], []]);
    const request = action === "list" ? service.list(user, family, { pageSize: 20 }) : action === "get" ? service.get(user, family, entry) :
      action === "save" ? service.save(user, family, draft) : action === "remove" ? service.remove(user, family, entry) : service.metrics(user, family, { childId: child, type: "HEIGHT", pageSize: 20 });
    await assert.rejects(request, status(404));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, [family, user]);
  }
});

test("edit permission matrix preserves the original author; only administrators delete", async () => {
  for (const role of ["OWNER", "ADMIN", "MEMBER"]) {
    for (const own of [true, false]) {
      const original = { ...row, creator_id: own ? user : randomUUID() };
      const allowed = own || role !== "MEMBER";
      const { service, calls } = fixture([...access(role), [original], [{ id: child }], {}, {}, {}, {}, [original], [], []]);
      if (allowed) {
        const result = await service.save(user, family, draft, entry);
        assert.equal(result.creatorId, original.creator_id);
        const update = calls.find((call) => call.sql.startsWith("UPDATE entries"))!;
        assert.doesNotMatch(update.sql, /creator_id =/);
        assert.deepEqual(update.params.slice(-2), [family, entry]);
      } else {
        await assert.rejects(service.save(user, family, draft, entry), status(403));
        assert.equal(calls.length, 3);
      }
    }
    const deletion = fixture([...access(role), [row], {}, {}, {}]);
    if (role === "MEMBER") await assert.rejects(deletion.service.remove(user, family, entry), status(403));
    else {
      await deletion.service.remove(user, family, entry);
      assert.match(deletion.calls[3].sql, /DELETING/);
      assert.deepEqual(deletion.calls[4].params, [family, entry]);
      assert.equal(deletion.calls[5].params[3], "ENTRY_DELETE");
    }
  }
});

test("foreign children, foreign entries and inconsistent metric drafts fail before mutations", async () => {
  await assert.rejects(fixture([...access(), []]).service.save(user, family, draft), status(404));
  const foreign = fixture([...access(), []]);
  await assert.rejects(foreign.service.get(user, family, entry), status(404));
  assert.deepEqual(foreign.calls[2].params, [family, entry]);
  for (const change of [{ metricType: "HEIGHT" }, { metricValue: 12 }, { kind: "DIARY", metricType: "HEIGHT", metricValue: 12 }, { kind: "DIARY", customEvent: "事件" }]) {
    const { service, calls } = fixture([...access(), [{ id: child }]]);
    await assert.rejects(service.save(user, family, { ...draft, ...change } as SaveEntryDto), status(400));
    assert.ok(calls.every((call) => call.sql.startsWith("SELECT")));
  }
});

test("assets must be ready, scoped, owned or retained, and cannot be reused by another entry", async () => {
  for (const [assets, code] of [ [[], 400], [[{ creator_id: user, status: "PENDING", entry_id: null }], 400],
    [[{ creator_id: randomUUID(), status: "READY", entry_id: null }], 400], [[{ creator_id: user, status: "READY", entry_id: randomUUID() }], 409] ] as const) {
    const { service, calls } = fixture([...access(), [{ id: child }], assets]);
    await assert.rejects(service.save(user, family, { ...draft, assetIds: [asset] }), status(code));
    assert.deepEqual(calls[3].params, [family, child, asset]);
    assert.ok(calls.every((call) => call.sql.startsWith("SELECT")));
  }
  const retained = fixture([...access("ADMIN"), [row], [{ id: child }], [{ creator_id: randomUUID(), status: "READY", entry_id: entry }], {}, {}, {}, {}, {}, [row], [], [{ entry_id: entry, asset_id: asset }]]);
  assert.deepEqual((await retained.service.save(user, family, { ...draft, assetIds: [asset] }, entry)).assetIds, [asset]);
});

test("metrics derive units and measurement date; DECIMAL values are returned as numbers", async () => {
  for (const type of ["HEIGHT", "WEIGHT", "HEAD"] as const) {
    const metric = { id: randomUUID(), family_id: family, child_id: child, creator_id: user, entry_id: entry, type, value: "12.125", unit: type === "WEIGHT" ? "kg" : "cm", measured_at: row.occurred_at };
    const { service, calls } = fixture([...access(), [{ id: child }], {}, {}, {}, [row], [metric], []]);
    const result = await service.save(user, family, { ...draft, metricType: type, metricValue: 12.125 });
    assert.equal(result.metric?.value, 12.125);
    assert.equal(result.metric?.measuredAt, draft.occurredAt);
    assert.deepEqual(calls[4].params.slice(-4), [type, 12.125, metric.unit, row.occurred_at]);
  }
  await assert.rejects(fixture([...access(), [{ id: child }], {}, new Error("audit failed")]).service.save(user, family, draft), /audit failed/);
});

test("entry cursor pagination uses date and ID, validates scope, and limits hydration to the page", async () => {
  const second = { ...row, id: randomUUID() };
  const first = fixture([...access(), [row, second], [], []]);
  const page = await first.service.list(user, family, { pageSize: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  assert.deepEqual(first.calls[3].params, [family, entry]);
  const next = fixture([...access(), []]);
  assert.deepEqual(await next.service.list(user, family, { pageSize: 1, cursor: page.nextCursor }), { items: [] });
  assert.deepEqual(next.calls[2].params, [family, row.occurred_at, row.occurred_at, entry, 2]);
  assert.match(next.calls[2].sql, /id < \?/);
  for (const cursor of ["!", Buffer.from("null").toString("base64url"), page.nextCursor!]) {
    await assert.rejects(fixture([...access(), [{ id: child }]]).service.list(user, family, { childId: child, pageSize: 1, cursor }), status(400));
  }
  const metric = { id: randomUUID(), family_id: family, child_id: child, creator_id: user, entry_id: entry, type: "HEIGHT", value: "12.125", unit: "cm", measured_at: row.occurred_at };
  const points = await fixture([...access(), [{ id: child }], [metric, { ...metric, id: randomUUID() }]]).service.metrics(user, family, { childId: child, type: "HEIGHT", pageSize: 1 });
  const tail = fixture([...access(), [{ id: child }], []]);
  await tail.service.metrics(user, family, { childId: child, type: "HEIGHT", pageSize: 1, cursor: points.nextCursor });
  assert.match(tail.calls[3].sql, /id > \?/);
  assert.deepEqual(tail.calls[3].params, [family, child, "HEIGHT", row.occurred_at, row.occurred_at, metric.id, 2]);
});

test("HTTP entry DTOs reject invalid dates, precision, identities, arrays and unbounded queries", async () => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = "mysql://user:test@127.0.0.1/db";
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  const calls: unknown[][] = [];
  const record = async (...args: unknown[]) => { calls.push(args); return {}; };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EntriesService).useValue({ list: record, get: record, metrics: record, save: record, remove: async (...args: unknown[]) => { calls.push(args); } })
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => {
      if (header !== "Bearer test") throw new HttpException("Authentication required", 401);
      return { user: { id: user, systemRole: "SYSTEM_ADMIN" } };
    } }).compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1/families/${family}`;
    const request = (method: string, path: string, body?: unknown) => fetch(base + path, { method,
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const [method, path] of [["GET", "/entries"], ["GET", `/entries/${entry}`], ["GET", "/metrics"], ["POST", "/entries"], ["PUT", `/entries/${entry}`], ["DELETE", `/entries/${entry}`]]) assert.equal((await fetch(base + path, { method })).status, 401);
    const created = await request("POST", "/entries", { ...draft, title: " 标题 ", metricType: "HEIGHT", metricValue: 12.125 });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal(calls[0][0], user);
    assert.equal((calls[0][2] as SaveEntryDto).title, "标题");
    assert.equal((await request("PUT", `/entries/${entry}`, draft)).status, 200);
    assert.equal(calls.at(-1)![3], entry);
    assert.equal((await request("DELETE", `/entries/${entry}`)).status, 204);
    assert.equal((await request("GET", `/entries?childId=${child}&pageSize=200`)).status, 200);
    assert.equal((await request("GET", `/metrics?childId=${child}&type=HEIGHT`)).status, 200);
    const count = calls.length;
    const invalid = [{}, ...[{ title: " " }, { title: "a".repeat(61) }, { body: "a".repeat(2001) }, { body: null }, { childId: "bad" },
      { occurredAt: "2025-02-29" }, { occurredAt: "9999-01-01" }, { occurredAt: "2024-01-01T00:00:00Z" },
      { metricType: "OTHER" }, { metricValue: "12" }, { metricValue: 0 }, { metricValue: -1 }, { metricValue: 0.0001 }, { metricValue: 10000000 },
      { metricType: null }, { metricValue: null }, { customEvent: null }, { customEvent: "a".repeat(101) },
      { assetIds: [asset, asset] }, { assetIds: ["/tmp/file"] }, { assetIds: null }, { assetIds: Array.from({ length: 10 }, () => randomUUID()) },
      { creatorId: user }, { familyId: family }, { id: entry }, { unit: "kg" }].map((change) => ({ ...draft, ...change }))];
    for (const body of invalid) for (const method of ["POST", "PUT"]) assert.equal((await request(method, method === "POST" ? "/entries" : `/entries/${entry}`, body)).status, 400, JSON.stringify(body));
    for (const path of ["/entries/bad", "/entries?pageSize=201", "/entries?pageSize=0", "/entries?pageSize=1.5", "/entries?pageSize[]=1", "/entries?cursor=", "/entries?unknown=1", "/metrics?type=HEIGHT", `/metrics?childId=${child}`, `/metrics?childId=${child}&type=OTHER`]) assert.equal((await request("GET", path)).status, 400, path);
    assert.equal(calls.length, count);
  } finally { await app.close(); }
});
