import "reflect-metadata";
import { DataSource } from "typeorm";
import { databaseOptions } from "../config";
import { InitialSchema1790985600000 } from "./migrations/1790985600000-initial-schema";
import { AuthSessions1790985601000 } from "./migrations/1790985601000-auth-sessions";

export function createMigrationDataSource(url: unknown): DataSource {
  const options = databaseOptions(url, "MIGRATION_DATABASE_URL");
  return new DataSource({
    type: "mysql",
    connectorPackage: "mysql2",
    host: options.host,
    port: options.port,
    username: options.user,
    password: options.password,
    database: options.database,
    charset: "utf8mb4_0900_ai_ci",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ["DATE"],
    connectTimeout: 5000,
    extra: { connectionLimit: 2, multipleStatements: false },
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: "none",
    migrationsTableName: "schema_migrations",
    migrations: [InitialSchema1790985600000, AuthSessions1790985601000],
    logging: false,
  });
}
