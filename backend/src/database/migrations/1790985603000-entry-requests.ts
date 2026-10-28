import type { MigrationInterface, QueryRunner } from "typeorm";

export class EntryRequests1790985603000 implements MigrationInterface {
  readonly name = "EntryRequests1790985603000";
  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable("entry_requests")) throw new Error("entry_requests already exists; inspect before retrying");
    await runner.query(`CREATE TABLE entry_requests (
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      creator_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      body_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      entry_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      PRIMARY KEY (family_id, creator_id, request_id),
      CONSTRAINT fk_request_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
      CONSTRAINT fk_request_user FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if ((await runner.query("SELECT 1 FROM entry_requests LIMIT 1")).length) throw new Error("Refusing to remove non-empty entry_requests");
    await runner.query("DROP TABLE entry_requests");
  }
}
