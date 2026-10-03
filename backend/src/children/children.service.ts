import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { SaveChildDto } from "./children.dto";

type ChildRow = { id: string; family_id: string; creator_id: string; name: string; birthday: string; gender_label: string; avatar_color: string; created_at: Date };
function childView(row: ChildRow) {
  return { id: row.id, familyId: row.family_id, creatorId: row.creator_id, name: row.name,
    birthday: row.birthday, genderLabel: row.gender_label, avatarColor: row.avatar_color, createdAt: row.created_at.toISOString() };
}

@Injectable()
export class ChildrenService {
  constructor(private readonly database: DatabaseService, private readonly families: FamiliesService) {}

  private async find(manager: EntityManager, familyId: string, childId: string) {
    const rows: ChildRow[] = await manager.query("SELECT * FROM children WHERE family_id = ? AND id = ?", [familyId, childId]);
    if (!rows[0]) throw new NotFoundException("Child not found");
    return childView(rows[0]);
  }

  list(userId: string, familyId: string) {
    return this.database.transaction(async (manager) => {
      await this.families.requireMember(manager, familyId, userId);
      const rows: ChildRow[] = await manager.query("SELECT * FROM children WHERE family_id = ? ORDER BY created_at, id", [familyId]);
      return rows.map(childView);
    });
  }

  get(userId: string, familyId: string, childId: string) {
    return this.database.transaction(async (manager) => {
      await this.families.requireMember(manager, familyId, userId);
      return this.find(manager, familyId, childId);
    });
  }

  save(userId: string, familyId: string, draft: SaveChildDto, childId?: string) {
    return this.database.transaction(async (manager) => {
      const { actor } = await this.families.requireMember(manager, familyId, userId);
      if (actor.role !== "OWNER" && actor.role !== "ADMIN") throw new ForbiddenException("Only family administrators can maintain child profiles");
      const id = childId ?? randomUUID();
      if (childId) {
        await this.find(manager, familyId, childId);
        await manager.query("UPDATE children SET name = ?, birthday = ?, gender_label = ?, avatar_color = ? WHERE family_id = ? AND id = ?",
          [draft.name, draft.birthday, draft.genderLabel, draft.avatarColor, familyId, id]);
      } else {
        await manager.query("INSERT INTO children (id, family_id, creator_id, name, birthday, gender_label, avatar_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, familyId, userId, draft.name, draft.birthday, draft.genderLabel, draft.avatarColor]);
      }
      await this.families.audit(manager, userId, familyId, childId ? "CHILD_UPDATE" : "CHILD_CREATE", "child", id);
      return this.find(manager, familyId, id);
    });
  }
}
