import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createConnection as connectTcp } from "node:net";
import { createConnection } from "mysql2";
import { databaseOptions } from "./config";

@Injectable()
export class DatabaseHealthService {
  constructor(private readonly config: ConfigService) {}

  async check(): Promise<void> {
    const options = databaseOptions(this.config.getOrThrow<string>("MYSQL_URL"));
    const socket = connectTcp({ host: options.host, port: options.port! });
    const connection = createConnection({ ...options, stream: socket });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        // 总超时覆盖 TCP、握手和 SELECT；超时后销毁连接，不留下后台查询。
        timeout = setTimeout(() => reject(new Error("Database health check timed out")), 3000);
        connection.once("error", reject);
        connection.query("SELECT 1", (error) => error ? reject(error) : resolve());
      });
    } finally {
      clearTimeout(timeout);
      connection.destroy();
      // mysql2 的 destroy 实际调用 stream.end；对端不关闭时还需主动销毁 TCP。
      socket.destroy();
    }
  }
}
