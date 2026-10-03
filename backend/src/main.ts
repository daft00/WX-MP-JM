import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { setupApp } from "./setup-app";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>("PORT"), config.getOrThrow<string>("HOST"));
}

void bootstrap().catch(() => {
  Logger.error("Backend startup failed", "Bootstrap");
  process.exitCode = 1;
});
