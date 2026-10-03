import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthService } from "./auth.service";

const PUBLIC = Symbol("public-route");
export const Public = () => SetMetadata(PUBLIC, true);
export type AuthenticatedRequest = Request & { auth: Awaited<ReturnType<AuthService["authenticate"]>> };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.auth = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
