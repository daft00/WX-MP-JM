import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { EntryQueryDto, MetricQueryDto, SaveEntryDto } from "./entries.dto";

type EntryRow = { id: string; family_id: string; child_id: string; creator_id: string; kind: string; title: string; body: string; custom_event: string | null; occurred_at: Date; created_at: Date; updated_at: Date };
type MetricRow = { id: string; family_id: string; child_id: string; creator_id: string; entry_id: string; type: string; value: string; unit: string; measured_at: Date };
const metricView = (row: MetricRow) => ({ id: row.id, familyId: row.family_id, childId: row.child_id, creatorId: row.creator_id,
  entryId: row.entry_id, type: row.type, value: Number(row.value), unit: row.unit, measuredAt: row.measured_at.toISOString().slice(0, 10) });

// 游标是分页位置而非授权凭据；每页仍重新检查成员关系和宝宝归属。
function decodeCursor(cursor: string | undefined, scope: string): { date: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    if (!/^[\w-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const date = new Date(value.date);
    if (value.scope !== scope || typeof value.date !== "string" || !Number.isFinite(date.getTime()) || date.toISOString() !== value.date ||
      date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999 ||
      typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id)) throw new Error();
    return { date, id: value.id };
  } catch { throw new BadRequestException("Invalid pagination cursor"); }
}
const encodeCursor = (scope: string, date: Date, id: string) => Buffer.from(JSON.stringify({ scope, date: date.toISOString(), id })).toString("base64url");

@Injectable()
export class EntriesService {
  constructor(private readonly database: DatabaseService, private readonly families: FamiliesService) {}

  private async requireChild(manager: EntityManager, familyId: string, childId: string) {
    const rows = await manager.query("SELECT id FROM children WHERE family_id = ? AND id = ?", [familyId, childId]);
    if (!rows[0]) throw new NotFoundException("Child not found");
  }

  private async find(manager: EntityManager, familyId: string, id: string): Promise<EntryRow> {
    const rows: EntryRow[] = await manager.query("SELECT * FROM entries WHERE family_id = ? AND id = ?", [familyId, id]);
    if (!rows[0]) throw new NotFoundException("Entry not found");
    return rows[0];
  }

  private async views(manager: EntityManager, familyId: string, rows: EntryRow[]) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id), placeholders = ids.map(() => "?").join(",");
    const metrics: MetricRow[] = await manager.query(`SELECT * FROM metrics WHERE family_id = ? AND entry_id IN (${placeholders})`, [familyId, ...ids]);
    const assets: { entry_id: string; asset_id: string }[] = await manager.query(`SELECT entry_id, asset_id FROM entry_assets WHERE family_id = ? AND entry_id IN (${placeholders}) ORDER BY position`, [familyId, ...ids]);
    return rows.map((row) => {
      const metric = metrics.find((item) => item.entry_id === row.id);
      return { id: row.id, familyId: row.family_id, childId: row.child_id, creatorId: row.creator_id, kind: row.kind,
        title: row.title, body: row.body, occurredAt: row.occurred_at.toISOString().slice(0, 10),
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        assetIds: assets.filter((item) => item.entry_id === row.id).map((item) => item.asset_id),
        ...(row.custom_event ? { customEvent: row.custom_event } : {}), ...(metric ? { metric: metricView(metric) } : {}) };
    });
  }

  list(userId: string, familyId: string, query: EntryQueryDto) {
    return this.database.transaction(async (manager) => {
      await this.families.requireMember(manager, familyId, userId);
      if (query.childId) await this.requireChild(manager, familyId, query.childId);
      const scope = `entries:${familyId}:${query.childId ?? ""}`, cursor = decodeCursor(query.cursor, scope);
      const where = ["family_id = ?"], params: unknown[] = [familyId];
      if (query.childId) { where.push("child_id = ?"); params.push(query.childId); }
      if (cursor) { where.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))"); params.push(cursor.date, cursor.date, cursor.id); }
      const rows: EntryRow[] = await manager.query(`SELECT * FROM entries WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC, id DESC LIMIT ?`, [...params, query.pageSize + 1]);
      const page = rows.slice(0, query.pageSize), last = page.at(-1);
      return { items: await this.views(manager, familyId, page), ...(rows.length > query.pageSize && last ? { nextCursor: encodeCursor(scope, last.occurred_at, last.id) } : {}) };
    });
  }

  get(userId: string, familyId: string, id: string) {
    return this.database.transaction(async (manager) => {
      await this.families.requireMember(manager, familyId, userId);
      return (await this.views(manager, familyId, [await this.find(manager, familyId, id)]))[0];
    });
  }

  metrics(userId: string, familyId: string, query: MetricQueryDto) {
    return this.database.transaction(async (manager) => {
      await this.families.requireMember(manager, familyId, userId);
      await this.requireChild(manager, familyId, query.childId);
      const scope = `metrics:${familyId}:${query.childId}:${query.type}`, cursor = decodeCursor(query.cursor, scope);
      const params: unknown[] = [familyId, query.childId, query.type];
      if (cursor) params.push(cursor.date, cursor.date, cursor.id);
      const rows: MetricRow[] = await manager.query(`SELECT * FROM metrics WHERE family_id = ? AND child_id = ? AND type = ?
        ${cursor ? "AND (measured_at > ? OR (measured_at = ? AND id > ?))" : ""} ORDER BY measured_at, id LIMIT ?`, [...params, query.pageSize + 1]);
      const page = rows.slice(0, query.pageSize), last = page.at(-1);
      return { items: page.map(metricView), ...(rows.length > query.pageSize && last ? { nextCursor: encodeCursor(scope, last.measured_at, last.id) } : {}) };
    });
  }

  save(userId: string, familyId: string, draft: SaveEntryDto, entryId?: string) {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.families.requireMember(manager, familyId, userId);
      const original = entryId ? await this.find(manager, familyId, entryId) : undefined;
      if (original && actor.role === "MEMBER" && original.creator_id !== userId) throw new ForbiddenException("Only the author or family administrators can edit");
      await this.requireChild(manager, familyId, draft.childId);
      if ((draft.metricType === undefined) !== (draft.metricValue === undefined)) throw new BadRequestException("metricType and metricValue must be provided together");
      if (draft.kind !== "MILESTONE" && (draft.metricType !== undefined || draft.customEvent)) throw new BadRequestException("Only milestones can contain metrics or custom events");
      const id = entryId ?? randomUUID(), creator = original?.creator_id ?? userId;
      // 先校验全部素材，再修改关联；管理员可保留原素材，新素材必须由当前操作者上传。
      for (const assetId of draft.assetIds) {
        const assets: { creator_id: string; status: string; entry_id: string | null }[] = await manager.query(`SELECT a.creator_id, a.status, ea.entry_id FROM assets a
          LEFT JOIN entry_assets ea ON ea.asset_id = a.id WHERE a.family_id = ? AND a.child_id = ? AND a.id = ?`, [familyId, draft.childId, assetId]);
        const asset = assets[0];
        if (!asset || asset.status !== "READY" || (asset.creator_id !== userId && asset.entry_id !== id)) throw new BadRequestException("Invalid or unavailable asset");
        if (asset.entry_id && asset.entry_id !== id) throw new ConflictException("Asset is already attached to another entry");
      }
      if (original) {
        // 复合外键要求先移除旧关联；同一事务内重建，失败时全部恢复。
        await manager.query("DELETE FROM entry_assets WHERE family_id = ? AND entry_id = ?", [familyId, id]);
        await manager.query("DELETE FROM metrics WHERE family_id = ? AND entry_id = ?", [familyId, id]);
        await manager.query("UPDATE entries SET child_id = ?, kind = ?, title = ?, body = ?, custom_event = ?, occurred_at = ?, updated_at = UTC_TIMESTAMP(3) WHERE family_id = ? AND id = ?",
          [draft.childId, draft.kind, draft.title, draft.body.trim(), draft.customEvent || null, new Date(`${draft.occurredAt}T00:00:00Z`), familyId, id]);
      } else {
        await manager.query("INSERT INTO entries (id, family_id, child_id, creator_id, kind, title, body, custom_event, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, familyId, draft.childId, creator, draft.kind, draft.title, draft.body.trim(), draft.customEvent || null, new Date(`${draft.occurredAt}T00:00:00Z`)]);
      }
      for (const [position, assetId] of draft.assetIds.entries()) await manager.query("INSERT INTO entry_assets (entry_id, asset_id, family_id, child_id, position) VALUES (?, ?, ?, ?, ?)", [id, assetId, familyId, draft.childId, position]);
      if (draft.metricType !== undefined) await manager.query("INSERT INTO metrics (id, family_id, child_id, creator_id, entry_id, type, value, unit, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), familyId, draft.childId, creator, id, draft.metricType, draft.metricValue, draft.metricType === "WEIGHT" ? "kg" : "cm", new Date(`${draft.occurredAt}T00:00:00Z`)]);
      await this.families.audit(manager, userId, familyId, original ? "ENTRY_UPDATE" : "ENTRY_CREATE", "entry", id);
      return (await this.views(manager, familyId, [await this.find(manager, familyId, id)]))[0];
    });
  }

  remove(userId: string, familyId: string, id: string) {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.families.requireMember(manager, familyId, userId);
      if (actor.role !== "OWNER" && actor.role !== "ADMIN") throw new ForbiddenException("Only family administrators can permanently delete entries");
      await this.find(manager, familyId, id);
      // 数据库删除不等于 COS 删除；DELETING 状态留给后续媒体清理任务处理。
      await manager.query(`UPDATE assets a JOIN entry_assets ea ON ea.asset_id = a.id SET a.status = 'DELETING'
        WHERE ea.family_id = ? AND ea.entry_id = ?`, [familyId, id]);
      await manager.query("DELETE FROM entries WHERE family_id = ? AND id = ?", [familyId, id]);
      await this.families.audit(manager, userId, familyId, "ENTRY_DELETE", "entry", id);
    });
  }
}
