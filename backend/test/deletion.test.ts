import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { CosStorage } from "../src/media/cos-storage";
import { DeletionService } from "../src/governance/deletion.service";
import { DataDeletion1790985607000 } from "../src/database/migrations/1790985607000-data-deletion";
import { GovernanceService } from "../src/governance/governance.service";
import COS from "cos-nodejs-sdk-v5";

function fixture(dissolve = false, storage?: CosStorage) {
  let state = { status: "PROCESSING", error: null as unknown, occupied: 100, family: true,
    assets: [{ id: "a", object_key: "media/f/a", expires_at: new Date(0) }], exports: [{ id: "zip", parts: [{ number: 1 }], cleaned: 0 }] };
  let fail = false, locked = true, enabled = true;
  const removed: string[] = [], writes: string[] = [];
  const m = { query: async (sql: string, p: unknown[] = []): Promise<any> => {
    if (sql.includes("GET_LOCK")) return [{ acquired: locked ? "1" : "0" }];
    if (sql.includes("RELEASE_LOCK")) return [];
    if (sql.startsWith("SELECT id, family_id FROM data_requests")) return state.status === "PROCESSING" ? [{ id: "job", family_id: "f" }] : [];
    if (sql.startsWith("SELECT * FROM data_requests")) return [{ id: "job", family_id: "f", child_id: "c", asset_ids: ["a"], kind: dissolve ? "FAMILY_DISSOLVE" : "DATA_DELETE", user_id: "u", status: state.status }];
    if (sql.startsWith("SELECT id, parts")) return state.exports;
    if (sql.startsWith("SELECT id FROM export_tasks")) return state.exports;
    if (sql.startsWith("SELECT a.id")) return state.assets;
    if (sql.startsWith("SELECT COALESCE")) return [{ occupied: state.occupied }];
    writes.push(sql);
    if (sql.startsWith("DELETE FROM export_tasks")) state.exports = [];
    else if (sql.startsWith("DELETE FROM assets")) { assert.deepEqual(p, ["f", "a"]); state.assets = []; }
    else if (sql.startsWith("UPDATE media_uploads")) state.occupied = 0;
    else if (sql.includes("SET status = 'COMPLETED'")) state.status = "COMPLETED";
    else if (sql.includes("last_error = ?")) state.error = p[0];
    else if (sql.includes("last_error = 'CLEANING_EXPORTS'")) state.error = "CLEANING_EXPORTS";
    else if (sql.startsWith("DELETE FROM families")) { assert.equal(state.occupied, 0); assert.equal(state.assets.length, 0); state.family = false; }
    else if (/^DELETE FROM (export_jobs|media_uploads|family_storage|children|family_members)/.test(sql)) assert.deepEqual(p, ["f"]);
    else throw new Error("Unexpected SQL " + sql);
    return [];
  } };
  const db = { transaction: async (fn: (manager: typeof m) => unknown) => {
    const before = structuredClone(state);
    try { return await fn(m); } catch (e) { state = before; throw e; }
  } } as unknown as DatabaseService;
  const families = { lockFamily: async () => ({ id: "f" }), audit: async () => undefined } as unknown as FamiliesService;
  const cos = { get enabled() { return enabled; }, remove: async (key: string) => { if (fail) throw new Error("secret provider error"); removed.push(key); } } as unknown as CosStorage;
  return { service: new DeletionService(db, families, storage || cos), removed, writes, get state() { return state; },
    fail: (value: boolean) => { fail = value; }, unlock: () => { locked = false; }, disable: () => { enabled = false; } };
}

test("deletion worker survives real COS HTTP failure and retries already removed objects", { skip: !process.env.COS_SIM_URL }, async () => {
  const base = process.env.COS_SIM_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/cos$/);
  const config = new ConfigService({ MEDIA_ENABLED: true, COS_BUCKET: "test-1250000000", COS_REGION: "ap-guangzhou", COS_SECRET_ID: "fake", COS_SECRET_KEY: "fake" });
  const storage = new CosStorage(config);
  const client = new COS({ SecretId: "fake", SecretKey: "fake", Domain: base, Protocol: "http:", Timeout: 2000 });
  (storage as unknown as { client: COS }).client = client;
  const keys = ["exports/f/zip/1.zip", "tmp/f/a", "media/f/a.jpg", "media/f/a"];
  for (const key of keys) await client.putObject({ Bucket: "test-1250000000", Region: "ap-guangzhou", Key: key, Body: Buffer.from("synthetic data") });
  const control = (enabled: boolean) => fetch(base + "/_test/delete-failure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
  const f = fixture(false, storage);
  try {
    assert.equal((await control(true)).status, 204);
    await f.service.tick();
    assert.equal(f.state.status, "PROCESSING"); assert.equal(f.state.occupied, 100);
    assert.equal(f.state.error, "CLEANUP_RETRY");
    assert.ok(await storage.head("media/f/a"));
    await control(false); await f.service.tick();
    assert.equal(f.state.status, "COMPLETED"); assert.equal(f.state.occupied, 0);
    for (const key of keys) assert.equal(await storage.head(key), undefined);
  } finally { await control(false); for (const key of keys) await storage.remove(key); }
});

test("COS failure never completes deletion or frees quota; retry cleans export, originals, previews and temp", async () => {
  const f = fixture(); f.fail(true); await f.service.tick();
  assert.equal(f.state.status, "PROCESSING"); assert.equal(f.state.occupied, 100); assert.equal(f.state.error, "CLEANUP_RETRY");
  f.fail(false); await f.service.tick();
  assert.equal(f.state.status, "COMPLETED"); assert.equal(f.state.occupied, 0); assert.equal(f.state.family, true);
  assert.deepEqual(f.removed, ["exports/f/zip/1.zip", "tmp/f/a", "media/f/a.jpg", "media/f/a"]);
  const count = f.removed.length; await f.service.tick(); assert.equal(f.removed.length, count);
});

test("outstanding upload authorization delays deletion; legacy keys and absent COS fail closed", async () => {
  const f = fixture(); f.state.assets[0].expires_at = new Date(Date.now() + 60000); await f.service.tick();
  assert.equal(f.state.status, "PROCESSING"); assert.equal(f.state.error, "WAITING_UPLOAD_EXPIRY"); assert.equal(f.state.occupied, 100);
  assert.ok(!f.removed.some(k => k.startsWith("media/")));
  f.state.assets[0].expires_at = new Date(0); f.state.assets[0].object_key = "media/other-family/a";
  await f.service.tick(); assert.equal(f.state.error, "LEGACY_MEDIA_REQUIRES_REVIEW"); assert.equal(f.state.status, "PROCESSING");
  const noStorage = fixture(); noStorage.disable(); await noStorage.service.tick(); assert.equal(noStorage.state.error, "STORAGE_UNAVAILABLE");
});

test("family row remains until all cloud deletion succeeds; export lock prevents racing an in-flight ZIP", async () => {
  const busy = fixture(true); busy.unlock(); await busy.service.tick(); assert.equal(busy.writes.length, 0); assert.equal(busy.removed.length, 0);
  const f = fixture(true); f.fail(true); await f.service.tick(); assert.equal(f.state.family, true);
  f.fail(false); await f.service.tick(); assert.equal(f.state.family, false); assert.equal(f.state.status, "COMPLETED");
  assert.ok(f.writes.indexOf("DELETE FROM children WHERE family_id = ?") < f.writes.indexOf("DELETE FROM families WHERE id = ?"));
});

test("execution requires request ownership, approval and current OWNER role; deleted families reject normal access", async () => {
  const m = { query: async () => [{ id: "r", user_id: "u", family_id: "f", kind: "FAMILY_DISSOLVE", status: "APPROVED" }] };
  const db = { transaction: async (fn: (manager: typeof m) => unknown) => fn(m) } as unknown as DatabaseService;
  const families = { requireMember: async () => ({ actor: { role: "ADMIN" } }) } as unknown as FamiliesService;
  await assert.rejects(new DeletionService(db, families, {} as CosStorage).execute("u", "r"), /owner/i);
  const real = new FamiliesService(db, new ConfigService());
  await assert.rejects(real.lockFamily({ query: async () => [{ deleting_at: new Date() }] } as never, "f"), /dissolution/);
  assert.ok(await real.lockFamily({ query: async () => [{ deleting_at: new Date() }] } as never, "f", true));
  const service = new GovernanceService(db, real, new ConfigService());
  assert.throws(() => service.submit("u", { requestId: "r", kind: "ACCOUNT_CLOSE", reason: "x" }), /unavailable/);
  assert.throws(() => service.submit("u", { requestId: "r", kind: "DATA_DELETE", familyId: "f", reason: "x" }), /scope/);
});

test("migration protects partial application and rollback; foreign-key names are unique across migration sources", async () => {
  const migration = new DataDeletion1790985607000();
  await assert.rejects(migration.up({ hasColumn: async () => true } as never), /Partial/);
  await assert.rejects(migration.down({ query: async () => [{}] } as never), /history/);
  const names: string[] = [];
  for (const file of readdirSync("src/database/migrations").filter(f => f.endsWith(".ts") && !f.includes("data-deletion"))) {
    names.push(...Array.from(readFileSync("src/database/migrations/" + file, "utf8").matchAll(/CONSTRAINT (\w+) FOREIGN KEY/g), match => match[1]));
  }
  assert.equal(new Set(names).size, names.length);
});
