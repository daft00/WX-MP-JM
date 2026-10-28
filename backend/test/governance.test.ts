import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { GovernanceService } from "../src/governance/governance.service";
import { Governance1790985606000 } from "../src/database/migrations/1790985606000-governance";
import { AuthService } from "../src/auth/auth.service";
import { setupApp } from "../src/setup-app";
import { validateEnvironment } from "../src/config";

const cfg = { GOVERNANCE_ENABLED: true, LEGAL_OPERATOR: "测试运营者", LEGAL_CONTACT: "test@example.com", LEGAL_RETENTION_NOTE: "仅用于测试的保存说明" };
function fixture(replies: unknown[] = [], config: object = cfg) {
  const calls: string[] = [];
  const m = { query: async (sql: string) => { calls.push(sql); assert.ok(replies.length, sql); return replies.shift(); } };
  const db = { transaction: async (fn: (manager: typeof m) => unknown) => fn(m) } as unknown as DatabaseService;
  const families = new FamiliesService(db, new ConfigService());
  return { calls, families, service: new GovernanceService(db, families, new ConfigService(config)) };
}
test("policy requires real configuration, content changes invalidate old consent, missing acceptance fails closed", async () => {
  assert.throws(() => validateEnvironment({ MYSQL_URL: "mysql://u:p@localhost/db", GOVERNANCE_ENABLED: "true" }), /Governance requires/);
  const empty = fixture([], {}); assert.equal(empty.service.documents().ready, false);
  await assert.rejects(async () => empty.service.accept("u", "old"));
  const f = fixture([[]]); await assert.rejects(f.service.requireConsent("u"), (e: unknown) => e instanceof HttpException && e.getStatus() === 428);
  const a = fixture().service.documents(), b = fixture([], { ...cfg, LEGAL_RETENTION_NOTE: "changed" }).service.documents();
  assert.notEqual(a.version, b.version); await assert.rejects(async () => fixture().service.accept("u", b.version));
  const valid = fixture([{}]); assert.equal((await valid.service.accept("u", a.version)).accepted, true);
});
test("data request idempotency and review authorization never delete business data", async () => {
  const old = { id: "id", user_id: "u", family_id: "f", target_family_id: "f", entry_id: null, kind: "FAMILY_DISSOLVE", reason: "reason", status: "PENDING" };
  const f = fixture([[{ id: "u" }], [old]]);
  assert.equal((await f.service.submit("u", { requestId: "r", kind: "FAMILY_DISSOLVE", familyId: "f", reason: "reason" })).id, "id");
  await assert.rejects(fixture([[{ id: "u" }], [old]]).service.submit("u", { requestId: "r", kind: "FAMILY_DISSOLVE", familyId: "f", reason: "different" }));
  await assert.rejects(fixture([[{ system_role: "USER" }]]).service.review("other", "id", "APPROVED", "reason"));
  await assert.rejects(fixture([[{ system_role: "SYSTEM_ADMIN" }], [old]]).service.review("u", "id", "APPROVED", "reason"));
  const admin = fixture([[{ system_role: "SYSTEM_ADMIN" }], [old], {}, {}]);
  await admin.service.review("other", "id", "APPROVED", "reviewed");
  assert.ok(!admin.calls.some(q => /DELETE|UPDATE users|UPDATE entries/.test(q)));
  assert.ok(admin.calls.some(q => q.includes("audit_logs")));
});
test("owner cannot leave; transfer respects owner FK update order and rejects outsiders", async () => {
  const family = { id: "f", owner_id: "owner" }, owner = { id: "m1", user_id: "owner", role: "OWNER" };
  await assert.rejects(fixture([[family], [owner]]).families.leave("owner", "f"));
  await assert.rejects(fixture([[family], [{ ...owner, role: "MEMBER" }]]).families.transfer("owner", "f", "m2"));
  await assert.rejects(fixture([[family], [owner], []]).families.transfer("owner", "f", "missing"));
  const f = fixture([[family], [owner], [{ id: "m2", user_id: "new", role: "MEMBER" }], {}, {}, {}, {}, {}, [{ id: "m2", family_id: "f", user_id: "new", role: "OWNER", joined_at: new Date(), nickname: "新所有者", avatar_text: "新" }]]);
  await f.families.transfer("owner", "f", "m2");
  const writes = f.calls.filter(q => q.startsWith("UPDATE"));
  assert.match(writes[0], /role = 'ADMIN'/); assert.match(writes[1], /families SET owner_id/); assert.match(writes[2], /role = 'OWNER'/);
});
test("governance migration refuses partial schema or data loss on rollback", async () => {
  const migration = new Governance1790985606000();
  await assert.rejects(migration.up({ hasTable: async () => true } as never), /partial/);
  await assert.rejects(migration.down({ query: async () => [{}] } as never), /non-empty/);
});
test("real HTTP guard requires consent, keeps policy and data requests available, validates explicit guardian acceptance", async () => {
  process.env.NODE_ENV = "test"; process.env.MYSQL_URL = "mysql://u:fake@127.0.0.1/db";
  const { AppModule } = await import("../src/app.module");
  let accepted = false;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AuthService).useValue({ authenticate: async (header: string) => { if (header !== "Bearer test") throw new HttpException("no", 401); return { user: { id: randomUUID() } }; } })
    .overrideProvider(GovernanceService).useValue({ documents: () => ({ version: "a".repeat(64), ready: true }), status: () => ({ accepted }),
      requireConsent: async () => { if (!accepted) throw new HttpException("POLICY_CONSENT_REQUIRED", 428); },
      accept: () => { accepted = true; return { accepted }; }, list: () => ({ items: [] }) })
    .overrideProvider(FamiliesService).useValue({ list: async () => [] }).compile();
  const app = module.createNestApplication({ logger: false }); setupApp(app);
  try {
    await app.listen(0, "127.0.0.1"); const base = `${await app.getUrl()}/api/v1`;
    const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
    assert.equal((await fetch(base + "/governance/documents")).status, 200);
    assert.equal((await fetch(base + "/families", { headers })).status, 428);
    assert.equal((await fetch(base + "/governance/requests", { headers })).status, 200);
    assert.equal((await fetch(base + "/governance/requests", { headers, method: "POST", body: JSON.stringify({ requestId: randomUUID(), kind: "ACCOUNT_CLOSE", reason: "no" }) })).status, 400);
    assert.equal((await fetch(base + `/governance/requests/${randomUUID()}/execute`, { headers, method: "POST", body: JSON.stringify({ confirmed: false }) })).status, 400);
    assert.equal((await fetch(base + "/governance/consent", { headers, method: "POST", body: JSON.stringify({ version: "a".repeat(64), accepted: true, guardian: false }) })).status, 400);
    assert.equal((await fetch(base + "/governance/consent", { headers, method: "POST", body: JSON.stringify({ version: "a".repeat(64), accepted: true, guardian: true }) })).status, 201);
    assert.equal((await fetch(base + "/families", { headers })).status, 200);
  } finally { await app.close(); }
});
