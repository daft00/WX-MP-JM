import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { Body, Controller, ForbiddenException, Get, Logger, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { IsInt, IsString, Min, MinLength } from "class-validator";
import { databaseOptions, validateEnvironment } from "../src/config";
import { DatabaseHealthService } from "../src/database-health.service";
import { setupApp } from "../src/setup-app";
import { Public } from "../src/auth/auth.guard";

const testUrl = "mysql://growth_app:test-only@127.0.0.1:3306/growth_diary";

test("environment validation supplies defaults and rejects invalid values without leaking secrets", () => {
  const config = validateEnvironment({ MYSQL_URL: testUrl });
  assert.equal(config.PORT, 3000);
  assert.equal(config.HOST, "127.0.0.1");
  assert.equal(config.NODE_ENV, "development");
  for (const invalid of [
    { MYSQL_URL: undefined }, { MYSQL_URL: "postgres://user:secret@host/db" },
    { MYSQL_URL: "mysql://user:secret@host" }, { MYSQL_URL: "mysql://user@host/db" },
    { MYSQL_URL: `${testUrl}?multipleStatements=true` },
    { PORT: "0" }, { PORT: "65536" }, { PORT: "3.1" }, { PORT: "" },
    { HOST: "" }, { NODE_ENV: "prod" },
  ]) {
    assert.throws(() => validateEnvironment({ MYSQL_URL: testUrl, ...invalid }));
  }
  assert.throws(() => databaseOptions("secret-connection-value"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("secret-connection-value"));
    return true;
  });
  const options = databaseOptions("mysql://growth_app:a%40b%3Ac@localhost:3307/growth_diary");
  assert.equal(options.password, "a@b:c");
  assert.equal(options.port, 3307);
  assert.equal(options.multipleStatements, false);
});

test("invalid configuration exits before listening and does not print the connection string", () => {
  const result = spawnSync(process.execPath, [join(__dirname, "../src/main.js")], {
    env: { ...process.env, NODE_ENV: "test", MYSQL_URL: "never-print-this-secret" },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /MYSQL_URL/);
  assert.ok(!(result.stdout + result.stderr).includes("never-print-this-secret"));
});

class ProbeDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsInt()
  @Min(1)
  count!: number;
}

// 此控制器只存在于测试模块，不向实际应用增加业务接口。
@Controller("probe")
@Public()
class ProbeController {
  @Post()
  create(@Body() dto: ProbeDto) { return { ...dto, transformed: dto instanceof ProbeDto }; }

  @Get("error")
  fail() { throw new Error("database-password-must-stay-private"); }

  @Get("forbidden")
  forbidden() { throw new ForbiddenException("Access denied"); }
}

test("HTTP foundation: liveness, readiness, validation and uniform errors", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.MYSQL_URL = testUrl;
  Logger.overrideLogger(false);
  const { AppModule } = await import("../src/app.module");
  let databaseDown = false;
  const module = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] })
    .overrideProvider(DatabaseHealthService)
    .useValue({ check: async () => {
      if (databaseDown) throw new Error("private-database-connection");
    } })
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupApp(app);
  try {
    await app.listen(0, "127.0.0.1");
    const base = `${await app.getUrl()}/api/v1`;
    await t.test("live and ready return 200, database failure only affects ready", async () => {
      const ready = await fetch(`${base}/health/ready`);
      assert.equal(ready.status, 200);
      assert.equal(ready.headers.get("cache-control"), "no-store");
      assert.deepEqual(await ready.json(), { status: "ok", database: "up" });
      databaseDown = true;
      const down = await fetch(`${base}/health/ready`);
      assert.equal(down.status, 503);
      const body = await down.json() as Record<string, unknown>;
      assert.equal(body.code, "SERVICE_UNAVAILABLE");
      assert.equal(body.message, "Service unavailable");
      assert.ok(!JSON.stringify(body).includes("private-database-connection"));
      const live = await fetch(`${base}/health/live`);
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: "ok" });
    });
    await t.test("DTO validation transforms valid input and rejects wrong types and extra fields", async () => {
      const post = (body: unknown) => fetch(`${base}/probe`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const valid = await post({ name: "宝宝", count: 1 });
      assert.equal(valid.status, 201);
      assert.deepEqual(await valid.json(), { name: "宝宝", count: 1, transformed: true });
      for (const input of [{ name: "a", count: 0 }, { name: "宝宝", count: "1" },
        { name: "宝宝", count: 1, role: "ADMIN" }, {}]) {
        const response = await post(input);
        assert.equal(response.status, 400);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.code, "BAD_REQUEST");
        assert.ok(Array.isArray(body.message));
      }
    });
    await t.test("malformed JSON, forbidden, missing routes and unknown errors share the error envelope", async () => {
      for (const [path, status] of [["/missing", 404], ["/probe/forbidden", 403], ["/probe/error?token=secret", 500]] as const) {
        const response = await fetch(base + path);
        assert.equal(response.status, status);
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.statusCode, status);
        assert.equal(body.path, `/api/v1${path.split("?")[0]}`);
        assert.ok(!Number.isNaN(Date.parse(String(body.timestamp))));
        assert.ok(!JSON.stringify(body).includes("secret"));
        assert.ok(!JSON.stringify(body).includes("database-password"));
        if (status === 500) assert.equal(body.message, "Internal server error");
      }
      const malformed = await fetch(`${base}/probe`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json() as { code: string }).code, "BAD_REQUEST");
    });
  } finally {
    await app.close();
  }
});

test("incomplete database handshake times out and releases its socket", { timeout: 10000 }, async () => {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.resume();
    // 对端仅发送不完整握手，模拟 TCP 已连通但数据库未就绪。
    socket.write(Buffer.from([1]));
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const service = new DatabaseHealthService(new ConfigService({
      MYSQL_URL: `mysql://test:test@127.0.0.1:${address.port}/test`,
    }));
    const started = Date.now();
    await assert.rejects(() => service.check());
    assert.ok(Date.now() - started < 5000);
    // 等待对端收到 FIN，确认检查失败后没有遗留连接。
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sockets.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real MySQL SELECT 1 (opt-in)", { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const service = new DatabaseHealthService(new ConfigService({ MYSQL_URL: process.env.TEST_MYSQL_URL }));
  await service.check();
});
