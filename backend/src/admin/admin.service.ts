import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { AdminPageDto, AdminRoleDto, AuditQueryDto } from "./admin.dto";

type MemberRow = { id: string; family_id: string; user_id: string; role: string; joined_at: Date; nickname: string; avatar_text: string };
const memberView = (row: MemberRow) => ({ id: row.id, familyId: row.family_id, userId: row.user_id, role: row.role, joinedAt: row.joined_at.toISOString(),
  user: { id: row.user_id, nickname: row.nickname, avatarText: row.avatar_text } });
const bounds = (query: AdminPageDto) => [query.pageSize + 1, (query.page - 1) * query.pageSize];
function page<T>(rows: T[], query: AdminPageDto) {
  return { items: rows.slice(0, query.pageSize), page: query.page, pageSize: query.pageSize, hasMore: rows.length > query.pageSize };
}

@Injectable()
export class AdminService {
  constructor(private readonly database: DatabaseService, private readonly families: FamiliesService) {}

  private async requireAdmin(manager: EntityManager, userId: string) {
    // 在业务事务中读取并锁定当前系统角色，避免鉴权后被撤权仍执行管理写入。
    const rows: { system_role: string }[] = await manager.query("SELECT system_role FROM users WHERE id = ? FOR SHARE", [userId]);
    if (rows[0]?.system_role !== "SYSTEM_ADMIN") throw new ForbiddenException("System administrator required");
  }

  dashboard(userId: string) {
    return this.database.transaction(async (manager) => {
      await this.requireAdmin(manager, userId);
      // ponytail: 初期直接精确计数；表规模变大后再引入聚合计数，避免现在维护第二份数据。
      const rows = await manager.query(`SELECT (SELECT COUNT(*) FROM families) AS familyCount,
        (SELECT COUNT(*) FROM users) AS userCount, (SELECT COUNT(*) FROM children) AS childCount,
        (SELECT COUNT(*) FROM entries) AS entryCount, (SELECT COUNT(*) FROM assets) AS assetCount`);
      return Object.fromEntries(["familyCount", "userCount", "childCount", "entryCount", "assetCount"].map((key) => [key, Number(rows[0][key])]));
    });
  }

  listFamilies(userId: string, query: AdminPageDto) {
    return this.database.transaction(async (manager) => {
      await this.requireAdmin(manager, userId);
      const rows: { id: string; name: string; owner_id: string; created_at: Date; owner_name: string; child_count: string; entry_count: string; asset_count: string }[] = await manager.query(`SELECT f.id, f.name, f.owner_id, f.created_at, u.nickname AS owner_name,
        (SELECT COUNT(*) FROM children c WHERE c.family_id = f.id) AS child_count,
        (SELECT COUNT(*) FROM entries e WHERE e.family_id = f.id) AS entry_count,
        (SELECT COUNT(*) FROM assets a WHERE a.family_id = f.id) AS asset_count
        FROM families f JOIN users u ON u.id = f.owner_id ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`, bounds(query));
      return page(rows.map((row) => ({ family: { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at.toISOString() }, ownerName: row.owner_name,
        childCount: Number(row.child_count), entryCount: Number(row.entry_count), assetCount: Number(row.asset_count) })), query);
    });
  }

  listUsers(userId: string, query: AdminPageDto) {
    return this.database.transaction(async (manager) => {
      await this.requireAdmin(manager, userId);
      const rows: { id: string; nickname: string; avatar_text: string; system_role: string; family_count: string; entry_count: string }[] = await manager.query(`SELECT u.id, u.nickname, u.avatar_text, u.system_role,
        (SELECT COUNT(*) FROM family_members m WHERE m.user_id = u.id) AS family_count,
        (SELECT COUNT(*) FROM entries e WHERE e.creator_id = u.id) AS entry_count
        FROM users u ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, bounds(query));
      return page(rows.map((row) => ({ user: { id: row.id, nickname: row.nickname, avatarText: row.avatar_text,
        ...(row.system_role === "SYSTEM_ADMIN" ? { systemRole: "SYSTEM_ADMIN" } : {}) }, familyCount: Number(row.family_count), entryCount: Number(row.entry_count) })), query);
    });
  }

  members(userId: string, familyId: string, query: AdminPageDto) {
    return this.database.transaction(async (manager) => {
      await this.requireAdmin(manager, userId);
      await this.families.lockFamily(manager, familyId);
      const rows: MemberRow[] = await manager.query(`SELECT m.id, m.family_id, m.user_id, m.role, m.joined_at, u.nickname, u.avatar_text
        FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.family_id = ? ORDER BY m.joined_at, m.id LIMIT ? OFFSET ?`, [familyId, ...bounds(query)]);
      return page(rows.map(memberView), query);
    });
  }

  audits(userId: string, query: AuditQueryDto) {
    return this.database.transaction(async (manager) => {
      await this.requireAdmin(manager, userId);
      const where: string[] = [], params: unknown[] = [];
      for (const [column, value] of [["family_id", query.familyId], ["actor_id", query.actorId], ["action", query.action]]) {
        if (value !== undefined) { where.push(`${column} = ?`); params.push(value); }
      }
      const rows: { id: string; actor_id: string; family_id: string | null; action: string; target_type: string; target_id: string | null; reason: string; created_at: Date }[] = await manager.query(`SELECT id, actor_id, family_id, action, target_type, target_id, reason, created_at FROM audit_logs
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, ...bounds(query)]);
      return page(rows.map((row) => ({ id: row.id, actorId: row.actor_id, familyId: row.family_id, action: row.action,
        targetType: row.target_type, targetId: row.target_id, reason: row.reason, createdAt: row.created_at.toISOString() })), query);
    });
  }

  private async target(manager: EntityManager, userId: string, familyId: string, memberId: string) {
    await this.requireAdmin(manager, userId);
    await this.families.lockFamily(manager, familyId);
    const rows: MemberRow[] = await manager.query("SELECT id, family_id, user_id, role, joined_at FROM family_members WHERE family_id = ? AND id = ? FOR UPDATE", [familyId, memberId]);
    if (!rows[0]) throw new NotFoundException("Member not found");
    if (rows[0].role === "OWNER" || rows[0].user_id === userId) throw new ForbiddenException("Cannot manage the owner or your own membership through system administration");
    return rows[0];
  }

  changeRole(userId: string, familyId: string, memberId: string, body: AdminRoleDto) {
    return this.database.transaction(async (manager) => {
      const target = await this.target(manager, userId, familyId, memberId);
      await manager.query("UPDATE family_members SET role = ? WHERE family_id = ? AND id = ?", [body.role, familyId, memberId]);
      if (body.role === "MEMBER") await this.families.clearInvites(manager, familyId, target.user_id);
      await this.families.audit(manager, userId, familyId, "SYSTEM_MEMBER_ROLE", "membership", memberId, `${target.role} -> ${body.role}: ${body.reason}`);
      const rows: MemberRow[] = await manager.query(`SELECT m.id, m.family_id, m.user_id, m.role, m.joined_at, u.nickname, u.avatar_text
        FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.family_id = ? AND m.id = ?`, [familyId, memberId]);
      return memberView(rows[0]);
    });
  }

  remove(userId: string, familyId: string, memberId: string, reason: string) {
    return this.database.transaction(async (manager) => {
      const target = await this.target(manager, userId, familyId, memberId);
      await this.families.clearInvites(manager, familyId, target.user_id);
      await manager.query("DELETE FROM family_members WHERE family_id = ? AND id = ?", [familyId, memberId]);
      await this.families.audit(manager, userId, familyId, "SYSTEM_MEMBER_REMOVE", "membership", memberId, `${target.role} -> REMOVED; user=${target.user_id}: ${reason}`);
    });
  }
}
