import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Controller, Get, HttpException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { validateEnvironment } from "../src/config";
import { AuthService, hashToken } from "../src/auth/auth.service";
import { AuthSession, User } from "../src/auth/auth.entities";
import { AuthStore } from "../src/auth/auth.store";
import { WechatService } from "../src/auth/wechat.service";
import { setupApp } from "../src/setup-app";

const appId = "wx0123456789abcdef";
const appSecret = "test-only-".replace(/-/g, "") + "a".repeat(24);
const devKey = "a".repeat(64);
const mysqlUrl = "mysql://growth_app:test-only@127.0.0.1/growth_diary";
const status = (expected: number) => (error: unknown) => {
  assert.ok(error instanceof HttpException);
  assert.equal(error.getStatus(), expected);
  return true;
};

test("auth config rejects unsafe production and incomplete credentials", () => {
  const defaults = validateEnvironment({ MYSQL_URL: mysqlUrl });
  assert.equal(defaults.ENABLE_DEV_LOGIN, false);
  assert.equal(defaults.AUTH_SESSION_TTL_SECONDS, 604800);
  for (const invalid of [
    { NODE_ENV: "production" }, { WECHAT_APP_ID: appId }, { WECHAT_APP_SECRET: appSecret },
    { ENABLE_DEV_LOGIN: "true" }, { ENABLE_DEV_LOGIN: "1" },
    { ENABLE_DEV_LOGIN: "true", DEV_LOGIN_KEY: "short" },
    { NODE_ENV: "production", WECHAT_APP_ID: appId, WECHAT_APP_SECRET: appSecret, ENABLE_DEV_LOGIN: "true", DEV_LOGIN_KEY: devKey },
    { AUTH_SESSION_TTL_SECONDS: "0" }, { AUTH_SESSION_TTL_SECONDS: "604801" },
  ]) assert.throws(() => validateEnvironment({ MYSQL_URL: mysqlUrl, ...invalid }));
  assert.equal(validateEnvironment({ MYSQL_URL: mysqlUrl, NODE_ENV: "production", WECHAT_APP_ID: appId, WECHAT_APP_SECRET: appSecret, INVITE_CODE_SECRET: "b".repeat(64) }).ENABLE_DEV_LOGIN, false);
});

test("WeChat exchange validates upstream results and never exposes session_key or upstream errors", async (t) => {
  const service = new WechatService(new ConfigService({ WECHAT_APP_ID: appId, WECHAT_APP_SECRET: appSecret }));
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.weixin.qq.com");
    assert.equal(url.pathname, "/sns/jscode2session");
    assert.equal(url.searchParams.get("appid"), appId);
    assert.equal(url.searchParams.get("secret"), appSecret);
    assert.equal(url.searchParams.get("grant_type"), "authorization_code");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ openid: "server-openid", session_key: "private-session-key", unionid: "private-unionid" }));
  });
  assert.deepEqual(await service.exchange("wx-code"), { appId, openid: "server-openid" });
  for (const [body, expected] of [
    [{ errcode: 40029, errmsg: "secret-input" }, 401], [{ errcode: 40163 }, 401],
    [{ errcode: 40226 }, 403], [{ errcode: 45011 }, 429], [{ errcode: -1 }, 503],
    [{ errcode: 40013 }, 503], [{ openid: "x" }, 503], [null, 503],
  ] as const) {
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(body)));
    await assert.rejects(service.exchange("wx-code"), (error: unknown) => {
      status(expected)(error);
      assert.ok(!JSON.stringify(error).includes("secret-input"));
      return true;
    });
  }
  fetchMock.mock.mockImplementation(async () => { throw new Error("AppSecret in upstream URL must stay private"); });
  await assert.rejects(service.exchange("wx-code"), status(503));
  fetchMock.mock.mockImplementation(async () => new Response("not json"));
  await assert.rejects(service.exchange("wx-code"), status(503));
  fetchMock.mock.mockImplementation(async () => new Response("error", { status: 500 }));
  await assert.rejects(service.exchange("wx-code"), status(503));
});

function memoryStore() {
  const sessions = new Map<string, AuthSession>();
  const users = new Map<string, User>();
  const store = {
    async createSession(application: string, openid: string, method: "WECHAT" | "DEV", tokenHash: string, expiresAt: Date) {
      const identity = application + ":" + openid;
      let user = users.get(identity);
      if (!user) {
        user = Object.assign(new User(), { id: randomUUID(), nickname: "测试用户", avatarText: "我", systemRole: "USER",
          wechatAppId: application, wechatOpenid: openid });
        users.set(identity, user);
      }
      sessions.set(tokenHash, Object.assign(new AuthSession(), { tokenHash, userId: user.id, user, authMethod: method, expiresAt }));
      return { id: user.id, nickname: user.nickname, avatarText: user.avatarText };
    },
    async findSession(hash: string) { return sessions.get(hash) ?? null; },
    async deleteSession(hash: string) { sessions.delete(hash); },
  };
  return { store, sessions, users };
}

@Controller("private-probe")
class PrivateProbeController {
  @Get()
  probe() { return { protected: true }; }
}

test("real HTTP auth boundary: default denial, identity, revocation, dev isolation and throttling", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = mysqlUrl;
  process.env.ENABLE_DEV_LOGIN = "true";
  process.env.DEV_LOGIN_KEY = devKey;
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  const memory = memoryStore();
  let exchanges = 0;
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [PrivateProbeController] })
    .overrideProvider(AuthStore).useValue(memory.store)
    .overrideProvider(WechatService).useValue({ exchange: async () => { exchanges++; return { appId, openid: "fixed-server-user" }; } })
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    await t.test("all new routes are private unless explicitly public", async () => {
      for (const path of ["/auth/me", "/private-probe"]) {
        const response = await fetch(base + path);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("www-authenticate"), "Bearer");
      }
      assert.equal((await fetch(base + "/health/live")).status, 200);
    });
    let token = "", secondToken = "", userId = "";
    await t.test("login accepts only a code, persists only token hash, and returns a public identity", async () => {
      assert.equal((await post("/auth/wechat/login", { code: "abc", openid: "attacker", systemRole: "SYSTEM_ADMIN" })).status, 400);
      assert.equal(exchanges, 0);
      const response = await post("/auth/wechat/login", { code: "wx-code" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const login = await response.json() as { accessToken: string; user: { id: string }; expiresAt: string; tokenType: string };
      token = login.accessToken;
      userId = login.user.id;
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(login.tokenType, "Bearer");
      assert.ok(memory.sessions.has(hashToken(token)) && !memory.sessions.has(token));
      assert.ok(!JSON.stringify(login).includes("openid"));
      assert.ok(!JSON.stringify(login).includes("SYSTEM_ADMIN"));
      const again = await post("/auth/wechat/login", { code: "another-code" });
      const second = await again.json() as typeof login;
      secondToken = second.accessToken;
      assert.equal(second.user.id, userId);
      assert.notEqual(secondToken, token);
    });
    await t.test("bearer validation rejects forged tokens and reads current role instead of trusting claims", async () => {
      const invalid = await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${"z".repeat(43)}` } });
      assert.equal(invalid.status, 401);
      const viaQuery = await fetch(base + `/auth/me?access_token=${token}`);
      assert.equal(viaQuery.status, 401);
      const user = memory.users.get(appId + ":fixed-server-user")!;
      user.systemRole = "SYSTEM_ADMIN";
      let response = await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { user: User }).user.systemRole, "SYSTEM_ADMIN");
      user.systemRole = "USER";
      response = await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal((await response.json() as { user: User }).user.systemRole, undefined);
      assert.equal((await fetch(base + "/private-probe", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    });
    await t.test("logout immediately invalidates only the current token, and expired sessions are denied", async () => {
      assert.equal((await post("/auth/logout", {}, { Authorization: `Bearer ${token}` })).status, 204);
      assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
      assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${secondToken}` } })).status, 200);
      memory.sessions.get(hashToken(secondToken))!.expiresAt = new Date(Date.now() - 1);
      assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${secondToken}` } })).status, 401);
    });
    await t.test("database failure never falls back to an authenticated or development identity", async (sub) => {
      sub.mock.method(memory.store, "findSession", async () => { throw new Error("private-database-password"); });
      const response = await fetch(base + "/private-probe", { headers: { Authorization: `Bearer ${secondToken}` } });
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.ok(!body.includes("private-database-password"));
      assert.ok(!body.includes('"protected":true'));
    });
    await t.test("development identities require a key and cannot authenticate once disabled or in production", async () => {
      assert.equal((await post("/auth/dev/login", { identity: "developer" })).status, 401);
      assert.equal((await post("/auth/dev/login", { identity: "developer" }, { "x-dev-login-key": "b".repeat(64) })).status, 401);
      assert.equal((await post("/auth/dev/login", { identity: "admin" }, { "x-dev-login-key": devKey })).status, 400);
      const response = await post("/auth/dev/login", { identity: "developer" }, { "x-dev-login-key": devKey });
      assert.equal(response.status, 200);
      const login = await response.json() as { accessToken: string; user: User };
      assert.equal(login.user.systemRole, undefined);
      const config = module.get(ConfigService);
      config.set("ENABLE_DEV_LOGIN", false);
      assert.equal((await post("/auth/dev/login", { identity: "developer" }, { "x-dev-login-key": devKey })).status, 404);
      assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${login.accessToken}` } })).status, 401);
      config.set("ENABLE_DEV_LOGIN", true);
      config.set("NODE_ENV", "production");
      assert.equal((await post("/auth/dev/login", { identity: "developer" }, { "x-dev-login-key": devKey })).status, 404);
      assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${login.accessToken}` } })).status, 401);
    });
    await t.test("repeated login attempts receive 429 without trusting forwarded IP headers", async () => {
      let limited = false;
      for (let i = 0; i < 11; i++) {
        const response = await post("/auth/wechat/login", { code: "code" }, { "X-Forwarded-For": `10.0.0.${i}` });
        if (response.status === 429) { limited = true; break; }
      }
      assert.ok(limited);
    });
  } finally {
    await app.close();
  }
});
