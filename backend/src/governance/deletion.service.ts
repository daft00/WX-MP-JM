import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { CosStorage } from "../media/cos-storage";

async function idle(m: EntityManager, family: string) {
  if ((await m.query("SELECT id FROM data_requests WHERE family_id = ? AND status = 'PROCESSING' LIMIT 1", [family])).length) throw new ConflictException("Deletion already running for this family");
}

// Both the existing DELETE endpoint and approved requests use the same durable cleanup path.
export async function beginEntryDeletion(m: EntityManager, families: FamiliesService, user: string, family: string, entry: string, request?: string) {
  const { actor } = await families.requireMember(m, family, user);
  if (!["OWNER", "ADMIN"].includes(actor.role)) throw new ForbiddenException("Family administrator required");
  const [row] = await m.query("SELECT child_id FROM entries WHERE family_id = ? AND id = ?", [family, entry]);
  if (!row) throw new NotFoundException("Entry not found");
  await idle(m, family);
  const assets: { asset_id: string }[] = await m.query("SELECT asset_id FROM entry_assets WHERE family_id = ? AND entry_id = ?", [family, entry]);
  const id = request || randomUUID();
  if (!request) await m.query(`INSERT INTO data_requests (id, user_id, family_id, target_family_id, request_id, kind, reason, entry_id)
    VALUES (?, ?, ?, ?, ?, 'DATA_DELETE', 'Family administrator confirmed record deletion', ?)`, [id, user, family, family, randomUUID(), entry]);
  await m.query("UPDATE data_requests SET status = 'PROCESSING', child_id = ?, asset_ids = ?, started_at = UTC_TIMESTAMP(3), last_error = NULL WHERE id = ?", [row.child_id, JSON.stringify(assets.map(a => a.asset_id)), id]);
  await m.query("UPDATE export_tasks SET status = 'CANCELLED' WHERE family_id = ? AND child_id = ?", [family, row.child_id]);
  await m.query("DELETE FROM export_pairings WHERE family_id = ?", [family]);
  await m.query(`UPDATE assets a JOIN entry_assets ea ON ea.asset_id = a.id SET a.status = 'DELETING'
    WHERE ea.family_id = ? AND ea.entry_id = ?`, [family, entry]);
  await m.query("DELETE FROM entries WHERE family_id = ? AND id = ?", [family, entry]);
  await families.audit(m, user, family, "ENTRY_DELETE", "entry", entry);
  return { id, status: "PROCESSING" };
}

@Injectable()
export class DeletionService {
  constructor(private readonly db: DatabaseService, private readonly families: FamiliesService, private readonly cos: CosStorage) {}

  execute(user: string, id: string) {
    return this.db.transaction(async m => {
      const [lookup] = await m.query("SELECT * FROM data_requests WHERE id = ? AND user_id = ?", [id, user]);
      if (!lookup) throw new NotFoundException();
      if (["PROCESSING", "COMPLETED"].includes(lookup.status)) return { id, status: lookup.status };
      const { actor } = await this.families.requireMember(m, lookup.family_id, user);
      const [request] = await m.query("SELECT * FROM data_requests WHERE id = ? FOR UPDATE", [id]);
      if (request.status !== "APPROVED") throw new ConflictException("An approved request is required");
      if (request.kind === "DATA_DELETE" && request.entry_id) return beginEntryDeletion(m, this.families, user, request.family_id, request.entry_id, id);
      if (request.kind !== "FAMILY_DISSOLVE" || actor.role !== "OWNER") throw new ForbiddenException("Current owner required");
      await idle(m, request.family_id);
      await m.query("UPDATE families SET deleting_at = UTC_TIMESTAMP(3) WHERE id = ?", [request.family_id]);
      await m.query("UPDATE data_requests SET status = 'PROCESSING', started_at = UTC_TIMESTAMP(3), last_error = NULL WHERE id = ?", [id]);
      await m.query("UPDATE data_requests SET status = 'CANCELLED', last_error = 'FAMILY_DISSOLUTION' WHERE family_id = ? AND id <> ? AND status IN ('PENDING','APPROVED')", [request.family_id, id]);
      await m.query("DELETE FROM invites WHERE family_id = ?", [request.family_id]);
      await m.query("DELETE FROM export_pairings WHERE family_id = ?", [request.family_id]);
      await m.query("UPDATE export_tasks SET status = 'CANCELLED' WHERE family_id = ?", [request.family_id]);
      await m.query("UPDATE assets SET status = 'DELETING' WHERE family_id = ?", [request.family_id]);
      await m.query("DELETE FROM entries WHERE family_id = ?", [request.family_id]);
      await this.families.audit(m, user, request.family_id, "FAMILY_DISSOLVE_STARTED", "data_request", id);
      return { id, status: "PROCESSING" };
    });
  }

  async tick() {
    // Share the export writer's connection lock: a cancelled in-flight ZIP must finish before deletion.
    await this.db.transaction(async lock => {
      const [v] = await lock.query("SELECT GET_LOCK('growth_diary_export_worker', 0) AS acquired");
      if (Number(v.acquired) !== 1) return;
      try {
        const [job] = await this.db.transaction(m => m.query("SELECT id, family_id FROM data_requests WHERE status = 'PROCESSING' ORDER BY updated_at, id LIMIT 1"));
        if (!job) return;
        try {
          await this.db.transaction(async m => {
            await this.families.lockFamily(m, job.family_id, true);
            const [r] = await m.query("SELECT * FROM data_requests WHERE id = ? FOR UPDATE", [job.id]);
            if (r.status !== "PROCESSING") return;
            const family = r.family_id, dissolve = r.kind === "FAMILY_DISSOLVE";
            const scope = dissolve ? "family_id = ?" : "family_id = ? AND child_id = ?";
            const params = dissolve ? [family] : [family, r.child_id];
            const exports = await m.query(`SELECT id, parts, cleaned FROM export_tasks WHERE ${scope} LIMIT 5`, params);
            for (const task of exports) {
              const parts: { number: number }[] = typeof task.parts === "string" ? JSON.parse(task.parts) : task.parts;
              if (!task.cleaned && parts.length) {
                if (!this.cos.enabled) throw new Error("STORAGE_UNAVAILABLE");
                for (const part of parts) await this.cos.remove(`exports/${family}/${task.id}/${part.number}.zip`);
              }
              await m.query("DELETE FROM export_tasks WHERE id = ?", [task.id]);
            }
            if ((await m.query(`SELECT id FROM export_tasks WHERE ${scope} LIMIT 1`, params)).length) {
              await m.query("UPDATE data_requests SET updated_at = UTC_TIMESTAMP(3), last_error = 'CLEANING_EXPORTS' WHERE id = ?", [r.id]);
              return;
            }
            const ids: string[] = typeof r.asset_ids === "string" ? JSON.parse(r.asset_ids) : r.asset_ids || [];
            const assetScope = dissolve ? "a.family_id = ?" : `a.family_id = ? AND a.id IN (${ids.map(() => "?").join(",")})`;
            const assetParams = dissolve ? [family] : [family, ...ids];
            const assets = dissolve || ids.length ? await m.query(`SELECT a.id, a.object_key, u.expires_at FROM assets a
              LEFT JOIN media_uploads u ON u.id = a.id WHERE ${assetScope} LIMIT 5`, assetParams) : [];
            let waiting = false;
            for (const a of assets) {
              if (a.expires_at && new Date(a.expires_at).getTime() + 60000 > Date.now()) { waiting = true; continue; }
              if (!this.cos.enabled) throw new Error("STORAGE_UNAVAILABLE");
              // Never delete a legacy arbitrary key outside this asset's canonical namespace.
              if (a.object_key !== `media/${family}/${a.id}`) throw new Error("LEGACY_MEDIA_REQUIRES_REVIEW");
              await this.cos.remove(`tmp/${family}/${a.id}`);
              await this.cos.remove(a.object_key + ".jpg");
              await this.cos.remove(a.object_key);
              await m.query("DELETE FROM assets WHERE family_id = ? AND id = ?", [family, a.id]);
              await m.query("UPDATE media_uploads SET deleted = true, reserved_bytes = 0, used_bytes = 0 WHERE id = ?", [a.id]);
            }
            const remaining = dissolve || ids.length ? await m.query(`SELECT a.id FROM assets a WHERE ${assetScope} LIMIT 1`, assetParams) : [];
            if (remaining.length) {
              await m.query("UPDATE data_requests SET updated_at = UTC_TIMESTAMP(3), last_error = ? WHERE id = ?", [waiting ? "WAITING_UPLOAD_EXPIRY" : "CLEANING_MEDIA", r.id]);
              return;
            }
            if (dissolve) {
              const [quota] = await m.query("SELECT COALESCE(SUM(reserved_bytes + used_bytes), 0) AS occupied FROM media_uploads WHERE family_id = ?", [family]);
              if (Number(quota.occupied)) throw new Error("MEDIA_LEDGER_REQUIRES_REVIEW");
              for (const table of ["export_jobs", "media_uploads", "family_storage", "children", "family_members"]) await m.query(`DELETE FROM ${table} WHERE family_id = ?`, [family]);
              await this.families.audit(m, r.user_id, family, "FAMILY_DISSOLVE_COMPLETED", "data_request", r.id);
            } else await this.families.audit(m, r.user_id, family, "DATA_DELETE_COMPLETED", "data_request", r.id);
            await m.query("UPDATE data_requests SET status = 'COMPLETED', completed_at = UTC_TIMESTAMP(3), last_error = NULL, asset_ids = NULL WHERE id = ?", [r.id]);
            if (dissolve) await m.query("DELETE FROM families WHERE id = ?", [family]);
          });
        } catch (e) {
          const reason = e instanceof Error && ["STORAGE_UNAVAILABLE", "LEGACY_MEDIA_REQUIRES_REVIEW", "MEDIA_LEDGER_REQUIRES_REVIEW"].includes(e.message) ? e.message : "CLEANUP_RETRY";
          await this.db.transaction(m => m.query("UPDATE data_requests SET last_error = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'PROCESSING'", [reason, job.id]));
        }
      } finally { await lock.query("SELECT RELEASE_LOCK('growth_diary_export_worker')"); }
    });
  }
}
