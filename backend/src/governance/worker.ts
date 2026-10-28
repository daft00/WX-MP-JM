import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { DeletionService } from "./deletion.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try { await app.get(DeletionService).tick(); } finally { await app.close(); }
}
main().catch(() => { console.error("Deletion worker failed; inspect database and storage availability"); process.exitCode = 1; });
