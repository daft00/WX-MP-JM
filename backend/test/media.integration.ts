import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { QueryRunner } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { ChildrenService } from "../src/children/children.service";
import { MediaService } from "../src/media/media.service";
import { CosStorage, PREVIEW_LIMIT } from "../src/media/cos-storage";
import { Media1790985604000 } from "../src/database/migrations/1790985604000-media";

// 调用入口仅允许专用空MySQL测试库；云对象另由HTTP契约测试验证。
export async function exerciseMedia(t: TestContext, runner: QueryRunner, url: string) {
  const user = randomUUID(); let family = "";
  const db = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
  const families = new FamiliesService(db, new ConfigService());
  let deletionFails = false;
  const objects = new Set<string>();
  const storage = {
    enabled: true, upload: async () => ({ url: "https://test.invalid", formData: {} }), url: () => "https://private.invalid",
    freeze: async (_: string, target: string) => { objects.add(target); }, head: async () => ({ size: 100, etag: "e" }),
    inspect: async () => "image/jpeg", preview: async () => 25,
    remove: async (key: string) => { if (deletionFails) throw new Error("cloud unavailable"); objects.delete(key); },
  } as unknown as CosStorage;
  const service = new MediaService(db, families, storage);
  try {
    await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname, system_role) VALUES (?, 'media-test', ?, '测试', 'SYSTEM_ADMIN')", [user, user]);
    await runner.query("INSERT INTO family_creation_permissions (user_id) VALUES (?)", [user]);
    family = (await families.create(user, "媒体测试")).id;
    const child = await new ChildrenService(db, families).save(user, family, { name: "宝宝", birthday: "2024-01-01", genderLabel: "宝宝", avatarColor: "#F0A58A" });
    const draft = { requestId: randomUUID(), childId: child.id, name: "image.jpg", kind: "IMAGE" as const, sizeBytes: 100 };
    await t.test("concurrent reservation respects quota and same request creates exactly one upload", async () => {
      assert.equal((await service.adminQuota(user, family)).quotaBytes, 10 * 1024 ** 3);
      await service.setQuota(user, family, 200 + PREVIEW_LIMIT, "test quota");
      const result = await Promise.allSettled([service.start(user, family, draft), service.start(user, family, { ...draft, requestId: randomUUID() })]);
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      const [upload] = await runner.query("SELECT request_id, id FROM media_uploads WHERE family_id = ?", [family]);
      const [a, b] = await Promise.all([service.start(user, family, { ...draft, requestId: upload.request_id }), service.start(user, family, { ...draft, requestId: upload.request_id })]);
      assert.equal(a.asset.id, b.asset.id);
      assert.equal((await service.quota(user, family)).reservedBytes, 200 + PREVIEW_LIMIT);
      assert.equal((await service.adminQuota(user, family)).reservedBytes, 200 + PREVIEW_LIMIT);
      await assert.rejects(service.setQuota(user, family, 1, "不能低于并发预留"));
      assert.equal((await service.adminQuota(user, family)).quotaBytes, 200 + PREVIEW_LIMIT);
      await assert.rejects(service.start(user, family, { ...draft, requestId: upload.request_id, name: "changed" }));
      await service.complete(user, family, upload.id);
      await service.tick();
      assert.equal((await service.get(user, family, upload.id)).status, "READY");
      assert.equal((await service.quota(user, family)).usedBytes, 125);
      assert.equal((await service.quota(user, family)).reservedBytes, 100);
      await service.cancel(user, family, upload.id);
      await runner.query("UPDATE media_uploads SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE, next_attempt_at = UTC_TIMESTAMP(3) WHERE id = ?", [upload.id]);
      deletionFails = true;
      await service.tick();
      assert.equal((await service.quota(user, family)).usedBytes, 125);
      deletionFails = false;
      await runner.query("UPDATE media_uploads SET next_attempt_at = UTC_TIMESTAMP(3) WHERE id = ?", [upload.id]);
      await service.tick();
      assert.equal((await service.quota(user, family)).usedBytes, 0);
      assert.equal((await service.quota(user, family)).reservedBytes, 0);
      await assert.rejects(service.start(user, family, { ...draft, requestId: upload.request_id }));
      await assert.rejects(new Media1790985604000().down(runner), /non-empty/);
    });
  } finally {
    await db.onModuleDestroy();
    if (family) {
      await runner.query("DELETE FROM audit_logs WHERE family_id = ?", [family]);
      for (const table of ["media_uploads", "family_storage", "assets", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [family]);
      await runner.query("DELETE FROM families WHERE id = ?", [family]);
    }
    await runner.query("DELETE FROM users WHERE id = ?", [user]);
  }
}
