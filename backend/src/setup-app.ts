import { INestApplication, ValidationPipe } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";

export function setupApp(app: INestApplication): void {
  // 只信任直连的本机代理；Nginx 必须覆盖转发头，不能透传客户端提供的值。
  app.getHttpAdapter().getInstance().set("trust proxy", (address: string, hop: number) =>
    hop === 0 && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address));
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();
}
