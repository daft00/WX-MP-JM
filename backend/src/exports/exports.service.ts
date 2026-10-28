import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { CosStorage } from "../media/cos-storage";
import { assetPath, canonical, exportRange, Part, partHtml, planParts, Snapshot } from "./archive";
import { writeZip, ZipSource } from "./shared/archive";

export interface Task { id: string; family_id: string; child_id: string; creator_id: string; request_id: string; period: string;
  status: string; snapshot: Snapshot | string; parts: Part[] | string; progress: number; attempts: number; error: string | null;
  cleaned: number; created_at: Date; expires_at: Date | null; confirmed_at: Date | null; entry_count?: number; asset_count?: number }
const decode = <T>(v: T | string): T => typeof v === "string" ? JSON.parse(v) : v;
const key = (t: Task, p: Part) => `exports/${t.family_id}/${t.id}/${p.number}.zip`;

@Injectable()
export class ExportsService {
  constructor(private readonly db: DatabaseService, private readonly families: FamiliesService, private readonly cos: CosStorage) {}
  async admin(m: EntityManager, family: string, user: string) {
    const { actor } = await this.families.requireMember(m, family, user);
    if (!["OWNER", "ADMIN"].includes(actor.role)) throw new ForbiddenException("Family administrator required");
  }
  private async task(m: EntityManager, family: string, id: string): Promise<Task> {
    const [t] = await m.query("SELECT * FROM export_tasks WHERE family_id = ? AND id = ?", [family, id]);
    if (!t) throw new NotFoundException();
    return t;
  }
  private view(t: Task) {
    const s = t.snapshot ? decode(t.snapshot) : { entries: [], assets: [] }, parts = decode(t.parts);
    return { id: t.id, familyId: t.family_id, childId: t.child_id, creatorId: t.creator_id, yearMonth: t.period,
      status: t.expires_at && t.expires_at.getTime() <= Date.now() ? "EXPIRED" : t.status, progress: t.progress,
      partCount: parts.length, parts: parts.map(p => ({ number: p.number, sizeBytes: p.size })),
      entryCount: Number(t.entry_count ?? s.entries.length), assetCount: Number(t.asset_count ?? s.assets.length), sizeBytes: parts.reduce((n, p) => n + p.size, 0),
      error: t.error, createdAt: t.created_at.toISOString(), expiresAt: t.expires_at?.toISOString(), confirmedAt: t.confirmed_at?.toISOString() };
  }
  private async snapshot(m: EntityManager, family: string, child: string, period: string): Promise<Snapshot> {
    const range = exportRange(period);
    const [c] = await m.query("SELECT id, name, birthday, gender_label, updated_at FROM children WHERE family_id = ? AND id = ?", [family, child]);
    if (!c) throw new NotFoundException();
    const rows = await m.query("SELECT * FROM entries WHERE family_id = ? AND child_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id LIMIT 2001", [family, child, range.start, range.end]);
    if (rows.length > 2000) throw new BadRequestException("EXPORT_TOO_LARGE: choose a shorter period");
    const placeholders = rows.map(() => "?").join(",");
    const allAssets = rows.length ? await m.query(`SELECT a.*, ea.entry_id FROM assets a JOIN entry_assets ea ON ea.asset_id = a.id WHERE ea.family_id = ? AND ea.entry_id IN (${placeholders}) ORDER BY ea.entry_id, ea.position`, [family, ...rows.map((r: { id: string }) => r.id)]) : [];
    const allMetrics = rows.length ? await m.query(`SELECT entry_id, type, value, unit, measured_at FROM metrics WHERE family_id = ? AND entry_id IN (${placeholders})`, [family, ...rows.map((r: { id: string }) => r.id)]) : [];
    const assets = [], entries = [];
    for (const r of rows) {
      const aa = allAssets.filter((a: { entry_id: string }) => a.entry_id === r.id);
      if (aa.some((a: { status: string }) => a.status !== "READY")) throw new ConflictException("MEDIA_NOT_READY");
      for (const a of aa) assets.push({ id: a.id, familyId: family, childId: child, creatorId: a.creator_id, kind: a.kind,
        name: a.original_name, sizeBytes: Number(a.size_bytes), createdAt: a.created_at.toISOString(), placeholderTone: "warm",
        key: a.object_key, mime: a.mime_type });
      const metric = allMetrics.find((v: { entry_id: string }) => v.entry_id === r.id);
      entries.push({ id: r.id, familyId: family, childId: child, creatorId: r.creator_id, kind: r.kind, title: r.title,
        body: r.body, customEvent: r.custom_event || undefined, occurredAt: r.occurred_at.toISOString().slice(0, 10),
        createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), assetIds: aa.map((a: { id: string }) => a.id),
        ...(metric ? { metric: { ...metric, value: Number(metric.value) } } : {}) });
    }
    if (assets.length > 10000 || assets.reduce((n, a) => n + a.sizeBytes, 0) > 10 * 1024 ** 3) throw new BadRequestException("EXPORT_TOO_LARGE");
    const json = JSON.stringify({ child: c, entries, assets });
    if (Buffer.byteLength(json) > 4 * 1024 ** 2) throw new BadRequestException("EXPORT_TOO_LARGE");
    return JSON.parse(json);
  }
  create(user: string, family: string, child: string, period: string, request: string) {
    if (!this.cos.enabled) throw new ServiceUnavailableException("Storage unavailable");
    try { exportRange(period); } catch { throw new BadRequestException("Invalid period"); }
    return this.db.transaction(async m => {
      await this.admin(m, family, user);
      const [old] = await m.query("SELECT * FROM export_tasks WHERE family_id = ? AND creator_id = ? AND request_id = ?", [family, user, request]);
      if (old) { if (old.child_id !== child || old.period !== period) throw new ConflictException(); return this.view(old); }
      if ((await m.query("SELECT id FROM export_tasks WHERE family_id = ? AND cleaned = false LIMIT 1", [family])).length) throw new ConflictException("Cancel or expire the previous export first");
      if ((await m.query("SELECT id FROM data_requests WHERE family_id = ? AND status = 'PROCESSING' LIMIT 1", [family])).length) throw new ConflictException("Data deletion in progress");
      const snapshot = await this.snapshot(m, family, child, period), id = randomUUID();
      let parts: Part[]; try { parts = planParts(snapshot, period); } catch { throw new BadRequestException("EXPORT_TOO_LARGE"); }
      await m.query("INSERT INTO export_tasks (id, family_id, child_id, creator_id, request_id, period, snapshot, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, family, child, user, request, period, JSON.stringify(snapshot), JSON.stringify(parts)]);
      return this.view(await this.task(m, family, id));
    });
  }
  list(user: string, family: string) {
    return this.db.transaction(async m => { await this.admin(m, family, user);
      const rows: Task[] = await m.query(`SELECT id, family_id, child_id, creator_id, period, status, parts, progress, error, created_at, expires_at, confirmed_at,
        JSON_LENGTH(snapshot, '$.entries') AS entry_count, JSON_LENGTH(snapshot, '$.assets') AS asset_count
        FROM export_tasks WHERE family_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`, [family]);
      return rows.map(t => this.view(t)); });
  }
  cancel(user: string, family: string, id: string) {
    return this.db.transaction(async m => { await this.admin(m, family, user); await this.task(m, family, id);
      await m.query("UPDATE export_tasks SET status = 'CANCELLED' WHERE id = ?", [id]); });
  }
  confirm(user: string, family: string, id: string) {
    return this.db.transaction(async m => { await this.admin(m, family, user); const t = await this.task(m, family, id);
      this.ready(t); await m.query("UPDATE export_tasks SET confirmed_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
      return this.view(await this.task(m, family, id)); });
  }
  private ready(t: Task) {
    if (t.status !== "READY" || !t.expires_at || t.expires_at.getTime() <= Date.now()) throw new ConflictException("Export not available");
  }
  download(user: string, family: string, id: string, number: number) {
    return this.db.transaction(async m => {
      await this.admin(m, family, user); const t = await this.task(m, family, id); this.ready(t);
      await this.admin(m, family, t.creator_id);
      const p = decode(t.parts).find(p => p.number === number); if (!p) throw new NotFoundException();
      return { url: this.cos.url(key(t, p), { "response-content-disposition": `attachment; filename="growth-${t.period}-${p.number}.zip"`, "response-cache-control": "private, no-store" }), sizeBytes: p.size };
    });
  }
  private async validate(t: Task) {
    return this.db.transaction(async m => { await this.admin(m, t.family_id, t.creator_id);
      const current = await this.task(m, t.family_id, t.id);
      if (!["PENDING", "PROCESSING"].includes(current.status)) throw new Error("CANCELLED");
      if (canonical(await this.snapshot(m, t.family_id, t.child_id, t.period)) !== canonical(decode(t.snapshot))) throw new Error("SNAPSHOT_CHANGED");
    });
  }
  private async clean(t: Task) {
    for (const p of decode(t.parts)) await this.cos.remove(key(t, p));
    await this.db.transaction(m => m.query("UPDATE export_tasks SET cleaned = true WHERE id = ?", [t.id]));
  }
  async tick() {
    if (!this.cos.enabled) return;
    // Connection-scoped lock survives short nested transactions; a killed worker releases it automatically.
    await this.db.transaction(async lock => {
      const [v] = await lock.query("SELECT GET_LOCK('growth_diary_export_worker', 0) AS acquired");
      if (Number(v.acquired) !== 1) return;
      try {
        await this.db.transaction(m => m.query("DELETE FROM export_pairings WHERE COALESCE(session_expires_at, expires_at) < UTC_TIMESTAMP(3)"));
        await this.db.transaction(m => m.query("UPDATE export_tasks SET status = 'EXPIRED' WHERE status = 'READY' AND expires_at <= UTC_TIMESTAMP(3)"));
        const garbage: Task[] = await this.db.transaction(m => m.query("SELECT * FROM export_tasks WHERE cleaned = false AND status IN ('CANCELLED','FAILED','EXPIRED') LIMIT 10"));
        for (const t of garbage) { try { await this.clean(t); } catch { /* Keep cleanup pending on COS failure. */ } }
        const [t]: Task[] = await this.db.transaction(m => m.query("SELECT * FROM export_tasks WHERE status IN ('PENDING','PROCESSING') ORDER BY created_at, id LIMIT 1"));
        if (!t) return;
        try {
          if (t.attempts >= 3) throw new Error("RETRY_EXHAUSTED");
          await this.db.transaction(m => m.query("UPDATE export_tasks SET status = 'PROCESSING', attempts = attempts + 1, progress = 0 WHERE id = ? AND status IN ('PENDING','PROCESSING')", [t.id]));
          await this.validate(t);
          for (const p of decode(t.parts)) await this.cos.remove(key(t, p));
          const s = decode(t.snapshot);
          for (const p of decode(t.parts)) {
            await this.validate(t);
            const html = Buffer.from(partHtml(s, t.period, p.ids));
            const files: ZipSource[] = [{ name: "index.html", size: html.length, chunks: async function* () { yield html; } }];
            for (const a of s.assets.filter(a => p.ids.includes(a.id))) files.push({ name: assetPath(a), size: a.sizeBytes, chunks: () => this.cos.stream(a.key, a.sizeBytes) });
            const stream = new PassThrough({ highWaterMark: 64 * 1024 });
            stream.on("error", () => undefined);
            const upload = this.cos.putStream(key(t, p), stream, p.size).catch(e => { stream.destroy(e); throw e; });
            const produce = (async () => { try { await writeZip(files, async bytes => { if (!stream.write(bytes)) await once(stream, "drain"); }); stream.end(); }
              catch (e) { stream.destroy(e as Error); throw e; } })();
            const results = await Promise.allSettled([upload, produce]);
            const failed = results.find(r => r.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
            await this.db.transaction(m => m.query("UPDATE export_tasks SET progress = ? WHERE id = ?", [p.number, t.id]));
          }
          await this.validate(t);
          await this.db.transaction(async m => {
            await this.admin(m, t.family_id, t.creator_id);
            if (canonical(await this.snapshot(m, t.family_id, t.child_id, t.period)) !== canonical(s)) throw new Error("SNAPSHOT_CHANGED");
            await m.query("UPDATE export_tasks SET status = 'READY', error = NULL, expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 DAY) WHERE id = ? AND status = 'PROCESSING'", [t.id]);
          });
        } catch (e) {
          const reason = e instanceof Error && ["SNAPSHOT_CHANGED", "RETRY_EXHAUSTED", "CANCELLED"].includes(e.message) ? e.message :
            e instanceof ConflictException || e instanceof BadRequestException ? "SNAPSHOT_CHANGED" :
            e instanceof ForbiddenException || e instanceof NotFoundException ? "PERMISSION_REVOKED" : "PROCESSING_RETRY";
          const retry = reason === "PROCESSING_RETRY" && t.attempts < 2;
          await this.db.transaction(m => m.query("UPDATE export_tasks SET status = ?, error = ? WHERE id = ? AND status IN ('PENDING','PROCESSING')", [retry ? "PENDING" : "FAILED", reason, t.id]));
        }
      } finally { await lock.query("SELECT RELEASE_LOCK('growth_diary_export_worker')"); }
    });
  }
}
