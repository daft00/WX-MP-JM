import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { DatabaseModule } from "../database/database.module";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { AuthStore } from "./auth.store";
import { WechatService } from "./wechat.service";

@Module({
  imports: [DatabaseModule, ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])],
  controllers: [AuthController],
  providers: [AuthStore, WechatService, AuthService, ThrottlerGuard,
    { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
