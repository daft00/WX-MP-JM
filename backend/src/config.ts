import { isIP } from "node:net";
import type { ConnectionOptions } from "mysql2";

export function databaseOptions(value: unknown, variableName = "MYSQL_URL"): ConnectionOptions {
  try {
    if (typeof value !== "string" || !value.trim()) throw new Error();
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      url.protocol !== "mysql:" || !url.hostname || !url.username ||
      !url.password || !database || database.includes("/") ||
      url.search || url.hash || (url.port && Number(url.port) < 1)
    ) throw new Error();

    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      charset: "utf8mb4",
      timezone: "Z",
      connectTimeout: 2000,
      multipleStatements: false,
    };
  } catch {
    // URL 解析异常会携带原始输入，不能把包含密码的 URL 写入启动日志。
    throw new Error(`${variableName} must be a mysql://user:password@host:port/database URL without query or fragment`);
  }
}

export function validateEnvironment(env: Record<string, unknown>) {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(String(nodeEnv))) {
    throw new Error("NODE_ENV must be development, test or production");
  }
  const host = env.HOST ?? "127.0.0.1";
  if (typeof host !== "string" || !isIP(host)) {
    throw new Error("HOST must be an IPv4 or IPv6 address");
  }
  const port = String(env.PORT ?? "3000");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  databaseOptions(env.MYSQL_URL);
  const appId = env.WECHAT_APP_ID ?? "";
  const appSecret = env.WECHAT_APP_SECRET ?? "";
  if (typeof appId !== "string" || typeof appSecret !== "string" ||
      (appId !== "" && !/^wx[0-9a-fA-F]{16}$/.test(appId)) ||
      (appSecret !== "" && !/^[A-Za-z0-9]{16,256}$/.test(appSecret)) ||
      Boolean(appId) !== Boolean(appSecret) || (nodeEnv === "production" && !appId)) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together; required in production");
  }
  const devLogin = env.ENABLE_DEV_LOGIN ?? "false";
  if (!["true", "false"].includes(String(devLogin))) throw new Error("ENABLE_DEV_LOGIN must be true or false");
  const devKey = env.DEV_LOGIN_KEY ?? "";
  if (String(devLogin) === "true" &&
      (nodeEnv === "production" || typeof devKey !== "string" || !/^[a-f0-9]{64}$/i.test(devKey))) {
    throw new Error("Development login requires a 64-character hex DEV_LOGIN_KEY and is forbidden in production");
  }
  const ttl = String(env.AUTH_SESSION_TTL_SECONDS ?? "604800");
  if (!/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 604800) {
    throw new Error("AUTH_SESSION_TTL_SECONDS must be an integer between 60 and 604800");
  }
  const inviteSecret = env.INVITE_CODE_SECRET ?? "";
  if (typeof inviteSecret !== "string" || (inviteSecret !== "" && !/^[a-f0-9]{64}$/i.test(inviteSecret)) ||
      (nodeEnv === "production" && !inviteSecret)) {
    throw new Error("INVITE_CODE_SECRET must be 64 hex characters and is required in production");
  }
  return {
    ...env, NODE_ENV: nodeEnv, HOST: host, PORT: Number(port),
    WECHAT_APP_ID: appId, WECHAT_APP_SECRET: appSecret,
    ENABLE_DEV_LOGIN: String(devLogin) === "true", DEV_LOGIN_KEY: devKey,
    AUTH_SESSION_TTL_SECONDS: Number(ttl),
    INVITE_CODE_SECRET: inviteSecret,
  };
}
