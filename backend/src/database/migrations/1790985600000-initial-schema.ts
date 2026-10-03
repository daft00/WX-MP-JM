import type { MigrationInterface, QueryRunner } from "typeorm";

// 迁移是不可变的历史快照；后续修改表结构请新建迁移。
const id = "char(36) CHARACTER SET ascii COLLATE ascii_bin";
const timestamps = `created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`;

const tables: Record<string, string> = {
  users: `
    id ${id} PRIMARY KEY,
    wechat_app_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    wechat_openid varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nickname varchar(80) NOT NULL,
    avatar_text varchar(16) NOT NULL DEFAULT '',
    system_role enum('USER','SYSTEM_ADMIN') NOT NULL DEFAULT 'USER',
    ${timestamps},
    UNIQUE KEY uq_users_wechat (wechat_app_id, wechat_openid)`,

  families: `
    id ${id} PRIMARY KEY,
    name varchar(80) NOT NULL,
    owner_id ${id} NOT NULL,
    ${timestamps},
    UNIQUE KEY uq_families_owner (id, owner_id),
    CONSTRAINT fk_families_owner FOREIGN KEY (owner_id) REFERENCES users(id)`,

  family_members: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    user_id ${id} NOT NULL,
    role enum('OWNER','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
    joined_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    owner_user_id ${id} GENERATED ALWAYS AS
      (CASE WHEN role = 'OWNER' THEN user_id ELSE NULL END) STORED,
    UNIQUE KEY uq_members_user (family_id, user_id),
    UNIQUE KEY uq_members_owner (family_id, owner_user_id),
    KEY ix_members_user (user_id, family_id),
    CONSTRAINT fk_members_family FOREIGN KEY (family_id) REFERENCES families(id),
    CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_members_owner FOREIGN KEY (family_id, owner_user_id) REFERENCES families(id, owner_id)`,

  children: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    name varchar(80) NOT NULL,
    birthday date NOT NULL,
    gender_label varchar(16) NOT NULL DEFAULT '',
    avatar_color varchar(16) NOT NULL DEFAULT '#F3C7B5',
    ${timestamps},
    UNIQUE KEY uq_children_family (id, family_id),
    KEY ix_children_family (family_id, created_at, id),
    CONSTRAINT fk_children_family FOREIGN KEY (family_id) REFERENCES families(id),
    CONSTRAINT fk_children_creator FOREIGN KEY (creator_id) REFERENCES users(id)`,

  entries: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    child_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    kind enum('DIARY','MILESTONE') NOT NULL,
    title varchar(200) NOT NULL,
    body text NOT NULL,
    custom_event varchar(100) NULL,
    occurred_at datetime(3) NOT NULL,
    ${timestamps},
    UNIQUE KEY uq_entries_scope (id, family_id, child_id),
    KEY ix_entries_wall (family_id, child_id, occurred_at, id),
    CONSTRAINT fk_entries_child FOREIGN KEY (child_id, family_id) REFERENCES children(id, family_id),
    CONSTRAINT fk_entries_creator FOREIGN KEY (creator_id) REFERENCES users(id)`,

  assets: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    child_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    kind enum('IMAGE','VIDEO') NOT NULL,
    status enum('PENDING','READY','FAILED','DELETING') NOT NULL DEFAULT 'PENDING',
    object_key varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    original_name varchar(255) NOT NULL,
    mime_type varchar(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    size_bytes bigint unsigned NOT NULL,
    placeholder_tone varchar(32) NOT NULL DEFAULT '',
    ready_at datetime(3) NULL,
    expires_at datetime(3) NULL,
    ${timestamps},
    UNIQUE KEY uq_assets_object (object_key),
    UNIQUE KEY uq_assets_scope (id, family_id, child_id),
    KEY ix_assets_cleanup (status, expires_at, id),
    CONSTRAINT ck_assets_size CHECK (size_bytes > 0),
    CONSTRAINT ck_assets_ready CHECK (status <> 'READY' OR ready_at IS NOT NULL),
    CONSTRAINT fk_assets_child FOREIGN KEY (child_id, family_id) REFERENCES children(id, family_id),
    CONSTRAINT fk_assets_creator FOREIGN KEY (creator_id) REFERENCES users(id)`,

  entry_assets: `
    entry_id ${id} NOT NULL,
    asset_id ${id} NOT NULL,
    family_id ${id} NOT NULL,
    child_id ${id} NOT NULL,
    position tinyint unsigned NOT NULL,
    PRIMARY KEY (entry_id, asset_id),
    UNIQUE KEY uq_entry_assets_asset (asset_id),
    UNIQUE KEY uq_entry_assets_position (entry_id, position),
    CONSTRAINT ck_entry_assets_position CHECK (position <= 8),
    CONSTRAINT fk_entry_assets_entry FOREIGN KEY (entry_id, family_id, child_id)
      REFERENCES entries(id, family_id, child_id) ON DELETE CASCADE,
    CONSTRAINT fk_entry_assets_asset FOREIGN KEY (asset_id, family_id, child_id)
      REFERENCES assets(id, family_id, child_id)`,

  metrics: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    child_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    entry_id ${id} NOT NULL,
    type enum('HEIGHT','WEIGHT','HEAD') NOT NULL,
    value decimal(10,3) NOT NULL,
    unit enum('cm','kg') NOT NULL,
    measured_at datetime(3) NOT NULL,
    ${timestamps},
    UNIQUE KEY uq_metrics_entry (entry_id),
    KEY ix_metrics_chart (family_id, child_id, type, measured_at, id),
    CONSTRAINT ck_metrics_value CHECK (value > 0),
    CONSTRAINT ck_metrics_unit CHECK
      ((type = 'WEIGHT' AND unit = 'kg') OR (type IN ('HEIGHT','HEAD') AND unit = 'cm')),
    CONSTRAINT fk_metrics_entry FOREIGN KEY (entry_id, family_id, child_id)
      REFERENCES entries(id, family_id, child_id) ON DELETE CASCADE,
    CONSTRAINT fk_metrics_creator FOREIGN KEY (creator_id) REFERENCES users(id)`,

  invites: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    code_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at datetime(3) NOT NULL,
    used_at datetime(3) NULL,
    used_by ${id} NULL,
    UNIQUE KEY uq_invites_hash (code_hash),
    KEY ix_invites_family (family_id, expires_at),
    CONSTRAINT ck_invites_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_invites_use CHECK
      ((used_at IS NULL AND used_by IS NULL) OR (used_at IS NOT NULL AND used_by IS NOT NULL)),
    CONSTRAINT fk_invites_family FOREIGN KEY (family_id) REFERENCES families(id),
    CONSTRAINT fk_invites_creator FOREIGN KEY (creator_id) REFERENCES users(id),
    CONSTRAINT fk_invites_user FOREIGN KEY (used_by) REFERENCES users(id)`,

  export_jobs: `
    id ${id} PRIMARY KEY,
    family_id ${id} NOT NULL,
    child_id ${id} NOT NULL,
    creator_id ${id} NOT NULL,
    year_month char(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status enum('PENDING','PROCESSING','READY','DOWNLOADED','CONFIRMED','FAILED','EXPIRED') NOT NULL DEFAULT 'PENDING',
    part_count int unsigned NOT NULL DEFAULT 0,
    expires_at datetime(3) NULL,
    confirmed_at datetime(3) NULL,
    ${timestamps},
    KEY ix_exports_family (family_id, child_id, created_at, id),
    KEY ix_exports_queue (status, created_at, id),
    CONSTRAINT ck_exports_month CHECK (year_month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT ck_exports_confirmed CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL),
    CONSTRAINT fk_exports_child FOREIGN KEY (child_id, family_id) REFERENCES children(id, family_id),
    CONSTRAINT fk_exports_creator FOREIGN KEY (creator_id) REFERENCES users(id)`,

  audit_logs: `
    id ${id} PRIMARY KEY,
    actor_id ${id} NOT NULL,
    family_id ${id} NULL,
    action varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_type varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target_id ${id} NULL,
    reason varchar(500) NOT NULL,
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_audit_family (family_id, created_at, id),
    KEY ix_audit_actor (actor_id, created_at, id),
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id),
    CONSTRAINT fk_audit_family FOREIGN KEY (family_id) REFERENCES families(id)`,
};

export const INITIAL_TABLE_NAMES = Object.freeze(Object.keys(tables));

export class InitialSchema1790985600000 implements MigrationInterface {
  readonly name = "InitialSchema1790985600000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const versions: { version: string }[] = await queryRunner.query("SELECT VERSION() AS version");
    if (!/^8\.4\./.test(versions[0]?.version ?? "")) {
      throw new Error("Initial schema requires MySQL 8.4 LTS");
    }
    // MySQL DDL 隐式提交。预先拒绝部分执行/同名表，不用 IF NOT EXISTS 掩盖漂移。
    for (const name of INITIAL_TABLE_NAMES) {
      if (await queryRunner.hasTable(name)) {
        throw new Error("Initial schema requires absent business tables; inspect partial migration before retrying");
      }
    }
    for (const [name, definition] of Object.entries(tables)) {
      await queryRunner.query(`CREATE TABLE \`${name}\` (${definition}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚仅允许空业务库，先完整检查再执行任何 DROP；不提供自动清数据开关。
    for (const name of INITIAL_TABLE_NAMES) {
      const rows: unknown[] = await queryRunner.query(`SELECT 1 FROM \`${name}\` LIMIT 1`);
      if (rows.length) throw new Error("Refusing to revert a non-empty schema; use a forward migration or restore a reviewed backup");
    }
    for (const name of [...INITIAL_TABLE_NAMES].reverse()) {
      await queryRunner.query(`DROP TABLE \`${name}\``);
    }
  }
}
