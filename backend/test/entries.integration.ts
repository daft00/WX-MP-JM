import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EntityManager, QueryRunner } from "typeorm";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { ChildrenService } from "../src/children/children.service";
import { EntriesService } from "../src/entries/entries.service";
import { SaveEntryDto } from "../src/entries/entries.dto";

// 入口已验证专用空 MySQL 8.4 测试库；只清理本用例随机用户拥有的家庭。
export async function exerciseEntries(t: TestContext, runner: QueryRunner, url: string) {
  const ids = Array.from({ length: 3 }, () => randomUUID()), [owner, member, outsider] = ids;
  const database = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
  const config = new ConfigService({ INVITE_CODE_SECRET: "b".repeat(64) });
  const families = new FamiliesService(database, config), children = new ChildrenService(database, families), service = new EntriesService(database, families);
  const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
  try {
    for (const id of ids) await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname) VALUES (?, 'entry-test', ?, '测试用户')", [id, id]);
    const family = await families.create(owner, "记录测试家庭"), other = await families.create(outsider, "其他家庭");
    await families.join(member, (await families.createInvite(owner, family.id)).code);
    const baby = { name: "宝宝", birthday: "2024-01-01", genderLabel: "宝宝", avatarColor: "#F0A58A" };
    const child = await children.save(owner, family.id, baby), secondChild = await children.save(owner, family.id, baby), foreign = await children.save(outsider, other.id, baby);
    const draft: SaveEntryDto = { childId: child.id, title: "成长记录", body: "正文", kind: "MILESTONE", occurredAt: "2024-02-29", assetIds: [], metricType: "WEIGHT", metricValue: 12.125 };
    const asset = randomUUID();
    await runner.query(`INSERT INTO assets (id, family_id, child_id, creator_id, kind, status, object_key, original_name, mime_type, size_bytes, ready_at)
      VALUES (?, ?, ?, ?, 'IMAGE', 'READY', ?, 'test.jpg', 'image/jpeg', 100, UTC_TIMESTAMP(3))`, [asset, family.id, child.id, member, `tests/${asset}.jpg`]);
    const entry = await service.save(member, family.id, { ...draft, assetIds: [asset] });

    await t.test("entry author, metric precision and asset order survive MySQL round trips", async () => {
      assert.equal(entry.creatorId, member);
      assert.equal(entry.metric?.value, 12.125);
      assert.equal(entry.metric?.unit, "kg");
      assert.equal(entry.metric?.measuredAt, "2024-02-29");
      assert.deepEqual(entry.assetIds, [asset]);
      assert.deepEqual(await service.get(owner, family.id, entry.id), entry);
      await assert.rejects(service.save(member, family.id, { ...draft, assetIds: [asset] }), status(409));
      await assert.rejects(service.save(member, family.id, { ...draft, childId: foreign.id }), status(404));
      await assert.rejects(service.get(outsider, other.id, entry.id), status(404));
      await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [outsider]);
      await assert.rejects(service.list(outsider, family.id, { pageSize: 20 }), status(404));
      await assert.rejects(service.metrics(outsider, family.id, { childId: child.id, type: "WEIGHT", pageSize: 20 }), status(404));
      const owned = await service.save(owner, family.id, draft);
      await assert.rejects(service.save(member, family.id, draft, owned.id), status(403));
      await assert.rejects(service.remove(member, family.id, entry.id), status(403));
    });

    await t.test("keyset pagination visits every same-day record and metric exactly once", async () => {
      await service.save(member, family.id, draft);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.list(member, family.id, { childId: child.id, pageSize: 1, cursor });
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        assert.ok(seen.length <= 3);
      } while (cursor);
      assert.equal(new Set(seen).size, 3);
      const metricIds: string[] = [];
      do {
        const page = await service.metrics(member, family.id, { childId: child.id, type: "WEIGHT", pageSize: 1, cursor });
        metricIds.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        assert.ok(metricIds.length <= 3);
      } while (cursor);
      assert.equal(new Set(metricIds).size, 3);
    });

    await t.test("audit failures roll back record, metric, associations and asset deletion state", async () => {
      const failingDatabase = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => database.transaction((manager) => work({
        query: (sql: string, params: unknown[]) => sql.startsWith("INSERT INTO audit_logs") ? Promise.reject(new Error("audit failure")) : manager.query(sql, params),
      } as unknown as EntityManager)) } as DatabaseService;
      const failing = new EntriesService(failingDatabase, new FamiliesService(failingDatabase, config));
      await assert.rejects(failing.save(member, family.id, { ...draft, childId: secondChild.id, title: "不应保存" }, entry.id), /audit failure/);
      await assert.rejects(failing.remove(owner, family.id, entry.id), /audit failure/);
      await assert.rejects(failing.save(member, family.id, draft), /audit failure/);
      assert.deepEqual(await service.get(member, family.id, entry.id), entry);
      assert.equal((await runner.query("SELECT status FROM assets WHERE id = ?", [asset]))[0].status, "READY");
      assert.equal((await service.list(member, family.id, { pageSize: 20 })).items.length, 3);
    });

    await t.test("editing replaces metrics atomically and preserves author; delete cascades and marks assets", async () => {
      const updated = await service.save(owner, family.id, { ...draft, metricType: "HEIGHT", metricValue: 80.5, assetIds: [asset] }, entry.id);
      assert.equal(updated.creatorId, member);
      assert.equal(updated.createdAt, entry.createdAt);
      assert.equal(updated.metric?.creatorId, member);
      assert.equal(updated.metric?.unit, "cm");
      const moved = await service.save(owner, family.id, { ...draft, childId: secondChild.id, kind: "DIARY", metricType: undefined, metricValue: undefined }, entry.id);
      assert.equal(moved.childId, secondChild.id);
      assert.equal(moved.metric, undefined);
      assert.deepEqual(moved.assetIds, []);
      assert.equal((await runner.query("SELECT id FROM metrics WHERE entry_id = ?", [entry.id])).length, 0);
      // 已解绑的素材仍属于原上传者，可在同一宝宝下再次绑定。
      await service.save(member, family.id, { ...draft, assetIds: [asset] }, entry.id);
      await service.remove(owner, family.id, entry.id);
      await assert.rejects(service.get(member, family.id, entry.id), status(404));
      assert.equal((await runner.query("SELECT id FROM metrics WHERE entry_id = ?", [entry.id])).length, 0);
      assert.equal((await runner.query("SELECT asset_id FROM entry_assets WHERE entry_id = ?", [entry.id])).length, 0);
      assert.equal((await runner.query("SELECT status FROM assets WHERE id = ?", [asset]))[0].status, "DELETING");
      const membership = (await families.members(owner, family.id)).find((item) => item.userId === member)!;
      await families.remove(owner, family.id, membership.id);
      await assert.rejects(service.save(member, family.id, draft), status(404));
      await assert.rejects(service.metrics(member, family.id, { childId: child.id, type: "WEIGHT", pageSize: 20 }), status(404));
    });
  } finally {
    await database.onModuleDestroy();
    const scope: { id: string }[] = await runner.query("SELECT id FROM families WHERE owner_id IN (?, ?, ?)", ids);
    await runner.query("DELETE FROM audit_logs WHERE actor_id IN (?, ?, ?)", ids);
    for (const { id } of scope) {
      for (const table of ["entries", "assets", "invites", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [id]);
      await runner.query("DELETE FROM families WHERE id = ?", [id]);
    }
    await runner.query("DELETE FROM users WHERE id IN (?, ?, ?)", ids);
  }
}
