import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { AuthenticatedRequest } from "../auth/auth.guard";
import { GovernanceService } from "./governance.service";

@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(private readonly governance: GovernanceService) {}
  async canActivate(context: ExecutionContext) {
    const r = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Users must still be able to read policy, log out or ask for deletion without accepting new terms.
    if (!r.auth || /^\/api\/v1\/governance(?:\/|$)/.test(r.path) || r.path === "/api/v1/auth/logout" || (r.method === "GET" && r.path === "/api/v1/auth/me")) return true;
    await this.governance.requireConsent(r.auth.user.id); return true;
  }
}
