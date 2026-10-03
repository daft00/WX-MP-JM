import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EntityManager, QueryRunner } from "typeorm";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { ChildrenService } from "../src/children/children.service";
import { AdminService } from "../src/admin/admin.service";

// 由已验证专用空 MySQL 8.4 测试库的入口调用。
export async function exerciseAdmin(t: TestContext, runner: QueryRunner, url: string) {
  const ids = Array.from({ length: 4 }, () => randomUUID()), [owner, operator, member, outsider] = ids;
  const database = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
  const config = new ConfigService({ INVITE_CODE_SECRET: "b".repeat(64) });
  const families = new FamiliesService(database, config), children = new ChildrenService(database, families), admin = new AdminService(database, families);
  const paging = { page: 1, pageSize: 20 };
  const status = (code: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === code;
  try {
    for (const id of ids) await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname) VALUES (?, 'admin-test', ?, '测试用户')", [id, id]);
    await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [operator]);
    const family = await families.create(owner, "管理测试家庭"), other = await families.create(outsider, "其他家庭");
    await families.join(member, (await families.createInvite(owner, family.id)).code);
    const target = (await families.members(owner, family.id)).find((item) => item.userId === member)!;
    const ownerMember = (await families.members(owner, family.id)).find((item) => item.role === "OWNER")!;
    const baby = await children.save(owner, family.id, { name: "隐私宝宝", birthday: "2024-01-01", genderLabel: "宝宝", avatarColor: "#F0A58A" });

    await t.test("system read APIs provide metadata without granting family content access", async () => {
      await assert.rejects(admin.dashboard(owner), status(403));
      assert.deepEqual(await admin.dashboard(operator), { familyCount: 2, userCount: 4, childCount: 1, entryCount: 0, assetCount: 0 });
      const familyPage = await admin.listFamilies(operator, { page: 1, pageSize: 1 });
      assert.equal(familyPage.hasMore, true);
      assert.equal((await admin.listFamilies(operator, { page: 2, pageSize: 1 })).items.length, 1);
      assert.equal((await admin.listUsers(operator, paging)).items.length, 4);
      assert.equal((await admin.members(operator, family.id, paging)).items.length, 2);
      assert.ok(!JSON.stringify(familyPage).includes("隐私宝宝"));
      await assert.rejects(children.get(operator, family.id, baby.id), status(404));
      await assert.rejects(families.createInvite(operator, family.id), status(404));
      await assert.rejects(admin.changeRole(operator, family.id, ownerMember.id, { role: "MEMBER", reason: "测试" }), status(403));
      await assert.rejects(admin.remove(operator, other.id, target.id, "测试"), status(404));
    });

    await t.test("management records actor/reason and rollback restores role, membership and invites", async () => {
      await admin.changeRole(operator, family.id, target.id, { role: "ADMIN", reason: "家庭申请提升" });
      const invitation = await families.createInvite(member, family.id);
      const failingDatabase = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => database.transaction((manager) => work({
        query: (sql: string, params: unknown[]) => sql.startsWith("INSERT INTO audit_logs") ? Promise.reject(new Error("audit failure")) : manager.query(sql, params),
      } as unknown as EntityManager)) } as DatabaseService;
      const failing = new AdminService(failingDatabase, new FamiliesService(failingDatabase, config));
      await assert.rejects(failing.changeRole(operator, family.id, target.id, { role: "MEMBER", reason: "应回滚" }), /audit failure/);
      await assert.rejects(failing.remove(operator, family.id, target.id, "应回滚"), /audit failure/);
      assert.equal((await families.members(owner, family.id)).find((item) => item.id === target.id)!.role, "ADMIN");
      assert.equal((await runner.query("SELECT id FROM invites WHERE id = ?", [invitation.id])).length, 1);
      const logs = await admin.audits(operator, { ...paging, familyId: family.id, actorId: operator, action: "SYSTEM_MEMBER_ROLE" });
      assert.equal(logs.items.length, 1);
      assert.equal(logs.items[0].targetId, target.id);
      assert.equal(logs.items[0].reason, "MEMBER -> ADMIN: 家庭申请提升");
      await admin.changeRole(operator, family.id, target.id, { role: "MEMBER", reason: "家庭申请降级" });
      assert.equal((await runner.query("SELECT id FROM invites WHERE id = ?", [invitation.id])).length, 0);
      await assert.rejects(families.join(outsider, invitation.code), status(400));
      await admin.changeRole(operator, family.id, target.id, { role: "ADMIN", reason: "再次授权" });
      const removedInvite = await families.createInvite(member, family.id);
      await admin.remove(operator, family.id, target.id, "家庭申请移除");
      assert.equal((await runner.query("SELECT id FROM invites WHERE id = ?", [removedInvite.id])).length, 0);
      await assert.rejects(children.get(member, family.id, baby.id), status(404));
      assert.equal((await children.get(owner, family.id, baby.id)).name, "隐私宝宝");
      assert.equal((await admin.audits(operator, { ...paging, action: "SYSTEM_MEMBER_REMOVE" })).items.length, 1);
    });

    await t.test("revoking system role blocks subsequent requests without ending the login session", async () => {
      await runner.query("UPDATE users SET system_role = 'USER' WHERE id = ?", [operator]);
      await assert.rejects(admin.dashboard(operator), status(403));
      await assert.rejects(admin.audits(operator, paging), status(403));
      await assert.rejects(admin.remove(operator, family.id, ownerMember.id, "测试"), status(403));
    });
  } finally {
    await database.onModuleDestroy();
    const scope: { id: string }[] = await runner.query("SELECT id FROM families WHERE owner_id IN (?, ?, ?, ?)", ids);
    await runner.query("DELETE FROM audit_logs WHERE actor_id IN (?, ?, ?, ?)", ids);
    for (const { id } of scope) {
      for (const table of ["invites", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [id]);
      await runner.query("DELETE FROM families WHERE id = ?", [id]);
    }
    await runner.query("DELETE FROM users WHERE id IN (?, ?, ?, ?)", ids);
  }
}
