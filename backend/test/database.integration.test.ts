import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConfigService } from "@nestjs/config";
import { MigrationExecutor } from "typeorm";
import { databaseOptions } from "../src/config";
import { createMigrationDataSource } from "../src/database/data-source";
import { INITIAL_TABLE_NAMES, InitialSchema1790985600000 } from "../src/database/migrations/1790985600000-initial-schema";
import { AuthSessions1790985601000 } from "../src/database/migrations/1790985601000-auth-sessions";
import { DatabaseService } from "../src/database/database.service";
import { AuthStore } from "../src/auth/auth.store";
import { hashToken } from "../src/auth/auth.service";
import { exerciseFamilies } from "./families.integration";
import { exerciseEntries } from "./entries.integration";
import { exerciseAdmin } from "./admin.integration";

test("MySQL 8.4 migrations and relational constraints", { timeout: 60000 }, async (t) => {
  // 此命令必须显式配置专用空库；缺失时失败，不能以跳过冒充数据库验收通过。
  const url = process.env.TEST_MIGRATION_DATABASE_URL;
  const options = databaseOptions(url, "TEST_MIGRATION_DATABASE_URL");
  assert.match(options.database!, /^growth_diary_test(?:_[a-z0-9]+)?$/, "Use a dedicated growth_diary_test database");
  const source = createMigrationDataSource(url);
  await source.initialize();
  const runner = source.createQueryRunner();
  try {
    await runner.connect();
    const version = await runner.query("SELECT VERSION() AS version");
    assert.match(version[0].version, /^8\.4\./, "Integration target is MySQL 8.4");
    const before = await runner.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()");
    assert.equal(before.length, 0, "Refusing to modify a non-empty test schema");
    await runner.query("SET SESSION time_zone = '+00:00'");
    const executor = new MigrationExecutor(source, runner);
    executor.transaction = "none";
    assert.equal((await executor.executePendingMigrations()).length, 2);
    assert.equal((await executor.executePendingMigrations()).length, 0);
    assert.equal((await executor.getPendingMigrations()).length, 0);
    const inventory = await runner.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()");
    assert.deepEqual(inventory.map((row: { name: string }) => row.name).sort(), [...INITIAL_TABLE_NAMES, "auth_sessions", "schema_migrations"].sort());

    const insert = (table: string, values: Record<string, unknown>) => runner.query(
      `INSERT INTO \`${table}\` (${Object.keys(values).map((key) => `\`${key}\``).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`,
      Object.values(values),
    );
    const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => {
      assert.equal((error as { driverError?: { code: string } }).driverError?.code, code);
      return true;
    });

    await runner.startTransaction();
    const userA = randomUUID(), userB = randomUUID();
    const familyA = randomUUID(), familyB = randomUUID();
    const childA = randomUUID(), childB = randomUUID(), childA2 = randomUUID();
    for (const user of [userA, userB]) {
      await insert("users", { id: user, wechat_app_id: "test-app", wechat_openid: user, nickname: "测试宝宝👶" });
    }
    for (const [family, owner] of [[familyA, userA], [familyB, userB]]) {
      await insert("families", { id: family, name: "测试家庭", owner_id: owner });
      await insert("family_members", { id: randomUUID(), family_id: family, user_id: owner, role: "OWNER" });
    }
    for (const [child, family, creator] of [[childA, familyA, userA], [childA2, familyA, userA], [childB, familyB, userB]]) {
      await insert("children", { id: child, family_id: family, creator_id: creator, name: "宝宝", birthday: "2025-01-02" });
    }
    const entry = (family = familyA, child = childA) => ({
      id: randomUUID(), family_id: family, child_id: child, creator_id: userA,
      kind: "DIARY", title: "成长", body: "记录👶", occurred_at: "2026-10-03 08:00:00.123",
    });
    const entryA = entry();
    await insert("entries", entryA);
    const asset = (family = familyA, child = childA) => ({
      id: randomUUID(), family_id: family, child_id: child, creator_id: userA,
      kind: "IMAGE", object_key: `families/${family}/${randomUUID()}.jpg`, original_name: "宝宝.jpg",
      mime_type: "image/jpeg", size_bytes: "100", status: "READY", ready_at: "2026-10-03 08:00:00",
    });
    const assetA = asset(), assetB = asset(familyB, childB), assetA2 = asset(familyA, childA2);
    for (const row of [assetA, assetB, assetA2]) await insert("assets", row);

    await t.test("WeChat identity and family membership are unique; OWNER matches the family owner", async () => {
      await rejects(insert("users", { id: randomUUID(), wechat_app_id: "test-app", wechat_openid: userA, nickname: "重复" }), "ER_DUP_ENTRY");
      await rejects(insert("family_members", { id: randomUUID(), family_id: familyA, user_id: userA, role: "MEMBER" }), "ER_DUP_ENTRY");
      await rejects(insert("family_members", { id: randomUUID(), family_id: familyA, user_id: userB, role: "OWNER" }), "ER_NO_REFERENCED_ROW_2");
    });
    await t.test("composite foreign keys reject cross-family and cross-child links", async () => {
      await rejects(insert("entries", entry(familyA, childB)), "ER_NO_REFERENCED_ROW_2");
      for (const wrong of [assetB, assetA2]) {
        await rejects(insert("entry_assets", { entry_id: entryA.id, asset_id: wrong.id, family_id: familyA, child_id: childA, position: 0 }), "ER_NO_REFERENCED_ROW_2");
      }
      await insert("entry_assets", { entry_id: entryA.id, asset_id: assetA.id, family_id: familyA, child_id: childA, position: 0 });
    });
    await t.test("metric units, asset readiness and invite consumption are checked", async () => {
      const metric = { id: randomUUID(), family_id: familyA, child_id: childA, creator_id: userA, entry_id: entryA.id,
        type: "WEIGHT", value: "3.125", unit: "kg", measured_at: "2026-10-03 08:00:00.123" };
      await rejects(insert("metrics", { ...metric, unit: "cm" }), "ER_CHECK_CONSTRAINT_VIOLATED");
      await rejects(insert("metrics", { ...metric, value: "0" }), "ER_CHECK_CONSTRAINT_VIOLATED");
      await insert("metrics", metric);
      await rejects(insert("assets", { ...asset(), ready_at: null }), "ER_CHECK_CONSTRAINT_VIOLATED");
      const invite = { id: randomUUID(), family_id: familyA, creator_id: userA, code_hash: "a".repeat(64),
        created_at: "2026-10-03 08:00:00", expires_at: "2026-10-04 08:00:00" };
      await rejects(insert("invites", { ...invite, used_by: userB }), "ER_CHECK_CONSTRAINT_VIOLATED");
      await insert("invites", invite);
      await rejects(insert("invites", { ...invite, id: randomUUID() }), "ER_DUP_ENTRY");
      const result = await runner.query("SELECT value FROM metrics WHERE id = ?", [metric.id]);
      assert.equal(result[0].value, "3.125");
    });
    await t.test("rollback refuses data and entry deletion retains its COS asset record", async () => {
      await assert.rejects(new InitialSchema1790985600000().down(runner), /non-empty schema/);
      await runner.query("DELETE FROM entries WHERE id = ?", [entryA.id]);
      assert.equal((await runner.query("SELECT 1 FROM entry_assets WHERE entry_id = ?", [entryA.id])).length, 0);
      assert.equal((await runner.query("SELECT 1 FROM metrics WHERE entry_id = ?", [entryA.id])).length, 0);
      assert.equal((await runner.query("SELECT 1 FROM assets WHERE id = ?", [assetA.id])).length, 1);
    });
    await runner.rollbackTransaction();
    await t.test("runtime ORM persists concurrent login identity, hashes, expiry and revocation", async () => {
      const database = new DatabaseService(new ConfigService({ MYSQL_URL: url }));
      const store = new AuthStore(database);
      const openid = randomUUID();
      const firstHash = hashToken(randomUUID()), secondHash = hashToken(randomUUID());
      const expires = new Date(Date.now() + 3600000);
      try {
        const [first, second] = await Promise.all([
          store.createSession("test-auth", openid, "WECHAT", firstHash, expires),
          store.createSession("test-auth", openid, "WECHAT", secondHash, expires),
        ]);
        assert.equal(first.id, second.id);
        assert.equal(first.systemRole, undefined);
        assert.equal((await store.findSession(firstHash))?.user.id, first.id);
        const session = await store.findSession(firstHash);
        assert.equal(session?.user.wechatOpenid, undefined);
        assert.equal(session?.user.wechatAppId, undefined);
        await runner.query("UPDATE users SET system_role = 'SYSTEM_ADMIN' WHERE id = ?", [first.id]);
        assert.equal((await store.findSession(firstHash))?.user.systemRole, "SYSTEM_ADMIN");
        await assert.rejects(new AuthSessions1790985601000().down(runner), /non-empty auth_sessions/);
        await store.deleteSession(firstHash);
        assert.equal(await store.findSession(firstHash), null);
        assert.ok(await store.findSession(secondHash));
        await runner.query("UPDATE auth_sessions SET created_at = UTC_TIMESTAMP(3) - INTERVAL 2 HOUR, expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 HOUR WHERE token_hash = ?", [secondHash]);
        assert.equal(await store.findSession(secondHash), null);
      } finally {
        await database.onModuleDestroy();
        // 只清理本用例在已验证为空的专用库中创建的用户，外键清理其会话。
        await runner.query("DELETE FROM users WHERE wechat_app_id = ? AND wechat_openid = ?", ["test-auth", openid]);
      }
    });
    await exerciseFamilies(t, runner, url!);
    await exerciseEntries(t, runner, url!);
    await exerciseAdmin(t, runner, url!);
    await executor.undoLastMigration();
    assert.equal(await runner.hasTable("auth_sessions"), false);
    await executor.undoLastMigration();
    for (const name of INITIAL_TABLE_NAMES) assert.equal(await runner.hasTable(name), false);
    // 回滚后还能重新升级，且再次回滚可保持专用测试库为空，允许重复验收。
    assert.equal((await executor.executePendingMigrations()).length, 2);
    await executor.undoLastMigration();
    await executor.undoLastMigration();
    await runner.query("DROP TABLE schema_migrations");
  } finally {
    try { if (runner.isTransactionActive) await runner.rollbackTransaction(); }
    finally {
      try { await runner.release(); }
      finally { await source.destroy(); }
    }
  }
});
