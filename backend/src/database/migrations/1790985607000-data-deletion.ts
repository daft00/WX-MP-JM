import { MigrationInterface, QueryRunner } from "typeorm";

export class DataDeletion1790985607000 implements MigrationInterface {
  readonly name = "DataDeletion1790985607000";
  async up(r: QueryRunner) {
    if (await r.hasColumn("families", "deleting_at") || await r.hasColumn("data_requests", "entry_id")) throw new Error("Partial deletion migration; inspect schema before retrying");
    await r.query("ALTER TABLE families ADD deleting_at datetime(3) NULL");
    await r.query(`ALTER TABLE data_requests
      MODIFY status enum('PENDING','APPROVED','REJECTED','CANCELLED','PROCESSING','COMPLETED') NOT NULL DEFAULT 'PENDING',
      ADD target_family_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD entry_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD child_id char(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD asset_ids json NULL,
      ADD started_at datetime(3) NULL,
      ADD completed_at datetime(3) NULL,
      ADD last_error varchar(64) NULL,
      DROP FOREIGN KEY fk_data_request_family,
      ADD CONSTRAINT fk_data_request_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL`);
    await r.query("UPDATE data_requests SET target_family_id = family_id");
    // Legacy unscoped requests cannot authorize a newly implemented destructive operation.
    await r.query("UPDATE data_requests SET status = 'CANCELLED', last_error = 'RESUBMIT_WITH_EXPLICIT_TARGET' WHERE status IN ('PENDING','APPROVED')");
    await r.query("ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_family, ADD CONSTRAINT fk_audit_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL");
  }
  async down(r: QueryRunner) {
    if ((await r.query("SELECT 1 FROM data_requests LIMIT 1")).length || (await r.query("SELECT 1 FROM families WHERE deleting_at IS NOT NULL LIMIT 1")).length) throw new Error("Refusing rollback with deletion history");
    await r.query("ALTER TABLE audit_logs DROP FOREIGN KEY fk_audit_family, ADD CONSTRAINT fk_audit_family FOREIGN KEY (family_id) REFERENCES families(id)");
    await r.query(`ALTER TABLE data_requests
      DROP FOREIGN KEY fk_data_request_family,
      ADD CONSTRAINT fk_data_request_family FOREIGN KEY (family_id) REFERENCES families(id),
      DROP target_family_id, DROP entry_id, DROP child_id, DROP asset_ids, DROP started_at, DROP completed_at, DROP last_error,
      MODIFY status enum('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING'`);
    await r.query("ALTER TABLE families DROP deleting_at");
  }
}
