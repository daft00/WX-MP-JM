import { INestApplication, ValidationPipe } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";

export function setupApp(app: INestApplication): void {
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
