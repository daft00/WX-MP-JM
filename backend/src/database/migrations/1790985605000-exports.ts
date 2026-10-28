import { MigrationInterface, QueryRunner } from "typeorm";

export class Exports1790985605000 implements MigrationInterface {
  readonly name = "Exports1790985605000";
  async up(r: QueryRunner) {
    for (const t of ["export_tasks", "export_pairings"]) if (await r.hasTable(t)) throw new Error("Export tables exist; inspect partial migration");
    await r.query(`CREATE TABLE export_tasks (
      id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      child_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      creator_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      period varchar(7) NOT NULL, status varchar(16) NOT NULL DEFAULT 'PENDING',
      snapshot json NOT NULL, parts json NOT NULL, progress int unsigned NOT NULL DEFAULT 0,
      attempts int unsigned NOT NULL DEFAULT 0, error varchar(40) NULL, cleaned boolean NOT NULL DEFAULT false,
      confirmed_at datetime(3) NULL, expires_at datetime(3) NULL,
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_export_request (family_id, creator_id, request_id),
      KEY ix_export_queue (status, created_at),
      CONSTRAINT fk_export_task_child FOREIGN KEY (child_id, family_id) REFERENCES children(id, family_id),
      CONSTRAINT fk_export_task_user FOREIGN KEY (creator_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await r.query(`CREATE TABLE export_pairings (
      id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      browser_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      confirm_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      user_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      expires_at datetime(3) NOT NULL, session_expires_at datetime(3) NULL,
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY ix_pair_expiry (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(r: QueryRunner) {
    for (const t of ["export_tasks", "export_pairings"]) if ((await r.query(`SELECT 1 FROM ${t} LIMIT 1`)).length) throw new Error("Refusing non-empty export tables");
    await r.query("DROP TABLE export_pairings");
    await r.query("DROP TABLE export_tasks");
  }
}
