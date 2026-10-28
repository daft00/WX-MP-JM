import { PassThrough } from "node:stream";
import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import COS from "cos-nodejs-sdk-v5";
import { sts } from "tencentcloud-sdk-nodejs-sts";
import { ConfigService } from "@nestjs/config";
import { CosStorage, InvalidMedia } from "../src/media/cos-storage";

test("COS SDK and CI use real HTTP: freeze, size checks, preview persistence, invalid format and upstream error", { skip: !process.env.COS_SIM_URL }, async () => {
  const base = process.env.COS_SIM_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/cos$/);
  const config = new ConfigService({ MEDIA_ENABLED: true, COS_BUCKET: "test-1250000000", COS_REGION: "ap-guangzhou", COS_SECRET_ID: "fake", COS_SECRET_KEY: "fake" });
  const storage = new CosStorage(config);
  // 仅测试注入本地端点；生产配置不允许任意主机接收签名。
  (storage as unknown as { client: COS }).client = new COS({ SecretId: "fake", SecretKey: "fake", Domain: base, Protocol: "http:", Timeout: 2000 });
  (storage as unknown as { tokenClient: InstanceType<typeof sts.v20180813.Client> }).tokenClient = new sts.v20180813.Client({
    credential: { secretId: "fake", secretKey: "fake" }, region: "ap-guangzhou",
    profile: { httpProfile: { protocol: "http://", endpoint: `${new URL(base).host}/cos/sts`, reqTimeout: 2 } },
  });
  const ticket = await storage.upload("tmp/test", 16, new Date(Date.now() + 3600000));
  assert.equal(ticket.formData["x-cos-security-token"], "session");
  assert.ok(!JSON.stringify(ticket).includes("secret-for-test"));
  storage.url = (key, query = {}) => `${base}/${key}?${new URLSearchParams(query)}`;
  assert.equal((await storage.head("tmp/test"))?.size, 16);
  await assert.rejects(storage.freeze("tmp/test", "bad-size", 17), InvalidMedia);
  await storage.freeze("tmp/test", "frozen", 16);
  assert.equal((await storage.head("frozen"))?.size, 16);
  assert.equal(await storage.inspect("frozen", "IMAGE"), "image/jpeg");
  assert.equal(await storage.preview("frozen", "IMAGE", "preview.jpg"), 4);
  assert.equal((await storage.head("preview.jpg"))?.size, 4);
  assert.equal(await storage.inspect("video", "VIDEO"), "video/mp4");
  await assert.rejects(storage.inspect("invalid", "IMAGE"), InvalidMedia);
  await assert.rejects(storage.inspect("upstream-error", "IMAGE"), /processing failed/);
  const chunks: Buffer[] = [];
  for await (const bytes of storage.stream("frozen", 16)) chunks.push(Buffer.from(bytes));
  assert.equal(Buffer.concat(chunks).toString(), "fake image bytes");
  await assert.rejects(async () => { for await (const bytes of storage.stream("frozen", 15)) void bytes; });
  (storage as unknown as { exportClient: COS }).exportClient = (storage as unknown as { client: COS }).client;
  const stream = new PassThrough();
  const uploaded = storage.putStream("exports/test/1.zip", stream, 16);
  stream.end(Buffer.concat(chunks));
  await uploaded;
  assert.equal((await storage.head("exports/test/1.zip"))?.size, 16);
  await storage.remove("exports/test/1.zip");
  await storage.remove("preview.jpg");
  assert.equal(await storage.head("preview.jpg"), undefined);
});
