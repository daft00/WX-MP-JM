import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EntityManager, QueryRunner } from "typeorm";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { ChildrenService } from "../src/children/children.service";

// 仅由已经验证 MySQL 版本、专用库名及初始空库的集成测试入口调用。
export async function exerciseFamilies(t: TestContext, runner: QueryRunner, url: string) {
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const [owner, admin, member, outsider, peerAdmin, racerA, racerB] = ids;
  const placeholders = ids.map(() => "?").join(",");
  const database = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
  const config = new ConfigService({ INVITE_CODE_SECRET: "b".repeat(64) });
  const service = new FamiliesService(database, config);
  const rejectStatus = (expected: number) => (error: unknown) => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), expected);
    return true;
  };
  try {
    for (const id of ids) await runner.query("INSERT INTO users (id, wechat_app_id, wechat_openid, nickname) VALUES (?, 'family-test', ?, '测试用户')", [id, id]);
    const family = await service.create(owner, "测试家庭甲");
    const otherFamily = await service.create(outsider, "测试家庭乙");
    const ownerMember = (await service.members(owner, family.id))[0];
    const inviteAndJoin = async (id: string) => {
      const invitation = await service.createInvite(owner, family.id);
      await service.join(id, invitation.code.toLowerCase());
      return (await service.members(owner, family.id)).find((row) => row.userId === id)!;
    };
    const adminMember = await inviteAndJoin(admin);
    const memberRow = await inviteAndJoin(member);
    const peerMember = await inviteAndJoin(peerAdmin);
    await service.changeRole(owner, family.id, adminMember.id, "ADMIN");
    await service.changeRole(owner, family.id, peerMember.id, "ADMIN");

    const children = new ChildrenService(database, service);
    const childDraft = { name: "乐乐", birthday: "2024-02-29", genderLabel: "宝宝", avatarColor: "#F0A58A" };
    await t.test("child profiles enforce family scope, roles and DATE round trips", async () => {
      assert.deepEqual(await children.list(member, family.id), []);
      const child = await children.save(admin, family.id, childDraft);
      assert.equal(child.creatorId, admin);
      assert.equal(child.birthday, "2024-02-29");
      assert.deepEqual(await children.get(member, family.id, child.id), child);
      const updated = await children.save(owner, family.id, { ...childDraft, name: "乐乐新称呼" }, child.id);
      assert.equal(updated.creatorId, admin);
      assert.equal(updated.createdAt, child.createdAt);
      assert.equal(updated.name, "乐乐新称呼");
      await assert.rejects(children.save(member, family.id, childDraft), rejectStatus(403));
      await assert.rejects(children.save(member, family.id, childDraft, child.id), rejectStatus(403));
      await assert.rejects(children.get(outsider, otherFamily.id, child.id), rejectStatus(404));
      await assert.rejects(children.save(outsider, otherFamily.id, childDraft, child.id), rejectStatus(404));
      await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [outsider]);
      await assert.rejects(children.list(outsider, family.id), rejectStatus(404));
      await service.changeRole(owner, family.id, adminMember.id, "MEMBER");
      await assert.rejects(children.save(admin, family.id, childDraft, child.id), rejectStatus(403));
      await service.changeRole(owner, family.id, adminMember.id, "ADMIN");
      const audits = await runner.query("SELECT action FROM audit_logs WHERE target_id = ? ORDER BY action", [child.id]);
      assert.deepEqual(audits.map((item: { action: string }) => item.action), ["CHILD_CREATE", "CHILD_UPDATE"]);
    });

    await t.test("family visibility, owner creation and family-scoped member IDs", async () => {
      assert.equal(ownerMember.role, "OWNER");
      assert.deepEqual((await service.list(owner)).map((row) => row.id), [family.id]);
      assert.deepEqual((await service.list(outsider)).map((row) => row.id), [otherFamily.id]);
      await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [outsider]);
      await assert.rejects(service.get(outsider, family.id), rejectStatus(404));
      await assert.rejects(service.members(outsider, family.id), rejectStatus(404));
      const foreignMember = (await service.members(outsider, otherFamily.id))[0];
      await assert.rejects(service.changeRole(owner, family.id, foreignMember.id, "ADMIN"), rejectStatus(404));
      await assert.rejects(service.remove(owner, family.id, foreignMember.id), rejectStatus(404));
      await assert.rejects(service.changeRole(admin, family.id, memberRow.id, "ADMIN"), rejectStatus(403));
      await assert.rejects(service.changeRole(owner, family.id, ownerMember.id, "MEMBER"), rejectStatus(403));
      await assert.rejects(service.remove(admin, family.id, peerMember.id), rejectStatus(403));
      await assert.rejects(service.remove(member, family.id, adminMember.id), rejectStatus(403));
      await assert.rejects(service.createInvite(member, family.id), rejectStatus(403));
    });

    let loser = racerA;
    await t.test("one invite admits exactly one concurrent caller and cannot be replayed", async () => {
      const invite = await service.createInvite(owner, family.id);
      const stored = await runner.query("SELECT code_hash FROM invites WHERE id = ?", [invite.id]);
      assert.match(stored[0].code_hash, /^[a-f0-9]{64}$/);
      assert.notEqual(stored[0].code_hash, invite.code);
      const results = await Promise.allSettled([service.join(racerA, invite.code), service.join(racerB, invite.code)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      rejectStatus(400)(rejected.reason);
      loser = results[0].status === "rejected" ? racerA : racerB;
      await assert.rejects(service.join(loser, invite.code), rejectStatus(400));
      const row = (await runner.query("SELECT used_by, used_at FROM invites WHERE id = ?", [invite.id]))[0];
      assert.ok(row.used_by && row.used_at);
      assert.notEqual(row.used_by, loser);
    });

    await t.test("expired invitations and removed or demoted administrators cannot grant access", async () => {
      const expired = await service.createInvite(owner, family.id);
      await runner.query("UPDATE invites SET created_at = UTC_TIMESTAMP(3) - INTERVAL 2 DAY, expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 DAY WHERE id = ?", [expired.id]);
      await assert.rejects(service.join(loser, expired.code), rejectStatus(400));
      const demoted = await service.createInvite(admin, family.id);
      await service.changeRole(owner, family.id, adminMember.id, "MEMBER");
      await assert.rejects(service.join(loser, demoted.code), rejectStatus(400));
      await assert.rejects(service.createInvite(admin, family.id), rejectStatus(403));
      await service.changeRole(owner, family.id, adminMember.id, "ADMIN");
      const removed = await service.createInvite(admin, family.id);
      await service.remove(owner, family.id, adminMember.id);
      await assert.rejects(service.join(loser, removed.code), rejectStatus(400));
      await assert.rejects(service.get(admin, family.id), rejectStatus(404));
      await assert.rejects(children.list(admin, family.id), rejectStatus(404));
      assert.equal((await service.list(admin)).length, 0);
    });

    await t.test("an administrator removes a member without deleting their historical content", async () => {
      const childId = randomUUID();
      await runner.query("INSERT INTO children (id, family_id, creator_id, name, birthday) VALUES (?, ?, ?, '宝宝', '2025-01-01')", [childId, family.id, member]);
      await service.remove(peerAdmin, family.id, memberRow.id);
      await assert.rejects(service.members(member, family.id), rejectStatus(404));
      assert.equal((await runner.query("SELECT id FROM children WHERE id = ?", [childId])).length, 1);
      assert.ok((await runner.query("SELECT id FROM audit_logs WHERE family_id = ? AND action = 'MEMBER_REMOVE'", [family.id])).length >= 2);
    });

    await t.test("audit failure rolls back family creation, invite consumption and membership insertion", async () => {
      const failingDatabase = { transaction: (work: (manager: EntityManager) => Promise<unknown>) => database.transaction((manager) => work({
        query: (sql: string, params: unknown[]) => sql.startsWith("INSERT INTO audit_logs")
          ? Promise.reject(new Error("simulated audit failure")) : manager.query(sql, params),
      } as unknown as EntityManager)) } as DatabaseService;
      const failingService = new FamiliesService(failingDatabase, config);
      const failingChildren = new ChildrenService(failingDatabase, failingService);
      const before = await children.list(owner, family.id);
      await assert.rejects(failingChildren.save(owner, family.id, childDraft), /audit failure/);
      await assert.rejects(failingChildren.save(owner, family.id, { ...childDraft, name: "不应保存" }, before[0].id), /audit failure/);
      assert.deepEqual(await children.list(owner, family.id), before);
      await assert.rejects(failingService.create(owner, "回滚家庭"), /audit failure/);
      assert.equal((await service.list(owner)).length, 1);
      const invitation = await service.createInvite(owner, family.id);
      await assert.rejects(failingService.join(loser, invitation.code), /audit failure/);
      assert.equal((await runner.query("SELECT used_at FROM invites WHERE id = ?", [invitation.id]))[0].used_at, null);
      await assert.rejects(service.get(loser, family.id), rejectStatus(404));
      await assert.rejects(service.join(owner, invitation.code), rejectStatus(409));
      assert.equal((await runner.query("SELECT used_at FROM invites WHERE id = ?", [invitation.id]))[0].used_at, null);
    });

    await t.test("two different invitations cannot create duplicate memberships for one user", async () => {
      const one = await service.createInvite(owner, family.id), two = await service.createInvite(owner, family.id);
      const results = await Promise.allSettled([service.join(loser, one.code), service.join(loser, two.code)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      rejectStatus(409)((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason);
      const members = await runner.query("SELECT id FROM family_members WHERE family_id = ? AND user_id = ?", [family.id, loser]);
      assert.equal(members.length, 1);
      const used = await runner.query("SELECT id FROM invites WHERE id IN (?, ?) AND used_at IS NOT NULL", [one.id, two.id]);
      assert.equal(used.length, 1);
    });
  } finally {
    await database.onModuleDestroy();
    // 清理范围仅为本用例随机用户创建的家庭，入口已保证测试库初始为空。
    const families: { id: string }[] = await runner.query(`SELECT id FROM families WHERE owner_id IN (${placeholders})`, ids);
    await runner.query(`DELETE FROM audit_logs WHERE actor_id IN (${placeholders})`, ids);
    for (const { id } of families) {
      for (const table of ["invites", "children", "family_members"]) await runner.query(`DELETE FROM ${table} WHERE family_id = ?`, [id]);
      await runner.query("DELETE FROM families WHERE id = ?", [id]);
    }
    await runner.query(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
  }
}
