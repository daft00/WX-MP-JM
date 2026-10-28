import { MigrationInterface, QueryRunner } from "typeorm";

export class Governance1790985606000 implements MigrationInterface {
  readonly name = "Governance1790985606000";
  async up(r: QueryRunner) {
    for (const table of ["policy_consents", "data_requests"]) if (await r.hasTable(table)) throw new Error("Governance tables exist; inspect partial migration");
    await r.query(`CREATE TABLE policy_consents (
      user_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      version char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      accepted_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (user_id, version),
      CONSTRAINT fk_consent_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await r.query(`CREATE TABLE data_requests (
      id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      user_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      request_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      kind enum('ACCOUNT_CLOSE','DATA_DELETE','FAMILY_DISSOLVE') NOT NULL,
      reason varchar(500) NOT NULL,
      status enum('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      review_reason varchar(500) NULL,
      reviewer_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_data_request (user_id, request_id),
      KEY ix_data_requests (status, created_at, id),
      CONSTRAINT fk_data_request_user FOREIGN KEY (user_id) REFERENCES users(id),
      CONSTRAINT fk_data_request_family FOREIGN KEY (family_id) REFERENCES families(id),
      CONSTRAINT fk_request_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(r: QueryRunner) {
    for (const table of ["policy_consents", "data_requests"]) if ((await r.query(`SELECT 1 FROM ${table} LIMIT 1`)).length) throw new Error("Refusing non-empty governance tables");
    await r.query("DROP TABLE data_requests"); await r.query("DROP TABLE policy_consents");
  }
}
