import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { MediaService } from "./media.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try { await app.get(MediaService).tick(); }
  finally { await app.close(); }
}
main().catch(() => { process.stderr.write("Media worker failed; check database and storage configuration.\n"); process.exitCode = 1; });
