import { DeletionService } from "../src/governance/deletion.service";
import { CosStorage } from "../src/media/cos-storage";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestContext } from "node:test";
import { QueryRunner } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { GovernanceService } from "../src/governance/governance.service";

export async function exerciseGovernance(t: TestContext, runner: QueryRunner, url: string) {
  const owner = randomUUID(), successor = randomUUID(), member = randomUUID(); let family = "";
  const db = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
  const families = new FamiliesService(db, new ConfigService());
  const service = new GovernanceService(db, families, new ConfigService({ GOVERNANCE_ENABLED: true, LEGAL_OPERATOR: "test", LEGAL_CONTACT: "test@example.com", LEGAL_RETENTION_NOTE: "test only" }));
  try {
    for (const id of [owner, successor]) await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname) VALUES (?, 'governance-test', ?, '测试')", [id, id]);
    await runner.query("INSERT INTO family_creation_permissions (user_id) VALUES (?)", [owner]);
    family = (await families.create(owner, "家庭管理测试")).id;
    await runner.query("INSERT INTO family_members (id, family_id, user_id, role) VALUES (?, ?, ?, 'MEMBER')", [member, family, successor]);
    await t.test("transfer satisfies owner FK, old owner can leave, successor remains sole owner", async () => {
      await assert.rejects(families.leave(owner, family));
      await families.transfer(owner, family, member);
      const rows = await runner.query("SELECT f.owner_id, m.user_id FROM families f JOIN family_members m ON m.family_id = f.id AND m.role = 'OWNER' WHERE f.id = ?", [family]);
      assert.equal(rows.length, 1); assert.equal(rows[0].owner_id, successor); assert.equal(rows[0].user_id, successor);
      await families.leave(owner, family); await assert.rejects(families.get(owner, family));
    });
    await t.test("single record cleanup preserves other records and does not release quota on cloud failure", async () => {
      await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [owner]);
      const child = randomUUID(), entry = randomUUID(), kept = randomUUID(), asset = randomUUID();
      await runner.query("INSERT INTO children (id, family_id, creator_id, name, birthday) VALUES (?, ?, ?, 'test', '2025-01-01')", [child, family, successor]);
      for (const id of [entry, kept]) await runner.query("INSERT INTO entries (id, family_id, child_id, creator_id, kind, title, body, occurred_at) VALUES (?, ?, ?, ?, 'DIARY', 'test', 'body', UTC_TIMESTAMP(3))", [id, family, child, successor]);
      await runner.query("INSERT INTO assets (id, family_id, child_id, creator_id, kind, status, object_key, original_name, mime_type, size_bytes, ready_at) VALUES (?, ?, ?, ?, 'IMAGE', 'READY', ?, 'x.jpg', 'image/jpeg', 10, UTC_TIMESTAMP(3))", [asset, family, child, successor, `media/${family}/${asset}`]);
      await runner.query("INSERT INTO entry_assets (entry_id, asset_id, family_id, child_id, position) VALUES (?, ?, ?, ?, 0)", [entry, asset, family, child]);
      await runner.query("INSERT INTO media_uploads (id, family_id, creator_id, request_id, body_hash, reserved_bytes, used_bytes, declared_bytes, expires_at) VALUES (?, ?, ?, ?, ?, 0, 20, 10, UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE)", [asset, family, successor, randomUUID(), "a".repeat(64)]);
      const application = await service.submit(successor, { requestId: randomUUID(), kind: "DATA_DELETE", familyId: family, entryId: entry, reason: "selected record only" });
      await service.review(owner, application.id, "APPROVED", "verified scope");
      let unavailable = true;
      const deletion = new DeletionService(db, families, { enabled: true, remove: async () => { if (unavailable) throw new Error("cloud down"); } } as unknown as CosStorage);
      await deletion.execute(successor, application.id);
      assert.equal((await runner.query("SELECT id FROM entries WHERE id = ?", [entry])).length, 0);
      assert.equal((await runner.query("SELECT id FROM entries WHERE id = ?", [kept])).length, 1);
      await deletion.tick();
      assert.equal(Number((await runner.query("SELECT used_bytes FROM media_uploads WHERE id = ?", [asset]))[0].used_bytes), 20);
      unavailable = false; await deletion.tick();
      assert.equal((await service.list(successor, { page: 1, pageSize: 20 })).items[0].status, "COMPLETED");
      assert.equal((await runner.query("SELECT id FROM assets WHERE id = ?", [asset])).length, 0);
      assert.equal(Number((await runner.query("SELECT used_bytes FROM media_uploads WHERE id = ?", [asset]))[0].used_bytes), 0);
      assert.equal((await runner.query("SELECT id FROM entries WHERE id = ?", [kept])).length, 1);
      assert.equal((await runner.query("SELECT id FROM children WHERE id = ?", [child])).length, 1);
    });
    await t.test("consent persistence and concurrent idempotent requests with audited manual review", async () => {
      await service.accept(owner, service.documents().version); await service.requireConsent(owner);
      const body = { requestId: randomUUID(), kind: "FAMILY_DISSOLVE", familyId: family, reason: "test" };
      const [a, b] = await Promise.all([service.submit(successor, body), service.submit(successor, body)]);
      assert.equal(a.id, b.id);
      await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [owner]);
      await service.review(owner, a.id, "APPROVED", "manual handling required");
      assert.equal((await service.list(successor, { page: 1, pageSize: 20 })).items[0].status, "APPROVED");
      assert.equal((await runner.query("SELECT id FROM users WHERE id = ?", [owner])).length, 1);
      assert.equal((await runner.query("SELECT id FROM families WHERE id = ?", [family])).length, 1);
      const deletion = new DeletionService(db, families, { enabled: true, remove: async () => undefined } as unknown as CosStorage);
      await assert.rejects(deletion.execute(owner, a.id));
      assert.equal((await deletion.execute(successor, a.id)).status, "PROCESSING");
      await assert.rejects(families.get(successor, family));
      assert.deepEqual(await families.list(successor), []);
      await deletion.tick();
      assert.equal((await deletion.execute(successor, a.id)).status, "COMPLETED");
      const completed = (await service.list(successor, { page: 1, pageSize: 20 })).items[0];
      assert.equal(completed.family_id, null); assert.equal(completed.target_family_id, family);
      assert.equal((await runner.query("SELECT id FROM families WHERE id = ?", [family])).length, 0);
      assert.equal((await runner.query("SELECT id FROM users WHERE id IN (?, ?)", [owner, successor])).length, 2);
    });
  } finally {
    await db.onModuleDestroy();
    await runner.query("DELETE FROM audit_logs WHERE actor_id IN (?, ?)", [owner, successor]);
    await runner.query("DELETE FROM data_requests WHERE user_id IN (?, ?)", [owner, successor]);
    await runner.query("DELETE FROM policy_consents WHERE user_id IN (?, ?)", [owner, successor]);
    if (family) {
      for (const table of ["entries", "assets", "media_uploads", "export_tasks", "export_jobs", "family_storage", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [family]);
      await runner.query("DELETE FROM families WHERE id = ?", [family]);
    }
    await runner.query("DELETE FROM users WHERE id IN (?, ?)", [owner, successor]);
  }
}
