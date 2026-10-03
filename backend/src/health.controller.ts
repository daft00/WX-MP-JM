import { Controller, Get, Header, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseHealthService } from "./database-health.service";
import { Public } from "./auth/auth.guard";

@Controller("health")
@Public()
export class HealthController {
  constructor(private readonly database: DatabaseHealthService) {}

  @Get("live")
  @Header("Cache-Control", "no-store")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @Header("Cache-Control", "no-store")
  async ready() {
    try {
      await this.database.check();
      return { status: "ok", database: "up" };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
