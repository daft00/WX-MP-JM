import { DataDeletion1790985607000 } from "./migrations/1790985607000-data-deletion";
import { Governance1790985606000 } from "./migrations/1790985606000-governance";
import { Exports1790985605000 } from "./migrations/1790985605000-exports";
import { Media1790985604000 } from "./migrations/1790985604000-media";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { databaseOptions } from "../config";
import { InitialSchema1790985600000 } from "./migrations/1790985600000-initial-schema";
import { AuthSessions1790985601000 } from "./migrations/1790985601000-auth-sessions";
import { FamilyCreation1790985602000 } from "./migrations/1790985602000-family-creation";
import { EntryRequests1790985603000 } from "./migrations/1790985603000-entry-requests";

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
    migrations: [InitialSchema1790985600000, AuthSessions1790985601000, FamilyCreation1790985602000, EntryRequests1790985603000, Media1790985604000, Exports1790985605000, Governance1790985606000, DataDeletion1790985607000],
    logging: false,
  });
}
