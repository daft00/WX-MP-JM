import { Body, Controller, Get, Header, Headers, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { IsIn, IsString, Matches, MaxLength } from "class-validator";
import { AuthService } from "./auth.service";
import { AuthenticatedRequest, Public } from "./auth.guard";

class WechatLoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]+$/)
  @MaxLength(256)
  code!: string;
}

class DevLoginDto {
  @IsIn(["developer", "member", "outsider"])
  identity!: "developer" | "member" | "outsider";
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("wechat/login")
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  wechat(@Body() body: WechatLoginDto) { return this.auth.loginWechat(body.code); }

  @Post("dev/login")
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  dev(@Body() body: DevLoginDto, @Headers("x-dev-login-key") key: string | undefined) {
    return this.auth.loginDev(body.identity, key);
  }

  @Get("me")
  @Header("Cache-Control", "no-store")
  me(@Req() request: AuthenticatedRequest) { return { user: request.auth.user }; }

  @Post("logout")
  @HttpCode(204)
  @Header("Cache-Control", "no-store")
  logout(@Req() request: AuthenticatedRequest) { return this.auth.logout(request.auth.tokenHash); }
}
