import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { CosStorage, InvalidMedia, PREVIEW_LIMIT } from "./cos-storage";
import { UploadDto } from "./media.dto";

const QUOTA = 10 * 1024 ** 3;
type Row = { id: string; family_id: string; child_id: string; creator_id: string; kind: string; status: string; object_key: string;
  original_name: string; mime_type: string; size_bytes: string; created_at: Date; updated_at: Date; ready_at: Date; declared_bytes: string;
  reserved_bytes: string; used_bytes: string; expires_at: Date; requested: number; deleted: number; temp_deleted: number; last_error: string | null; body_hash: string };
const tempKey = (row: Row) => `tmp/${row.family_id}/${row.id}`;
const previewKey = (row: Row) => `${row.object_key}.jpg`;

@Injectable()
export class MediaService {
  constructor(private readonly db: DatabaseService, private readonly families: FamiliesService, private readonly storage: CosStorage) {}
  private async usage(m: EntityManager, familyId: string) {
    const [quota] = await m.query("SELECT quota_bytes FROM family_storage WHERE family_id = ?", [familyId]);
    const [s] = await m.query(`SELECT COALESCE(SUM(used_bytes),0) AS used, COALESCE(SUM(reserved_bytes),0) AS reserved
      FROM media_uploads WHERE family_id = ?`, [familyId]);
    const [old] = await m.query(`SELECT COALESCE(SUM(a.size_bytes),0) AS used FROM assets a LEFT JOIN media_uploads u ON u.id = a.id
      WHERE a.family_id = ? AND u.id IS NULL`, [familyId]);
    return { enabled: this.storage.enabled, quotaBytes: Number(quota?.quota_bytes ?? QUOTA), usedBytes: Number(s.used) + Number(old.used), reservedBytes: Number(s.reserved) };
  }
  quota(user: string, family: string) {
    return this.db.transaction(async (m) => { await this.families.requireMember(m, family, user); return this.usage(m, family); });
  }
  adminQuota(user: string, family: string) {
    return this.db.transaction(async m => {
      const [actor] = await m.query("SELECT system_role FROM users WHERE id = ? FOR SHARE", [user]);
      if (actor?.system_role !== "SYSTEM_ADMIN") throw new ForbiddenException("System administrator required");
      await this.families.lockFamily(m, family);
      return this.usage(m, family);
    });
  }
  setQuota(user: string, family: string, quota: number, reason: string) {
    return this.db.transaction(async (m) => {
      const [actor] = await m.query("SELECT system_role FROM users WHERE id = ? FOR SHARE", [user]);
      if (actor?.system_role !== "SYSTEM_ADMIN") throw new ForbiddenException("System administrator required");
      await this.families.lockFamily(m, family);
      const usage = await this.usage(m, family);
      if (quota < usage.usedBytes + usage.reservedBytes) throw new ConflictException("Quota below occupied space");
      await m.query("INSERT INTO family_storage (family_id, quota_bytes) VALUES (?, ?) ON DUPLICATE KEY UPDATE quota_bytes = ?", [family, quota, quota]);
      await m.query("INSERT INTO audit_logs (id, actor_id, family_id, action, target_type, target_id, reason) VALUES (?, ?, ?, 'STORAGE_QUOTA_UPDATE', 'family', ?, ?)", [randomUUID(), user, family, family, `${quota}: ${reason}`]);
      return this.usage(m, family);
    });
  }
  private async row(m: EntityManager, family: string, id: string): Promise<Row> {
    const [row] = await m.query(`SELECT a.*, u.declared_bytes, u.reserved_bytes, u.used_bytes, u.expires_at, u.requested, u.deleted,
      u.temp_deleted, u.last_error, u.body_hash FROM assets a JOIN media_uploads u ON u.id = a.id WHERE a.family_id = ? AND a.id = ?`, [family, id]);
    if (!row || row.deleted) throw new NotFoundException("Media not found");
    return row;
  }
  private view(row: Row) {
    return { id: row.id, familyId: row.family_id, childId: row.child_id, creatorId: row.creator_id, kind: row.kind,
      name: row.original_name, sizeBytes: Number(row.size_bytes), createdAt: row.created_at.toISOString(), placeholderTone: "warm",
      status: row.status, error: row.last_error,
      ...(row.status === "READY" ? { localPath: this.storage.url(row.object_key, { "response-content-type": row.mime_type, "response-cache-control": "private, no-store" }),
        posterPath: this.storage.url(previewKey(row)), expiresAt: new Date(Date.now() + 300000).toISOString() } : {}) };
  }
  async start(user: string, family: string, dto: UploadDto) {
    if (!this.storage.enabled) throw new ServiceUnavailableException("Media storage is not configured");
    if (dto.sizeBytes > (dto.kind === "IMAGE" ? 10 : 50) * 1024 ** 2) throw new BadRequestException("Media too large");
    const hash = createHash("sha256").update(JSON.stringify([dto.childId, dto.kind, dto.name, dto.sizeBytes])).digest("hex");
    const id = await this.db.transaction(async (m) => {
      await this.families.requireMember(m, family, user);
      const [child] = await m.query("SELECT id FROM children WHERE family_id = ? AND id = ?", [family, dto.childId]);
      if (!child) throw new NotFoundException("Child not found");
      const [previous] = await m.query("SELECT id, body_hash, deleted FROM media_uploads WHERE family_id = ? AND creator_id = ? AND request_id = ?", [family, user, dto.requestId]);
      if (previous) {
        if (previous.body_hash !== hash || previous.deleted) throw new ConflictException("Upload request already used");
        return previous.id as string;
      }
      const usage = await this.usage(m, family), reserve = dto.sizeBytes * 2 + PREVIEW_LIMIT;
      if (usage.usedBytes + usage.reservedBytes + reserve > usage.quotaBytes) throw new ConflictException("Storage quota exceeded");
      const id = randomUUID();
      await m.query(`INSERT INTO assets (id, family_id, child_id, creator_id, kind, object_key, original_name, mime_type, size_bytes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'application/octet-stream', ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`,
      [id, family, dto.childId, user, dto.kind, `media/${family}/${id}`, dto.name, dto.sizeBytes]);
      await m.query(`INSERT INTO media_uploads (id, family_id, creator_id, request_id, body_hash, reserved_bytes, declared_bytes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))`, [id, family, user, dto.requestId, hash, reserve, dto.sizeBytes]);
      return id;
    });
    return this.authorize(user, family, id);
  }
  authorize(user: string, family: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.families.requireMember(m, family, user);
      const row = await this.row(m, family, id);
      if (row.creator_id !== user) throw new ForbiddenException();
      if (row.status !== "PENDING" || row.requested) return { asset: this.view(row) };
      if (row.expires_at.getTime() < Date.now() + 30000) throw new ConflictException("Upload expired");
      try { return { asset: this.view(row), upload: await this.storage.upload(tempKey(row), Number(row.declared_bytes), row.expires_at) }; }
      catch { throw new ServiceUnavailableException("Upload authorization unavailable; retry the same request"); }
    });
  }
  complete(user: string, family: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.families.requireMember(m, family, user);
      const row = await this.row(m, family, id);
      if (row.creator_id !== user) throw new ForbiddenException();
      if (row.status === "PENDING") {
        if (row.expires_at.getTime() <= Date.now()) throw new ConflictException("Upload expired");
        await m.query("UPDATE media_uploads SET requested = true, next_attempt_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
      }
      return this.view(row);
    });
  }
  get(user: string, family: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.families.requireMember(m, family, user);
      const row = await this.row(m, family, id);
      const [link] = await m.query("SELECT entry_id FROM entry_assets WHERE asset_id = ?", [id]);
      if ((!link || row.status !== "READY") && row.creator_id !== user) throw new NotFoundException();
      if (row.status === "DELETING" || row.status === "FAILED") return { id, status: row.status, error: row.last_error };
      return this.view(row);
    });
  }
  cancel(user: string, family: string, id: string) {
    return this.db.transaction(async (m) => {
      await this.families.requireMember(m, family, user);
      const [previous] = await m.query("SELECT deleted FROM media_uploads WHERE family_id = ? AND creator_id = ? AND id = ?", [family, user, id]);
      if (previous?.deleted) return;
      const row = await this.row(m, family, id);
      if (row.creator_id !== user) throw new ForbiddenException();
      if ((await m.query("SELECT entry_id FROM entry_assets WHERE asset_id = ?", [id])).length) throw new ConflictException("Asset is attached");
      await m.query("UPDATE assets SET status = 'DELETING' WHERE id = ?", [id]);
      await m.query("UPDATE media_uploads SET next_attempt_at = UTC_TIMESTAMP(3) WHERE id = ?", [id]);
    });
  }
  async tick(): Promise<number> {
    if (!this.storage.enabled) return 0;
    const candidates: { id: string; family_id: string }[] = await this.db.transaction((m) => m.query(
      `SELECT u.id, u.family_id FROM media_uploads u JOIN assets a ON a.id = u.id LEFT JOIN entry_assets ea ON ea.asset_id = a.id
       WHERE u.deleted = false AND u.next_attempt_at <= UTC_TIMESTAMP(3) AND (
         (a.status = 'PENDING' AND (u.requested OR u.expires_at < UTC_TIMESTAMP(3))) OR a.status IN ('DELETING','FAILED') OR
         (a.status = 'READY' AND ((NOT u.temp_deleted AND u.expires_at < UTC_TIMESTAMP(3)) OR
           (ea.asset_id IS NULL AND a.updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)))))
       ORDER BY u.next_attempt_at, u.id LIMIT 20`));
    for (const item of candidates) {
      await this.db.transaction(async (m) => {
        // shortcut: 初期worker并发1且按家庭锁执行有超时的云请求；规模扩大时改为持久租约分阶段处理。
        await this.families.lockFamily(m, item.family_id, true);
        const row = await this.row(m, item.family_id, item.id);
        const expired = row.expires_at.getTime() + 60000 < Date.now();
        const linked = (await m.query("SELECT entry_id FROM entry_assets WHERE asset_id = ?", [row.id])).length > 0;
        const abandoned = row.status === "READY" && !linked && row.updated_at.getTime() + 86400000 < Date.now();
        if ((row.status === "PENDING" && expired) || abandoned) row.status = "DELETING";
        try {
          if (row.status === "PENDING" && row.requested) {
            await this.storage.freeze(tempKey(row), row.object_key, Number(row.declared_bytes));
            const frozen = await this.storage.head(row.object_key);
            if (!frozen || frozen.size !== Number(row.declared_bytes)) throw new InvalidMedia("Frozen object size mismatch");
            const mime = await this.storage.inspect(row.object_key, row.kind);
            const previewSize = await this.storage.preview(row.object_key, row.kind, previewKey(row));
            await m.query("UPDATE assets SET status = 'READY', mime_type = ?, ready_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [mime, row.id]);
            await m.query("UPDATE media_uploads SET used_bytes = ?, reserved_bytes = declared_bytes, last_error = NULL WHERE id = ?", [frozen.size + previewSize, row.id]);
            row.status = "READY";
          }
          if (row.status === "DELETING" || row.status === "FAILED") {
            await m.query("UPDATE assets SET status = 'DELETING' WHERE id = ?", [row.id]);
            if (expired) {
              await this.storage.remove(tempKey(row));
              await this.storage.remove(previewKey(row));
              await this.storage.remove(row.object_key);
              await m.query("DELETE FROM assets WHERE id = ?", [row.id]);
              await m.query("UPDATE media_uploads SET deleted = true, reserved_bytes = 0, used_bytes = 0 WHERE id = ?", [row.id]);
            }
          } else if (row.status === "READY" && expired && !row.temp_deleted) {
            await this.storage.remove(tempKey(row));
            await m.query("UPDATE media_uploads SET temp_deleted = true, reserved_bytes = 0 WHERE id = ?", [row.id]);
          }
          await m.query("UPDATE media_uploads SET next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ?", [row.id]);
        } catch (error) {
          if (error instanceof InvalidMedia) await m.query("UPDATE assets SET status = 'DELETING' WHERE id = ?", [row.id]);
          await m.query("UPDATE media_uploads SET last_error = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id = ?", [error instanceof InvalidMedia ? "INVALID_MEDIA" : "PROCESSING_RETRY", row.id]);
        }
      });
    }
    return candidates.length;
  }
}
