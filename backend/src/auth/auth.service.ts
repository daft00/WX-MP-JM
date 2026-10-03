import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AuthStore } from "./auth.store";
import { publicUser } from "./auth.entities";
import { WechatService } from "./wechat.service";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService, private readonly store: AuthStore, private readonly wechat: WechatService) {}

  private devEnabled(): boolean {
    return this.config.get<boolean>("ENABLE_DEV_LOGIN") === true && this.config.get<string>("NODE_ENV") !== "production";
  }

  async loginWechat(code: string) {
    const identity = await this.wechat.exchange(code);
    return this.issue(identity.appId, identity.openid, "WECHAT");
  }

  async loginDev(identity: "developer" | "member" | "outsider", key: string | undefined) {
    if (!this.devEnabled()) throw new NotFoundException();
    const expected = this.config.get<string>("DEV_LOGIN_KEY");
    if (!expected || !key || !/^[a-f0-9]{64}$/i.test(key) ||
        !timingSafeEqual(Buffer.from(hashToken(expected), "hex"), Buffer.from(hashToken(key), "hex"))) {
      throw new UnauthorizedException("Invalid development login key");
    }
    return this.issue("dev-local", identity, "DEV");
  }

  private async issue(appId: string, openid: string, method: "WECHAT" | "DEV") {
    const ttl = this.config.getOrThrow<number>("AUTH_SESSION_TTL_SECONDS");
    const expiresAt = new Date(Date.now() + Math.min(ttl, method === "DEV" ? 3600 : ttl) * 1000);
    const token = randomBytes(32).toString("base64url");
    const user = await this.store.createSession(appId, openid, method, hashToken(token), expiresAt);
    return { accessToken: token, tokenType: "Bearer" as const, expiresAt: expiresAt.toISOString(), user };
  }

  async authenticate(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
    if (!token) throw new UnauthorizedException("Authentication required");
    const tokenHash = hashToken(token);
    const session = await this.store.findSession(tokenHash);
    if (!session || session.expiresAt.getTime() <= Date.now() ||
        (session.authMethod === "DEV" && !this.devEnabled())) {
      throw new UnauthorizedException("Session expired or invalid");
    }
    return { user: publicUser(session.user), tokenHash };
  }

  logout(tokenHash: string): Promise<void> {
    return this.store.deleteSession(tokenHash);
  }
}
