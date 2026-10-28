import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { HttpException } from "@nestjs/common";
import { validate } from "class-validator";
import type { EntityManager, QueryRunner } from "typeorm";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { MediaService } from "../src/media/media.service";
import { CosStorage, InvalidMedia, postForm } from "../src/media/cos-storage";
import { UploadDto } from "../src/media/media.dto";
import { Media1790985604000 } from "../src/database/migrations/1790985604000-media";
import { validateEnvironment } from "../src/config";
import { Test } from "@nestjs/testing";
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";

const id = randomUUID(), user = randomUUID(), family = randomUUID();
const row = { id, family_id: family, creator_id: user, child_id: randomUUID(), kind: "IMAGE", status: "PENDING",
  object_key: `media/${family}/${id}`, original_name: "photo.jpg", mime_type: "image/jpeg", size_bytes: "100", declared_bytes: "100",
  created_at: new Date(), updated_at: new Date(), expires_at: new Date(Date.now() + 3600000), requested: 1,
  deleted: 0, temp_deleted: 0 };
function fixture(replies: unknown[], cloud: Partial<CosStorage> = {}) {
  const sql: { query: string; params: unknown[] }[] = [];
  const m = { query: async (query: string, params: unknown[]) => {
    sql.push({ query, params });
    if (!query.startsWith("SELECT")) return {};
    assert.ok(replies.length, query);
    return replies.shift();
  } } as unknown as EntityManager;
  const db = { transaction: (work: (m: EntityManager) => unknown) => work(m) } as DatabaseService;
  const storage = { enabled: true, url: () => "https://private.invalid/signed", ...cloud } as CosStorage;
  return { sql, service: new MediaService(db, new FamiliesService(db, new ConfigService()), storage) };
}
const status = (n: number) => (e: unknown) => e instanceof HttpException && e.getStatus() === n;

test("media configuration defaults off and refuses incomplete enabled settings", () => {
  const env = { MYSQL_URL: "mysql://a:b@localhost/test" };
  assert.equal(validateEnvironment(env).MEDIA_ENABLED, false);
  assert.throws(() => validateEnvironment({ ...env, MEDIA_ENABLED: "true" }), /Media requires/);
});
test("upload trust boundary rejects oversized, missing identity and extra kind values", async () => {
  const dto = Object.assign(new UploadDto(), { requestId: randomUUID(), childId: randomUUID(), kind: "IMAGE", name: "a.jpg", sizeBytes: 100 });
  assert.equal((await validate(dto)).length, 0);
  assert.ok((await validate(Object.assign(new UploadDto(), { ...dto, sizeBytes: 51 * 1024 ** 2, kind: "FILE", requestId: "x" }))).length >= 3);
});
test("POST policy fixes exact object, size, token and expiry without exposing signing key", () => {
  const fields = postForm("test-123", "tmp/f/id", 123, "temporary-id", "private-signing-key", "session-token", Math.floor(Date.now() / 1000) + 300);
  const policy = JSON.parse(Buffer.from(fields.policy, "base64").toString());
  assert.ok(policy.conditions.some((c: unknown[]) => Array.isArray(c) && c[0] === "content-length-range" && c[1] === 123 && c[2] === 123));
  assert.ok(policy.conditions.some((c: { key: string }) => c.key === "tmp/f/id"));
  assert.ok(!JSON.stringify(fields).includes("private-signing-key"));
  assert.match(fields["q-signature"], /^[a-f0-9]{40}$/);
});
test("quota accounts for temporary, frozen and derived bytes before any insert", async () => {
  const f = fixture([[{ id: family }], [{ role: "MEMBER" }], [{ id: row.child_id }], [], [{ quota_bytes: 200 }], [{ used: 0, reserved: 0 }], [{ used: 0 }]]);
  await assert.rejects(f.service.start(user, family, { requestId: randomUUID(), childId: row.child_id, name: "a", kind: "IMAGE", sizeBytes: 100 }), status(409));
  assert.ok(f.sql.every((s) => s.query.startsWith("SELECT")));
});
test("removed members cannot fetch private URLs and other members cannot see unattached uploads", async () => {
  const denied = fixture([[{ id: family }], []]);
  await assert.rejects(denied.service.get(user, family, id), status(404));
  const unlinked = fixture([[{ id: family }], [{ role: "MEMBER" }], [{ ...row, creator_id: randomUUID(), status: "READY" }], []]);
  await assert.rejects(unlinked.service.get(user, family, id), status(404));
});
test("worker freezes before inspecting and settles only after preview succeeds", async () => {
  const order: string[] = [];
  const f = fixture([[{ id, family_id: family }], [{ id: family }], [{ ...row }], []], {
    freeze: async () => { order.push("freeze"); }, head: async () => ({ size: 100, etag: "e" }),
    inspect: async () => { order.push("inspect"); return "image/jpeg"; }, preview: async () => { order.push("preview"); return 25; },
  });
  await f.service.tick();
  assert.deepEqual(order, ["freeze", "inspect", "preview"]);
  assert.ok(f.sql.some((s) => s.query.includes("used_bytes = ?") && s.params[0] === 125));
});
test("invalid format is scheduled for deletion; transient preview failure retains reservation for retry", async () => {
  for (const invalid of [true, false]) {
    const f = fixture([[{ id, family_id: family }], [{ id: family }], [{ ...row }], []], {
      freeze: async () => {}, head: async () => ({ size: 100, etag: "e" }),
      inspect: async () => { if (invalid) throw new InvalidMedia("bad"); return "image/jpeg"; },
      preview: async () => { throw new Error("upstream down"); },
    });
    await f.service.tick();
    assert.equal(f.sql.some((s) => s.query.includes("status = 'DELETING'")), invalid);
    assert.ok(!f.sql.some((s) => s.query.includes("used_bytes = ?") || s.query.includes("reserved_bytes = 0")));
  }
});
test("deletion failure never releases quota and live credentials delay deletion", async () => {
  for (const expired of [true, false]) {
    let deletes = 0;
    const f = fixture([[{ id, family_id: family }], [{ id: family }], [{ ...row, status: "DELETING", expires_at: new Date(Date.now() + (expired ? -120000 : 60000)) }], []], {
      remove: async () => { deletes++; throw new Error("COS unavailable"); },
    });
    await f.service.tick();
    assert.equal(deletes, expired ? 1 : 0);
    assert.ok(!f.sql.some((s) => s.query.includes("reserved_bytes = 0") || s.query.startsWith("DELETE FROM assets")));
  }
});
test("fifth migration refuses existing tables and nonempty rollback", async () => {
  const queries: string[] = [];
  const r = { hasTable: async () => true, query: async (s: string) => { queries.push(s); return [{}]; } } as unknown as QueryRunner;
  const migration = new Media1790985604000();
  await assert.rejects(migration.up(r), /already exist/);
  await assert.rejects(migration.down(r), /non-empty/);
  assert.ok(queries.every((s) => s.startsWith("SELECT")));
});

test("media HTTP routes enforce auth, UUIDs, whitelisted DTO and no-store", async () => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = "mysql://user:fake@127.0.0.1/db";
  const { AppModule } = await import("../src/app.module");
  const calls: unknown[][] = [];
  const record = async (...args: unknown[]) => { calls.push(args); return {}; };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MediaService).useValue({ start: record, get: record, complete: record, authorize: record, cancel: record, quota: record, adminQuota: record, setQuota: record })
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => {
      if (header !== "Bearer test") throw new HttpException("Unauthorized", 401);
      return { user: { id: user } };
    } }).compile();
  const app = module.createNestApplication({ logger: false }); setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1/families/${family}`;
    const request = (path: string, data?: unknown) => fetch(base + path, { method: data ? "POST" : "GET", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.equal((await fetch(base + "/storage")).status, 401);
    const draft = { requestId: randomUUID(), childId: row.child_id, kind: "IMAGE", name: "a.jpg", sizeBytes: 100 };
    const response = await request("/assets", draft);
    assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls[0][0], user);
    for (const change of [{ objectKey: "arbitrary" }, { creatorId: user }, { sizeBytes: "100" }, { sizeBytes: -1 }, { kind: "FILE" }, { childId: "bad" }]) {
      assert.equal((await request("/assets", { ...draft, ...change })).status, 400);
    }
    assert.equal((await request("/assets/bad")).status, 400);
    assert.equal(calls.length, 1);
    const quotaUrl = `${await app.getUrl()}/api/v1/admin/families/${family}/storage`;
    assert.equal((await fetch(quotaUrl)).status, 401);
    const quotaRead = await fetch(quotaUrl, { headers: { Authorization: "Bearer test" } });
    assert.equal(quotaRead.status, 200);
    assert.equal(quotaRead.headers.get("cache-control"), "no-store");
    const putQuota = (body: unknown) => fetch(quotaUrl, { method: "PUT", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ quotaBytes: 0, reason: "test" }, { quotaBytes: 2 ** 40 + 1, reason: "test" }, { quotaBytes: 100, reason: " " }, { quotaBytes: 1.5, reason: "test" }, { quotaBytes: 100, reason: "test", actorId: user }]) {
      assert.equal((await putQuota(body)).status, 400);
    }
    assert.equal((await putQuota({ quotaBytes: 100, reason: "  核实  " })).status, 200);
    assert.deepEqual(calls.at(-1), [user, family, 100, "核实"]);
  } finally { await app.close(); }
});


test("admin quota reads require live system role and include legacy usage without membership", async () => {
  await assert.rejects(fixture([[{ system_role: "USER" }]]).service.adminQuota(user, family), status(403));
  const f = fixture([[{ system_role: "SYSTEM_ADMIN" }], [{ id: family }], [], [{ used: 30, reserved: 40 }], [{ used: 10 }]], { enabled: false });
  assert.deepEqual(await f.service.adminQuota(user, family), { enabled: false, quotaBytes: 10 * 1024 ** 3, usedBytes: 40, reservedBytes: 40 });
  assert.ok(f.sql.every(s => s.query.startsWith("SELECT")));
  assert.ok(!f.sql.some(s => s.query.includes("family_members")));
  await assert.rejects(fixture([[{ system_role: "SYSTEM_ADMIN" }], []]).service.adminQuota(user, family), status(404));
});

test("quota changes protect occupied space and preserve audited update under family lock", async () => {
  const replies = () => [[{ system_role: "SYSTEM_ADMIN" }], [{ id: family }], [{ quota_bytes: 200 }], [{ used: 30, reserved: 40 }], [{ used: 10 }]];
  const denied = fixture(replies());
  await assert.rejects(denied.service.setQuota(user, family, 79, "测试"), status(409));
  assert.ok(denied.sql.every(s => s.query.startsWith("SELECT")));
  const f = fixture([...replies(), [{ quota_bytes: 80 }], [{ used: 30, reserved: 40 }], [{ used: 10 }]]);
  assert.equal((await f.service.setQuota(user, family, 80, "核实占用")).quotaBytes, 80);
  assert.match(f.sql[1].query, /FOR UPDATE/);
  const audit = f.sql.find(s => s.query.startsWith("INSERT INTO audit_logs"))!;
  assert.deepEqual(audit.params.slice(1), [user, family, family, "80: 核实占用"]);
});
