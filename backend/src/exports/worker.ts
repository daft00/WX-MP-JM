import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { ExportsService } from "./exports.service";
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try { await app.get(ExportsService).tick(); } finally { await app.close(); }
}
main().catch(() => { console.error("Export worker failed; inspect database and storage availability"); process.exitCode = 1; });
