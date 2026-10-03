import type { MigrationInterface, QueryRunner } from "typeorm";

export class AuthSessions1790985601000 implements MigrationInterface {
  readonly name = "AuthSessions1790985601000";

  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable("auth_sessions")) throw new Error("auth_sessions already exists; inspect schema before retrying");
    await runner.query(`CREATE TABLE auth_sessions (
      token_hash char(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      auth_method enum('WECHAT','DEV') NOT NULL,
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at datetime(3) NOT NULL,
      KEY ix_sessions_user (user_id),
      KEY ix_sessions_expiry (expires_at),
      CONSTRAINT ck_sessions_expiry CHECK (expires_at > created_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const rows: unknown[] = await runner.query("SELECT 1 FROM auth_sessions LIMIT 1");
    if (rows.length) throw new Error("Refusing to remove non-empty auth_sessions");
    await runner.query("DROP TABLE auth_sessions");
  }
}
