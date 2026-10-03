import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DataSource, QueryRunner } from "typeorm";
import { createMigrationDataSource } from "../src/database/data-source";
import { execute } from "../src/database/migrate";
import { InitialSchema1790985600000 } from "../src/database/migrations/1790985600000-initial-schema";
import { AuthSessions1790985601000 } from "../src/database/migrations/1790985601000-auth-sessions";

test("migration datasource is explicit and never synchronizes schema on startup", () => {
  assert.throws(() => createMigrationDataSource(undefined), /MIGRATION_DATABASE_URL/);
  const source = createMigrationDataSource("mysql://growth_migrator:test@127.0.0.1:3306/growth_diary_test");
  assert.equal(source.options.synchronize, false);
  assert.equal(source.options.migrationsRun, false);
  assert.equal(source.options.migrationsTransactionMode, "none");
});

test("partial schema is rejected before any CREATE", async () => {
  const queries: string[] = [];
  const runner = {
    hasTable: async (name: string) => name === "assets",
    query: async (sql: string) => { queries.push(sql); return [{ version: "8.4.0" }]; },
  } as unknown as QueryRunner;
  await assert.rejects(new InitialSchema1790985600000().up(runner), /absent business tables/);
  assert.deepEqual(queries, ["SELECT VERSION() AS version"]);
});

test("older MySQL is rejected before checking or creating tables", async () => {
  const runner = { query: async () => [{ version: "8.0.15" }] } as unknown as QueryRunner;
  await assert.rejects(new InitialSchema1790985600000().up(runner), /MySQL 8.4/);
});

test("concurrent migration refusal still releases its connection", async () => {
  let released = false, destroyed = false;
  const runner = {
    connect: async () => {},
    query: async () => [{ acquired: 0 }],
    release: async () => { released = true; },
  };
  const source = {
    options: { database: "growth_diary_test" },
    initialize: async () => {},
    isInitialized: true,
    createQueryRunner: () => runner,
    destroy: async () => { destroyed = true; },
  } as unknown as DataSource;
  await assert.rejects(execute(source, "run"), /Another migration/);
  assert.ok(released && destroyed);
});

test("non-empty schema rollback is refused before any DROP", async () => {
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes("`audit_logs`") ? [{ value: 1 }] : [];
    },
  } as unknown as QueryRunner;
  await assert.rejects(new InitialSchema1790985600000().down(runner), /non-empty schema/);
  assert.ok(queries.every((sql) => sql.startsWith("SELECT")));
});

test("session migration rejects existing tables and refuses to discard sessions", async () => {
  const queries: string[] = [];
  const runner = {
    hasTable: async () => true,
    query: async (sql: string) => { queries.push(sql); return [{ value: 1 }]; },
  } as unknown as QueryRunner;
  const migration = new AuthSessions1790985601000();
  await assert.rejects(migration.up(runner), /already exists/);
  assert.equal(queries.length, 0);
  await assert.rejects(migration.down(runner), /non-empty auth_sessions/);
  assert.deepEqual(queries, ["SELECT 1 FROM auth_sessions LIMIT 1"]);
});

test("migration CLI refuses missing migration credentials even if MYSQL_URL is present", () => {
  const directory = mkdtempSync(join(tmpdir(), "growth-diary-migration-"));
  try {
    const result = spawnSync(process.execPath, [join(__dirname, "../src/database/migrate.js"), "run"], {
      cwd: directory,
      env: { ...process.env, MIGRATION_DATABASE_URL: "", MYSQL_URL: "mysql://runtime:private@127.0.0.1/db" },
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Migration failed/);
    assert.ok(!result.stderr.includes("private"));
  } finally {
    rmdirSync(directory);
  }
});
