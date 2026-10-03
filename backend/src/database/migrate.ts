import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { DataSource, MigrationExecutor, QueryRunner } from "typeorm";
import { createMigrationDataSource } from "./data-source";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!["show", "run", "revert"].includes(command)) {
    throw new Error("Expected migration command: show, run or revert");
  }
  // 迁移凭据与运行配置分开；绝不回退到 MYSQL_URL。
  if (existsSync(".env.migration")) loadEnvFile(".env.migration");
  const source = createMigrationDataSource(process.env.MIGRATION_DATABASE_URL);
  await execute(source, command);
}

export async function execute(source: DataSource, command: string): Promise<void> {
  let lock: QueryRunner | undefined;
  let acquired = false;
  const name = "growth-diary:" + createHash("sha256").update(String(source.options.database)).digest("hex").slice(0, 40);
  try {
    await source.initialize();
    lock = source.createQueryRunner();
    await lock.connect();
    const rows: { acquired: number | null }[] = await lock.query("SELECT GET_LOCK(?, 0) AS acquired", [name]);
    if (rows[0]?.acquired !== 1) throw new Error("Another migration is running");
    acquired = true;
    await lock.query("SET SESSION time_zone = '+00:00'");
    const executor = new MigrationExecutor(source, lock);
    executor.transaction = "none";
    if (command === "show") {
      const pending = await executor.getPendingMigrations();
      console.log(pending.length ? `Pending: ${pending.map((item) => item.name).join(", ")}` : "No pending migrations");
    } else if (command === "run") {
      const applied = await executor.executePendingMigrations();
      console.log(applied.length ? `Applied: ${applied.map((item) => item.name).join(", ")}` : "No pending migrations");
    } else if (command === "revert") {
      await executor.undoLastMigration();
      console.log("Revert finished (non-empty tables are protected)");
    } else {
      throw new Error("Unsupported migration command");
    }
  } finally {
    try {
      if (acquired) await lock?.query("SELECT RELEASE_LOCK(?)", [name]);
    } finally {
      try { await lock?.release(); }
      finally { if (source.isInitialized) await source.destroy(); }
    }
  }
}

if (require.main === module) {
  void main().catch(() => {
    // QueryFailedError 包含完整 SQL/参数，不能原样打印。
    console.error("Migration failed. Check migration credentials, privileges, concurrent runs and schema state. MySQL DDL may have partially committed; inspect before retrying. See docs/database.md.");
    process.exitCode = 1;
  });
}
