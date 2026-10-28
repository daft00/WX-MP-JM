import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { ForbiddenException } from "@nestjs/common";
import { archiveHtml, writeZip } from "../src/exports/shared/archive";
import { canonical, partHtml, planParts, Snapshot, zipSize } from "../src/exports/archive";
import { ExportsService, Task } from "../src/exports/exports.service";
import { Exports1790985605000 } from "../src/database/migrations/1790985605000-exports";
import { BrowserController } from "../src/exports/browser.controller";
import { browserPage } from "../src/exports/browser-page";
import { DatabaseService } from "../src/database/database.service";
import { FamiliesService } from "../src/families/families.service";
import { CosStorage } from "../src/media/cos-storage";
import { Request } from "express";
import { createHash } from "node:crypto";

const snapshot = (): Snapshot => ({ child: { name: "宝宝" }, entries: [{ id: "entry", title: "<script>", body: "文字", kind: "DIARY", occurredAt: "2026-01-01", createdAt: "2026-01-01", assetIds: ["a", "b"] }],
  assets: ["a", "b"].map(id => ({ id, key: `media/f/${id}`, mime: "image/jpeg", kind: "IMAGE", name: id, sizeBytes: 10 })) } as Snapshot);

test("ZIP planning includes actual HTML and ZIP overhead; all assets appear exactly once", async () => {
  const s = snapshot(), limit = 1500000;
  s.assets.forEach(a => { a.sizeBytes = 1000000; });
  const parts = planParts(s, "2026", limit);
  assert.equal(parts.length, 2); assert.deepEqual(parts.flatMap(p => p.ids), ["a", "b"]);
  assert.match(partHtml(s, "2026", ["a"]), /其他分包/);
  assert.match(partHtml(s, "2026", ["a"]), /&lt;script&gt;/);
  for (const part of parts) {
    const html = Buffer.from(partHtml(s, "2026", part.ids)), chunks: Buffer[] = [];
    await writeZip([{ name: "index.html", size: html.length, chunks: async function* () { yield html; } },
      { name: `media/${part.ids[0]}.jpg`, size: 1000000, chunks: async function* () { yield Buffer.alloc(1000000); } }], async b => { chunks.push(Buffer.from(b)); });
    assert.equal(Buffer.concat(chunks).length, part.size); assert.ok(part.size <= limit);
  }
  assert.throws(() => planParts(s, "2026", 1));
  assert.equal(canonical({ b: { z: 1, a: 2 }, a: 0 }), canonical({ a: 0, b: { a: 2, z: 1 } }));
});

test("shared ZIP/HTML implementation remains identical to mini program source", () => {
  const source = resolve("../miniprogram/utils/export-archive.ts");
  if (!existsSync(source)) return; // Standalone Linux release intentionally excludes mini program source.
  assert.equal(readFileSync(resolve("src/exports/shared/archive.ts"), "utf8").replace(/\r\n/g, "\n").split("\n").slice(1).join("\n"), readFileSync(source, "utf8").replace(/\r\n/g, "\n").replace('"../types/models"', '"./models"'));
  assert.equal(typeof archiveHtml, "function");
});

function fixture() {
  const s = snapshot(), t = { id: "job", family_id: "f", child_id: "c", creator_id: "u", period: "2026", status: "PENDING", snapshot: s, parts: planParts(s, "2026"), attempts: 0, progress: 0, cleaned: 0, created_at: new Date(), expires_at: null } as Task;
  let revoked = false, changed = false, failUpload = false, failDelete = false, locked = true, cancelDuringUpload = false;
  const removed: string[] = [], written: Buffer[] = [];
  const manager = { query: async (sql: string, p: unknown[] = []) => {
    if (sql.includes("GET_LOCK")) return [{ acquired: locked ? "1" : "0" }];
    if (sql.includes("RELEASE_LOCK") || sql.startsWith("DELETE FROM export_pairings")) return [];
    if (sql.startsWith("SELECT * FROM export_tasks WHERE cleaned")) return !t.cleaned && ["CANCELLED", "FAILED", "EXPIRED"].includes(t.status) ? [{ ...t }] : [];
    if (sql.startsWith("SELECT * FROM export_tasks WHERE status")) return ["PENDING", "PROCESSING"].includes(t.status) ? [{ ...t }] : [];
    if (sql.startsWith("SELECT * FROM export_tasks WHERE family_id")) return [{ ...t }];
    if (sql.includes("SET cleaned")) t.cleaned = 1;
    else if (sql.includes("SET status = 'EXPIRED'")) { if (t.status === "READY" && t.expires_at!.getTime() < Date.now()) t.status = "EXPIRED"; }
    else if (sql.includes("SET status = 'PROCESSING'")) { t.status = "PROCESSING"; t.attempts++; }
    else if (sql.includes("SET status = 'READY'")) { if (t.status === "PROCESSING") { t.status = "READY"; t.expires_at = new Date(Date.now() + 86400000); } }
    else if (sql.includes("SET status = ?")) { if (["PENDING", "PROCESSING"].includes(t.status)) { t.status = String(p[0]); t.error = String(p[1]); } }
    else if (sql.includes("SET progress")) t.progress = Number(p[0]);
    else throw new Error(`Unexpected query: ${sql}`);
    return [];
  } };
  const db = { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) } as unknown as DatabaseService;
  const families = { requireMember: async () => { if (revoked) throw new ForbiddenException(); return { actor: { role: "OWNER" } }; } } as unknown as FamiliesService;
  const cos = { enabled: true, remove: async (k: string) => { if (failDelete) throw new Error("storage down"); removed.push(k); },
    stream: async function* () { yield Buffer.alloc(10); }, url: () => "https://signed.invalid",
    putStream: async (_: string, stream: AsyncIterable<Buffer>) => { if (failUpload) throw new Error("storage down"); const b = []; for await (const chunk of stream) b.push(chunk); written.push(Buffer.concat(b)); if (cancelDuringUpload) t.status = "CANCELLED"; } } as unknown as CosStorage;
  const service = new ExportsService(db, families, cos);
  (service as unknown as { snapshot: () => Promise<Snapshot> }).snapshot = async () => changed ? { ...s, entries: [] } : s;
  return { service, t, removed, written, revoke: () => { revoked = true; }, change: () => { changed = true; },
    fail: () => { failUpload = true; }, failDelete: () => { failDelete = true; }, unlock: () => { locked = false; }, cancel: () => { cancelDuringUpload = true; } };
}

test("worker streams complete ZIP, reports progress and authorizes each download", async () => {
  const f = fixture(); await f.service.tick(); assert.equal(f.t.status, "READY"); assert.equal(f.t.progress, 1);
  assert.equal(f.written[0].length, (f.t.parts as { size: number }[])[0].size);
  assert.ok((await f.service.download("u", "f", "job", 1)).url);
  f.revoke(); await assert.rejects(f.service.download("u", "f", "job", 1), ForbiddenException);
});
test("worker detects changed snapshots, revocation and cancellation without publishing", async () => {
  for (const action of ["change", "revoke", "cancel"] as const) {
    const f = fixture(); f[action](); await f.service.tick(); assert.notEqual(f.t.status, "READY");
    if (action === "change") assert.equal(f.t.error, "SNAPSHOT_CHANGED");
    if (action === "revoke") assert.equal(f.t.error, "PERMISSION_REVOKED");
  }
});
test("global lock prevents duplicate workers; interrupted uploads get at most three attempts", async () => {
  const locked = fixture(); locked.unlock(); await locked.service.tick(); assert.equal(locked.t.attempts, 0);
  const f = fixture(); f.fail();
  for (let i = 0; i < 3; i++) await f.service.tick();
  assert.equal(f.t.attempts, 3); assert.equal(f.t.status, "FAILED");
  await f.service.tick(); assert.equal(f.t.cleaned, 1);
  assert.ok(f.removed.every(k => k.startsWith("exports/")));
});
test("expired package cleanup retains pending state on storage failure and never deletes source", async () => {
  const f = fixture(); await f.service.tick(); f.t.expires_at = new Date(0); f.failDelete(); await f.service.tick();
  assert.equal(f.t.status, "EXPIRED"); assert.equal(f.t.cleaned, 0);
  await assert.rejects(f.service.download("u", "f", "job", 1));
});
test("migration rejects partial tables and populated rollback", async () => {
  const migration = new Exports1790985605000();
  await assert.rejects(migration.up({ hasTable: async () => true } as never), /partial/);
  await assert.rejects(migration.down({ query: async () => [{}] } as never), /non-empty/);
});
test("computer pairing requires configured HTTPS same origin; page has no access token or third party script", async () => {
  const c = new BrowserController({} as never, {} as never, new ConfigService({ EXPORT_PUBLIC_ORIGIN: "https://api.example.com" }), { requireConsent: async () => {} } as never);
  const check = (c as unknown as { origin: (r: Request) => void }).origin.bind(c);
  assert.throws(() => check({ secure: false, headers: { origin: "https://api.example.com" } } as Request));
  assert.throws(() => check({ secure: true, headers: { origin: "https://evil.example" } } as Request));
  check({ secure: true, headers: { origin: "https://api.example.com" } } as Request);
  assert.match(browserPage("nonce"), /script nonce="nonce"/);
  assert.doesNotMatch(browserPage("nonce"), /accessToken|localStorage|innerHTML/);
});

test("browser pairing is single-use, expires, and rechecks membership on every session request", async () => {
  const secret = "a".repeat(64), browser = "b".repeat(64), id = "11111111-1111-4111-8111-111111111111";
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const row = { id, user_id: "", family_id: "", confirm_hash: hash(secret), browser_hash: hash(browser), expires_at: new Date(Date.now() + 300000), session_expires_at: null as Date | null };
  let revoked = false;
  const manager = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT")) return [row];
    if (sql.startsWith("UPDATE")) { row.user_id = String(args[0]); row.family_id = String(args[1]); row.session_expires_at = new Date(Date.now() + 900000); return []; }
    throw new Error(sql);
  } };
  const db = { transaction: async (fn: (m: typeof manager) => unknown) => fn(manager) } as unknown as DatabaseService;
  const exports = { admin: async () => { if (revoked) throw new ForbiddenException(); }, list: async () => ["allowed"] } as unknown as ExportsService;
  const c = new BrowserController(db, exports, new ConfigService({ EXPORT_PUBLIC_ORIGIN: "https://api.example.com" }), { requireConsent: async () => {} } as never);
  const r = { secure: true, headers: { origin: "https://api.example.com", cookie: `__Secure-growth-export=${id}.${browser}` } } as Request;
  await assert.rejects(c.jobs(r));
  await assert.rejects(c.confirm({ auth: { user: { id: "u" } } } as never, { id, familyId: "family", secret: "c".repeat(64) }));
  await c.confirm({ auth: { user: { id: "u" } } } as never, { id, familyId: "family", secret });
  await assert.rejects(c.confirm({ auth: { user: { id: "u" } } } as never, { id, familyId: "family", secret }));
  assert.deepEqual(await c.jobs(r), ["allowed"]);
  revoked = true; await assert.rejects(c.jobs(r), ForbiddenException); revoked = false;
  row.session_expires_at = new Date(0); await assert.rejects(c.jobs(r));
  row.user_id = ""; row.expires_at = new Date(0);
  await assert.rejects(c.confirm({ auth: { user: { id: "u" } } } as never, { id, familyId: "family", secret }));
});
