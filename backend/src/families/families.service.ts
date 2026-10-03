import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";

type Role = "OWNER" | "ADMIN" | "MEMBER";
type FamilyRow = { id: string; name: string; owner_id: string; created_at: Date };
type MemberRow = { id: string; family_id: string; user_id: string; role: Role; joined_at: Date; nickname: string; avatar_text: string };

function familyView(row: FamilyRow) {
  return { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at.toISOString() };
}
function memberView(row: MemberRow) {
  return { id: row.id, familyId: row.family_id, userId: row.user_id, role: row.role, joinedAt: row.joined_at.toISOString(),
    user: { id: row.user_id, nickname: row.nickname, avatarText: row.avatar_text } };
}

@Injectable()
export class FamiliesService {
  constructor(private readonly database: DatabaseService, private readonly config: ConfigService) {}

  private hashCode(code: string): string {
    const secret = this.config.get<string>("INVITE_CODE_SECRET");
    if (!secret) throw new ServiceUnavailableException();
    return createHmac("sha256", Buffer.from(secret, "hex")).update(code.trim().toUpperCase()).digest("hex");
  }

  async lockFamily(manager: EntityManager, id: string): Promise<FamilyRow> {
    // ponytail: 小规模按家庭串行化，保证成员变更与邀请消费有相同锁顺序；高并发时再细分锁。
    const rows: FamilyRow[] = await manager.query("SELECT id, name, owner_id, created_at FROM families WHERE id = ? FOR UPDATE", [id]);
    if (!rows[0]) throw new NotFoundException("Family not found");
    return rows[0];
  }

  private async membership(manager: EntityManager, familyId: string, userId: string): Promise<MemberRow | undefined> {
    const rows: MemberRow[] = await manager.query("SELECT * FROM family_members WHERE family_id = ? AND user_id = ? FOR UPDATE", [familyId, userId]);
    return rows[0];
  }

  async requireMember(manager: EntityManager, familyId: string, userId: string) {
    const family = await this.lockFamily(manager, familyId);
    const actor = await this.membership(manager, familyId, userId);
    if (!actor) throw new NotFoundException("Family not found");
    return { family, actor };
  }

  audit(manager: EntityManager, actorId: string, familyId: string, action: string, targetType: string, targetId: string, reason = action) {
    return manager.query("INSERT INTO audit_logs (id, actor_id, family_id, action, target_type, target_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), actorId, familyId, action, targetType, targetId, reason]);
  }

  private async memberResult(manager: EntityManager, familyId: string, memberId: string) {
    const rows: MemberRow[] = await manager.query(`SELECT m.id, m.family_id, m.user_id, m.role, m.joined_at, u.nickname, u.avatar_text
      FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.family_id = ? AND m.id = ?`, [familyId, memberId]);
    if (!rows[0]) throw new NotFoundException("Member not found");
    return memberView(rows[0]);
  }

  list(userId: string) {
    return this.database.transaction(async (manager) => {
      const rows: FamilyRow[] = await manager.query(`SELECT f.id, f.name, f.owner_id, f.created_at FROM families f
        JOIN family_members m ON m.family_id = f.id WHERE m.user_id = ? ORDER BY f.created_at, f.id`, [userId]);
      return rows.map(familyView);
    });
  }

  create(userId: string, name: string) {
    return this.database.transaction(async (manager) => {
      const id = randomUUID();
      await manager.query("INSERT INTO families (id, name, owner_id) VALUES (?, ?, ?)", [id, name, userId]);
      await manager.query("INSERT INTO family_members (id, family_id, user_id, role) VALUES (?, ?, ?, 'OWNER')", [randomUUID(), id, userId]);
      await this.audit(manager, userId, id, "FAMILY_CREATE", "family", id);
      return familyView(await this.lockFamily(manager, id));
    });
  }

  get(userId: string, familyId: string) {
    return this.database.transaction(async (manager) => familyView((await this.requireMember(manager, familyId, userId)).family));
  }

  members(userId: string, familyId: string) {
    return this.database.transaction(async (manager) => {
      await this.requireMember(manager, familyId, userId);
      const rows: MemberRow[] = await manager.query(`SELECT m.id, m.family_id, m.user_id, m.role, m.joined_at, u.nickname, u.avatar_text
        FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.family_id = ? ORDER BY m.joined_at, m.id`, [familyId]);
      return rows.map(memberView);
    });
  }

  createInvite(userId: string, familyId: string) {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.requireMember(manager, familyId, userId);
      if (actor.role === "MEMBER") throw new ForbiddenException("Only family administrators can invite");
      const id = randomUUID(), code = randomBytes(8).toString("hex").toUpperCase();
      const hash = this.hashCode(code);
      await manager.query(`INSERT INTO invites (id, family_id, creator_id, code_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR))`, [id, familyId, userId, hash]);
      await this.audit(manager, userId, familyId, "INVITE_CREATE", "invite", id);
      const rows: { expires_at: Date }[] = await manager.query("SELECT expires_at FROM invites WHERE id = ?", [id]);
      return { id, familyId, creatorId: userId, code, expiresAt: rows[0].expires_at.toISOString() };
    });
  }

  join(userId: string, code: string) {
    const hash = this.hashCode(code);
    return this.database.transaction(async (manager) => {
      // 先只定位家庭，再按“家庭 -> 邀请 -> 成员”的顺序锁定并重新检查；不信任初次快照。
      const lookup: { family_id: string }[] = await manager.query("SELECT family_id FROM invites WHERE code_hash = ?", [hash]);
      const invalid = () => new BadRequestException("Invalid, used or expired invitation");
      if (!lookup[0]) throw invalid();
      const family = await this.lockFamily(manager, lookup[0].family_id);
      const rows: { id: string; creator_id: string }[] = await manager.query(`SELECT id, creator_id FROM invites
        WHERE code_hash = ? AND family_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`, [hash, family.id]);
      const invite = rows[0];
      if (!invite) throw invalid();
      const creator = await this.membership(manager, family.id, invite.creator_id);
      if (!creator || creator.role === "MEMBER") throw invalid();
      if (await this.membership(manager, family.id, userId)) throw new ConflictException("Already a family member");
      const result: { affectedRows: number } = await manager.query(`UPDATE invites SET used_at = UTC_TIMESTAMP(3), used_by = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`, [userId, invite.id]);
      if (result.affectedRows !== 1) throw invalid();
      const memberId = randomUUID();
      await manager.query("INSERT INTO family_members (id, family_id, user_id, role) VALUES (?, ?, ?, 'MEMBER')", [memberId, family.id, userId]);
      await this.audit(manager, userId, family.id, "FAMILY_JOIN", "membership", memberId);
      return familyView(family);
    });
  }

  changeRole(userId: string, familyId: string, memberId: string, role: "ADMIN" | "MEMBER") {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.requireMember(manager, familyId, userId);
      if (actor.role !== "OWNER") throw new ForbiddenException("Only the family owner can change roles");
      const rows: MemberRow[] = await manager.query("SELECT * FROM family_members WHERE family_id = ? AND id = ? FOR UPDATE", [familyId, memberId]);
      const target = rows[0];
      if (!target) throw new NotFoundException("Member not found");
      if (target.role === "OWNER" || target.user_id === userId) throw new ForbiddenException("Cannot change the owner role");
      await manager.query("UPDATE family_members SET role = ? WHERE family_id = ? AND id = ?", [role, familyId, memberId]);
      if (role === "MEMBER") await this.clearInvites(manager, familyId, target.user_id);
      await this.audit(manager, userId, familyId, `MEMBER_ROLE_${role}`, "membership", memberId);
      return this.memberResult(manager, familyId, memberId);
    });
  }

  remove(userId: string, familyId: string, memberId: string) {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.requireMember(manager, familyId, userId);
      const rows: MemberRow[] = await manager.query("SELECT * FROM family_members WHERE family_id = ? AND id = ? FOR UPDATE", [familyId, memberId]);
      const target = rows[0];
      if (!target) throw new NotFoundException("Member not found");
      if (target.role === "OWNER" || target.user_id === userId ||
          !(actor.role === "OWNER" || (actor.role === "ADMIN" && target.role === "MEMBER"))) {
        throw new ForbiddenException("Cannot remove this member");
      }
      await this.clearInvites(manager, familyId, target.user_id);
      await manager.query("DELETE FROM family_members WHERE family_id = ? AND id = ?", [familyId, memberId]);
      await this.audit(manager, userId, familyId, "MEMBER_REMOVE", "membership", memberId);
    });
  }

  clearInvites(manager: EntityManager, familyId: string, userId: string) {
    return manager.query("DELETE FROM invites WHERE family_id = ? AND creator_id = ? AND used_at IS NULL", [familyId, userId]);
  }
}
