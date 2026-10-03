import { Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { User, AuthSession } from "../auth/auth.entities";
import { databaseOptions } from "../config";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly source: DataSource;
  private connecting?: Promise<DataSource>;

  constructor(config: ConfigService) {
    const options = databaseOptions(config.getOrThrow<string>("MYSQL_URL"));
    this.source = new DataSource({
      type: "mysql", connectorPackage: "mysql2",
      host: options.host, port: options.port, username: options.user,
      password: options.password, database: options.database,
      charset: "utf8mb4_0900_ai_ci", timezone: "Z", dateStrings: ["DATE"],
      supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 3000,
      extra: { connectionLimit: 5, waitForConnections: true, queueLimit: 20, multipleStatements: false },
      entities: [User, AuthSession], synchronize: false, migrationsRun: false, logging: false,
    });
  }

  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    // 延迟连接保留模块 1 的行为：数据库不可用时进程仍能启动并提供存活检查。
    if (!this.source.isInitialized) {
      this.connecting ??= this.source.initialize().catch(() => {
        this.connecting = undefined;
        throw new ServiceUnavailableException();
      });
      await this.connecting;
    }
    return this.source.transaction(async (manager) => {
      await manager.query("SET SESSION time_zone = '+00:00'");
      return work(manager);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    if (this.source.isInitialized) await this.source.destroy();
  }
}
