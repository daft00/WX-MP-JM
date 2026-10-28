import type { MigrationInterface, QueryRunner } from "typeorm";

export class FamilyCreation1790985602000 implements MigrationInterface {
  readonly name = "FamilyCreation1790985602000";
  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable("family_creation_permissions")) throw new Error("family_creation_permissions already exists; inspect before retrying");
    await runner.query(`CREATE TABLE family_creation_permissions (
      user_id char(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      granted_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      used_at datetime(3) NULL,
      CONSTRAINT fk_creation_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if ((await runner.query("SELECT 1 FROM family_creation_permissions LIMIT 1")).length) {
      throw new Error("Refusing to remove non-empty family_creation_permissions");
    }
    await runner.query("DROP TABLE family_creation_permissions");
  }
}
