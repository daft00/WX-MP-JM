import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class WechatService {
  constructor(private readonly config: ConfigService) {}

  async exchange(code: string): Promise<{ appId: string; openid: string }> {
    const appId = this.config.get<string>("WECHAT_APP_ID");
    const secret = this.config.get<string>("WECHAT_APP_SECRET");
    if (!appId || !secret) throw new ServiceUnavailableException();
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: "authorization_code" }).toString();
    let body: unknown;
    try {
      // 不跟随重定向，不记录含 AppSecret/code 的 URL；一次性 code 不自动重试。
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error();
      body = await response.json();
    } catch {
      throw new ServiceUnavailableException();
    }
    if (!body || typeof body !== "object") throw new ServiceUnavailableException();
    const result = body as Record<string, unknown>;
    if (result.errcode === 40029 || result.errcode === 40163) {
      throw new UnauthorizedException("Invalid or expired WeChat login code");
    }
    if (result.errcode === 45011) throw new HttpException("WeChat login rate limit exceeded", 429);
    if (result.errcode === 40226) throw new ForbiddenException("WeChat login blocked");
    if ((result.errcode !== undefined && result.errcode !== 0) ||
        typeof result.openid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.openid) ||
        typeof result.session_key !== "string" || !result.session_key) {
      throw new ServiceUnavailableException();
    }
    // 本模块只需要 OpenID；session_key 不存储、不返回，不作为自有登录令牌。
    return { appId, openid: result.openid };
  }
}
