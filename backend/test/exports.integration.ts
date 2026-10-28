import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestContext } from "node:test";
import { QueryRunner } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { ChildrenService } from "../src/children/children.service";
import { EntriesService } from "../src/entries/entries.service";
import { CosStorage } from "../src/media/cos-storage";
import { ExportsService } from "../src/exports/exports.service";
import { Exports1790985605000 } from "../src/database/migrations/1790985605000-exports";

export async function exerciseExports(t: TestContext, runner: QueryRunner, url: string) {
  const user = randomUUID(); let family = "";
  const db = new DatabaseService(new ConfigService({ MYSQL_URL: url })), families = new FamiliesService(db, new ConfigService());
  const objects = new Map<string, Buffer>();
  const cos = { enabled: true, remove: async (key: string) => { objects.delete(key); },
    putStream: async (key: string, stream: AsyncIterable<Buffer>, size: number) => { const chunks = []; for await (const b of stream) chunks.push(b); const bytes = Buffer.concat(chunks); assert.equal(bytes.length, size); objects.set(key, bytes); },
    url: (key: string) => `https://private.invalid/${key}` } as unknown as CosStorage;
  const exports = new ExportsService(db, families, cos);
  try {
    await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname) VALUES (?, 'export-test', ?, '测试')", [user, user]);
    await runner.query("INSERT INTO family_creation_permissions (user_id) VALUES (?)", [user]);
    family = (await families.create(user, "导出测试")).id;
    const child = await new ChildrenService(db, families).save(user, family, { name: "宝宝", birthday: "2024-01-01", genderLabel: "宝宝", avatarColor: "#F0A58A" });
    const entries = new EntriesService(db, families);
    const entry = await entries.save(user, family, { requestId: randomUUID(), childId: child.id, kind: "DIARY", title: "导出测试", body: "初始", occurredAt: "2026-01-01", assetIds: [] });
    await t.test("export same request is idempotent under concurrency; one family task and snapshot invalidation", async () => {
      const request = randomUUID();
      const [a, b] = await Promise.all([exports.create(user, family, child.id, "2026-Q1", request), exports.create(user, family, child.id, "2026-Q1", request)]);
      assert.equal(a.id, b.id);
      await assert.rejects(exports.create(user, family, child.id, "2026", randomUUID()));
      await runner.query("UPDATE entries SET body = 'changed' WHERE id = ?", [entry.id]);
      await exports.tick();
      assert.equal((await exports.list(user, family))[0].error, "SNAPSHOT_CHANGED");
      await exports.tick();
      const job = await exports.create(user, family, child.id, "2026", randomUUID());
      await exports.tick();
      assert.equal((await exports.list(user, family))[0].status, "READY");
      assert.ok((await exports.download(user, family, job.id, 1)).url);
      assert.ok(objects.size);
      await exports.cancel(user, family, job.id); await exports.tick(); assert.equal(objects.size, 0);
      await assert.rejects(exports.download(user, family, job.id, 1));
      await assert.rejects(new Exports1790985605000().down(runner), /non-empty/);
    });
  } finally {
    await db.onModuleDestroy();
    if (family) {
      for (const table of ["export_pairings", "export_tasks", "audit_logs", "entry_requests", "entries", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [family]);
      await runner.query("DELETE FROM families WHERE id = ?", [family]);
    }
    await runner.query("DELETE FROM users WHERE id = ?", [user]);
  }
}
