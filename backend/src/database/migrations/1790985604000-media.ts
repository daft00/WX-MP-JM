import type { MigrationInterface, QueryRunner } from "typeorm";

export class Media1790985604000 implements MigrationInterface {
  readonly name = "Media1790985604000";
  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable("media_uploads") || await runner.hasTable("family_storage")) throw new Error("Media tables already exist; inspect partial migration before retrying");
    await runner.query(`CREATE TABLE family_storage (
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      quota_bytes bigint unsigned NOT NULL DEFAULT 10737418240,
      CONSTRAINT fk_storage_family FOREIGN KEY (family_id) REFERENCES families(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await runner.query(`CREATE TABLE media_uploads (
      id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      creator_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      body_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      reserved_bytes bigint unsigned NOT NULL,
      used_bytes bigint unsigned NOT NULL DEFAULT 0,
      declared_bytes bigint unsigned NOT NULL,
      requested boolean NOT NULL DEFAULT false,
      deleted boolean NOT NULL DEFAULT false,
      temp_deleted boolean NOT NULL DEFAULT false,
      expires_at datetime(3) NOT NULL,
      next_attempt_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_error varchar(64) NULL,
      UNIQUE KEY uq_media_request (family_id, creator_id, request_id),
      KEY ix_media_work (deleted, next_attempt_at),
      CONSTRAINT fk_media_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_media_user FOREIGN KEY (creator_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const table of ["media_uploads", "family_storage"]) {
      if ((await runner.query(`SELECT 1 FROM ${table} LIMIT 1`)).length) throw new Error("Refusing to remove non-empty media tables");
    }
    await runner.query("DROP TABLE media_uploads");
    await runner.query("DROP TABLE family_storage");
  }
}
