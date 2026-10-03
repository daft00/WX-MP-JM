import {
  Asset,
  Child,
  ChildDraft,
  Entry,
  EntryDraft,
  ExportJob,
  Family,
  FamilyMember,
  Id,
  Invite,
  MetricType,
  PrototypeState,
  Role,
  Session,
  SystemAdminDashboard,
} from "../types/models";
import { addHours } from "../utils/date";
import { createId, createInviteCode } from "../utils/id";
import {
  AuthService,
  ChildService,
  EntryQuery,
  EntryService,
  ExportService,
  FamilyService,
  LocalMediaFile,
  ServiceContainer,
  SystemAdminService,
  UploadService,
} from "./contracts";
import { createSeedState } from "./mock-state";

const STORAGE_KEY = "growth_diary_prototype_state_v3";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadState(): PrototypeState {
  const stored = wx.getStorageSync(STORAGE_KEY) as PrototypeState | "";
  if (stored && (stored.version === 3 || stored.version === 4)) {
    if (stored.version === 3) {
      stored.version = 4;
      const systemAdmin = stored.users.find((item) => item.id === "user_mom");
      if (systemAdmin) systemAdmin.systemRole = "SYSTEM_ADMIN";
      wx.setStorageSync(STORAGE_KEY, stored);
    }
    return stored;
  }
  const seed = createSeedState();
  wx.setStorageSync(STORAGE_KEY, seed);
  return seed;
}

function saveState(state: PrototypeState): void {
  wx.setStorageSync(STORAGE_KEY, state);
}

function findSession(state: PrototypeState, userId = state.activeUserId): Session {
  const user = state.users.find((item) => item.id === userId);
  const userMemberships = state.members.filter((item) => item.userId === userId);
  const membership =
    userMemberships.find((item) => item.familyId === state.activeFamilyId) || userMemberships[0];
  if (!user || !membership) {
    throw new Error("演示用户不存在");
  }
  const family = state.families.find((item) => item.id === membership.familyId);
  if (!family) {
    throw new Error("家庭空间不存在");
  }
  return clone({ user, membership, family });
}

function requireActiveSession(state: PrototypeState): Session {
  const user = state.users.find((item) => item.id === state.activeUserId);
  const membership = state.members.find(
    (item) => item.userId === state.activeUserId && item.familyId === state.activeFamilyId,
  );
  const family = state.families.find((item) => item.id === state.activeFamilyId);
  if (!user || !membership || !family) {
    throw new Error("你不是该家庭成员，无法查看宝宝照片");
  }
  return clone({ user, membership, family });
}

function requireSystemAdmin(state: PrototypeState) {
  const user = state.users.find((item) => item.id === state.activeUserId);
  if (!user || user.systemRole !== "SYSTEM_ADMIN") {
    throw new Error("只有系统管理员可以访问此功能");
  }
  return user;
}

function isAdmin(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function metricUnit(type: MetricType): "cm" | "kg" {
  return type === "WEIGHT" ? "kg" : "cm";
}

async function persistFile(path: string): Promise<{ path: string; volatile: boolean }> {
  if (!path) {
    return { path: "", volatile: true };
  }
  if (path.includes("wxfile://usr")) {
    return { path, volatile: false };
  }
  try {
    const result = await new Promise<WechatMiniprogram.SaveFileSuccessCallbackResult>((resolve, reject) => {
      wx.getFileSystemManager().saveFile({ tempFilePath: path, success: resolve, fail: reject });
    });
    return { path: result.savedFilePath, volatile: false };
  } catch (_error) {
    return { path, volatile: true };
  }
}

class MockAuthService implements AuthService {
  async getSession(): Promise<Session> {
    return findSession(loadState());
  }

  async listPrototypeUsers() {
    return clone(loadState().users);
  }

  async listPrototypeSessions(): Promise<Session[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    return state.members
      .filter((member) => member.familyId === session.family.id)
      .map((member) => findSession({ ...state, activeFamilyId: session.family.id }, member.userId));
  }

  async switchPrototypeUser(userId: Id): Promise<Session> {
    const state = loadState();
    const session = findSession(state, userId);
    state.activeUserId = userId;
    state.activeFamilyId = session.family.id;
    if (!state.children.some((child) => child.id === state.activeChildId && child.familyId === session.family.id)) {
      state.activeChildId = state.children.find((child) => child.familyId === session.family.id)?.id || "";
    }
    saveState(state);
    return session;
  }

  async resetPrototypeData(): Promise<void> {
    saveState(createSeedState());
  }
}

class MockFamilyService implements FamilyService {
  async listAccessibleFamilies(): Promise<Family[]> {
    const state = loadState();
    const familyIds = new Set(
      state.members.filter((member) => member.userId === state.activeUserId).map((member) => member.familyId),
    );
    return clone(state.families.filter((family) => familyIds.has(family.id)));
  }

  async getCurrentFamily(): Promise<Family> {
    return requireActiveSession(loadState()).family;
  }

  async listMembers(): Promise<FamilyMember[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    return clone(state.members.filter((item) => item.familyId === session.family.id));
  }

  async getSelection(): Promise<{ familyId: Id; childId: Id }> {
    const state = loadState();
    return { familyId: state.activeFamilyId, childId: state.activeChildId };
  }

  async selectFamily(familyId: Id): Promise<Family> {
    const state = loadState();
    const membership = state.members.find(
      (item) => item.userId === state.activeUserId && item.familyId === familyId,
    );
    const family = state.families.find((item) => item.id === familyId);
    if (!membership || !family) {
      throw new Error("无法进入该家庭");
    }
    state.activeFamilyId = familyId;
    state.activeChildId = "";
    saveState(state);
    return clone(family);
  }

  async selectChild(childId: Id): Promise<Child> {
    const state = loadState();
    const session = requireActiveSession(state);
    const child = state.children.find(
      (item) => item.id === childId && item.familyId === session.family.id,
    );
    if (!child) {
      throw new Error("该宝宝不属于当前家庭");
    }
    state.activeChildId = childId;
    saveState(state);
    return clone(child);
  }

  async clearSelection(): Promise<void> {
    const state = loadState();
    state.activeFamilyId = "";
    state.activeChildId = "";
    saveState(state);
  }

  async createFamily(name: string): Promise<Family> {
    const state = loadState();
    const user = state.users.find((item) => item.id === state.activeUserId);
    const normalizedName = name.trim();
    if (!user) {
      throw new Error("演示用户不存在");
    }
    if (normalizedName.length < 2 || normalizedName.length > 20) {
      throw new Error("家庭名称请输入2至20个字");
    }
    const family: Family = {
      id: createId("family"),
      name: normalizedName,
      ownerId: user.id,
      createdAt: new Date().toISOString(),
    };
    state.families.push(family);
    state.members.push({
      id: createId("member"),
      familyId: family.id,
      userId: user.id,
      role: "OWNER",
      joinedAt: new Date().toISOString(),
      user: clone(user),
    });
    state.activeFamilyId = family.id;
    state.activeChildId = "";
    saveState(state);
    return clone(family);
  }

  async createInvite(): Promise<Invite> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (!isAdmin(session.membership.role)) {
      throw new Error("只有管理员可以创建邀请");
    }
    let code = createInviteCode();
    while (state.invites.some((item) => item.code === code && !item.usedAt)) {
      code = createInviteCode();
    }
    const invite: Invite = {
      id: createId("invite"),
      familyId: session.family.id,
      creatorId: session.user.id,
      code,
      expiresAt: addHours(new Date(), 24),
    };
    state.invites.unshift(invite);
    saveState(state);
    return clone(invite);
  }

  async joinFamily(code: string): Promise<Family> {
    const state = loadState();
    const normalizedCode = code.trim().toUpperCase();
    const invite = state.invites.find((item) => item.code.toUpperCase() === normalizedCode);
    if (!invite || invite.usedAt || new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw new Error("邀请码无效、已使用或已过期");
    }
    if (state.members.some((item) => item.familyId === invite.familyId && item.userId === state.activeUserId)) {
      throw new Error("你已经是该家庭成员");
    }
    const user = state.users.find((item) => item.id === state.activeUserId);
    const family = state.families.find((item) => item.id === invite.familyId);
    if (!user || !family) {
      throw new Error("家庭空间不存在");
    }
    state.members.push({
      id: createId("member"),
      familyId: family.id,
      userId: user.id,
      role: "MEMBER",
      joinedAt: new Date().toISOString(),
      user: clone(user),
    });
    invite.usedAt = new Date().toISOString();
    state.activeFamilyId = family.id;
    state.activeChildId = "";
    saveState(state);
    return clone(family);
  }

  async updateMemberRole(memberId: Id, role: "ADMIN" | "MEMBER"): Promise<FamilyMember> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (session.membership.role !== "OWNER") {
      throw new Error("只有家庭创建者可以调整成员角色");
    }
    const member = state.members.find((item) => item.id === memberId && item.familyId === session.family.id);
    if (!member || member.role === "OWNER" || member.userId === session.user.id) {
      throw new Error("不能调整该成员的角色");
    }
    member.role = role;
    saveState(state);
    return clone(member);
  }

  async removeMember(memberId: Id): Promise<void> {
    const state = loadState();
    const session = requireActiveSession(state);
    const member = state.members.find((item) => item.id === memberId && item.familyId === session.family.id);
    if (!member || member.role === "OWNER" || member.userId === session.user.id) {
      throw new Error("不能移除该成员");
    }
    const canRemove = session.membership.role === "OWNER"
      || (session.membership.role === "ADMIN" && member.role === "MEMBER");
    if (!canRemove) {
      throw new Error("没有权限移除该成员");
    }
    state.members = state.members.filter((item) => item.id !== memberId);
    saveState(state);
  }
}

class MockChildService implements ChildService {
  async list(): Promise<Child[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    return clone(state.children.filter((item) => item.familyId === session.family.id));
  }

  async get(id: Id): Promise<Child> {
    const state = loadState();
    const session = requireActiveSession(state);
    const child = state.children.find((item) => item.id === id && item.familyId === session.family.id);
    if (!child) {
      throw new Error("宝宝档案不存在");
    }
    return clone(child);
  }

  async save(draft: ChildDraft): Promise<Child> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (!isAdmin(session.membership.role)) {
      throw new Error("只有管理员可以维护宝宝档案");
    }
    if (!draft.name.trim() || !draft.birthday) {
      throw new Error("请填写宝宝姓名和生日");
    }
    if (draft.id) {
      const index = state.children.findIndex(
        (item) => item.id === draft.id && item.familyId === session.family.id,
      );
      if (index < 0) {
        throw new Error("宝宝档案不存在");
      }
      state.children[index] = { ...state.children[index], ...draft, name: draft.name.trim() };
      saveState(state);
      return clone(state.children[index]);
    }
    const child: Child = {
      id: createId("child"),
      familyId: session.family.id,
      creatorId: session.user.id,
      name: draft.name.trim(),
      birthday: draft.birthday,
      genderLabel: draft.genderLabel || "宝宝",
      avatarColor: draft.avatarColor || "#F0A58A",
      createdAt: new Date().toISOString(),
    };
    state.children.push(child);
    saveState(state);
    return clone(child);
  }
}

class MockEntryService implements EntryService {
  async list(query: EntryQuery = {}): Promise<{ items: Entry[]; nextCursor?: string }> {
    const state = loadState();
    const session = requireActiveSession(state);
    const pageSize = query.pageSize || 10;
    const offset = Number(query.cursor || "0");
    const matched = state.entries
      .filter((item) => item.familyId === session.family.id)
      .filter((item) => !query.childId || item.childId === query.childId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
    const items = matched.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return clone({
      items,
      nextCursor: nextOffset < matched.length ? String(nextOffset) : undefined,
    });
  }

  async get(id: Id): Promise<Entry> {
    const state = loadState();
    const session = requireActiveSession(state);
    const entry = state.entries.find((item) => item.id === id && item.familyId === session.family.id);
    if (!entry) {
      throw new Error("记录不存在或无权访问");
    }
    return clone(entry);
  }

  async save(draft: EntryDraft): Promise<Entry> {
    const state = loadState();
    const session = requireActiveSession(state);
    const child = state.children.find(
      (item) => item.id === draft.childId && item.familyId === session.family.id,
    );
    if (!child) {
      throw new Error("请选择有效的宝宝档案");
    }
    if (!draft.title.trim() || !draft.occurredAt) {
      throw new Error("请填写标题和成长日期");
    }
    if (draft.title.trim().length > 60 || draft.body.length > 2000) {
      throw new Error("标题或正文超过长度限制");
    }
    const now = new Date().toISOString();
    if (draft.id) {
      const index = state.entries.findIndex(
        (item) => item.id === draft.id && item.familyId === session.family.id,
      );
      if (index < 0) {
        throw new Error("记录不存在");
      }
      const original = state.entries[index];
      if (!isAdmin(session.membership.role) && original.creatorId !== session.user.id) {
        throw new Error("只能编辑自己发布的记录");
      }
      const updated = this.composeEntry(state, session, draft, original.id, original.createdAt, original.creatorId);
      updated.updatedAt = now;
      state.entries[index] = updated;
      saveState(state);
      return clone(updated);
    }
    const id = createId("entry");
    const entry = this.composeEntry(state, session, draft, id, now, session.user.id);
    state.entries.unshift(entry);
    saveState(state);
    return clone(entry);
  }

  async deletePermanent(id: Id): Promise<void> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (!isAdmin(session.membership.role)) {
      throw new Error("只有管理员可以永久删除记录");
    }
    const entry = state.entries.find((item) => item.id === id && item.familyId === session.family.id);
    if (!entry) {
      throw new Error("记录不存在");
    }
    state.entries = state.entries.filter((item) => item.id !== id);
    state.assets = state.assets.filter((asset) => !entry.assetIds.includes(asset.id));
    saveState(state);
  }

  async canEdit(entry: Entry): Promise<boolean> {
    const session = requireActiveSession(loadState());
    return entry.familyId === session.family.id
      && (isAdmin(session.membership.role) || entry.creatorId === session.user.id);
  }

  async canDelete(): Promise<boolean> {
    return isAdmin(requireActiveSession(loadState()).membership.role);
  }

  private composeEntry(
    state: PrototypeState,
    session: Session,
    draft: EntryDraft,
    id: Id,
    createdAt: string,
    creatorId: Id,
  ): Entry {
    const metricType = draft.metricType;
    const metricValue = draft.metricValue;
    return {
      id,
      familyId: session.family.id,
      childId: draft.childId,
      creatorId,
      kind: draft.kind,
      title: draft.title.trim(),
      body: draft.body.trim(),
      occurredAt: draft.occurredAt,
      createdAt,
      updatedAt: new Date().toISOString(),
      assetIds: draft.assetIds.slice(0, 9),
      customEvent: draft.customEvent?.trim() || undefined,
      metric:
        metricType && metricValue !== undefined && metricValue > 0
          ? {
              id: createId("metric"),
              familyId: session.family.id,
              childId: draft.childId,
              creatorId,
              entryId: id,
              type: metricType,
              value: metricValue,
              unit: metricUnit(metricType),
              measuredAt: draft.occurredAt,
            }
          : undefined,
    };
  }
}

class MockUploadService implements UploadService {
  async saveLocalMedia(childId: Id, files: LocalMediaFile[]): Promise<Asset[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    const child = state.children.find(
      (item) => item.id === childId && item.familyId === session.family.id,
    );
    if (!child) {
      throw new Error("请选择有效的宝宝档案");
    }
    const assets: Asset[] = [];
    for (const [index, file] of files.slice(0, 9).entries()) {
      const persisted = await persistFile(file.tempFilePath);
      const poster = file.thumbTempFilePath ? await persistFile(file.thumbTempFilePath) : undefined;
      const kind = file.fileType === "video" ? "VIDEO" : "IMAGE";
      assets.push({
        id: createId("asset"),
        familyId: session.family.id,
        childId,
        creatorId: session.user.id,
        kind,
        name: `本地${kind === "VIDEO" ? "视频" : "照片"}${index + 1}`,
        localPath: persisted.path,
        posterPath: poster?.path,
        placeholderTone: kind === "VIDEO" ? "sage" : "peach",
        volatile: persisted.volatile,
        createdAt: new Date().toISOString(),
      });
    }
    state.assets.push(...assets);
    saveState(state);
    return clone(assets);
  }

  async getAssets(ids: Id[]): Promise<Asset[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    return clone(
      ids
        .map((id) => state.assets.find((item) => item.id === id && item.familyId === session.family.id))
        .filter((item): item is Asset => Boolean(item)),
    );
  }
}

class MockExportService implements ExportService {
  async list(): Promise<ExportJob[]> {
    const state = loadState();
    const session = requireActiveSession(state);
    return clone(
      state.exports
        .filter((item) => item.familyId === session.family.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async create(childId: Id, selectedYearMonth: string): Promise<ExportJob> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (!isAdmin(session.membership.role)) {
      throw new Error("只有管理员可以创建素材导出");
    }
    const hasChild = state.children.some(
      (item) => item.id === childId && item.familyId === session.family.id,
    );
    if (!hasChild) {
      throw new Error("请选择有效的宝宝档案");
    }
    const assetCount = state.entries
      .filter((entry) => entry.childId === childId && entry.occurredAt.startsWith(selectedYearMonth))
      .reduce((total, entry) => total + entry.assetIds.length, 0);
    const job: ExportJob = {
      id: createId("export"),
      familyId: session.family.id,
      childId,
      creatorId: session.user.id,
      yearMonth: selectedYearMonth,
      status: "READY",
      partCount: Math.max(1, Math.ceil(assetCount / 20)),
      createdAt: new Date().toISOString(),
      expiresAt: addHours(new Date(), 24 * 7),
    };
    state.exports.unshift(job);
    saveState(state);
    return clone(job);
  }

  async markDownloaded(id: Id): Promise<ExportJob> {
    return this.updateStatus(id, "DOWNLOADED");
  }

  async confirmManualBackup(id: Id): Promise<ExportJob> {
    return this.updateStatus(id, "CONFIRMED");
  }

  private async updateStatus(id: Id, status: "DOWNLOADED" | "CONFIRMED"): Promise<ExportJob> {
    const state = loadState();
    const session = requireActiveSession(state);
    if (!isAdmin(session.membership.role)) {
      throw new Error("只有管理员可以更新素材导出状态");
    }
    const index = state.exports.findIndex(
      (item) => item.id === id && item.familyId === session.family.id,
    );
    if (index < 0) {
      throw new Error("导出任务不存在");
    }
    state.exports[index].status = status;
    if (status === "CONFIRMED") {
      state.exports[index].confirmedAt = new Date().toISOString();
    }
    saveState(state);
    return clone(state.exports[index]);
  }
}

class MockSystemAdminService implements SystemAdminService {
  async getDashboard(): Promise<SystemAdminDashboard> {
    const state = loadState();
    requireSystemAdmin(state);
    return clone({
      familyCount: state.families.length,
      userCount: state.users.length,
      childCount: state.children.length,
      entryCount: state.entries.length,
      assetCount: state.assets.length,
      families: state.families.map((family) => {
        const members = state.members.filter((item) => item.familyId === family.id);
        return {
          family,
          ownerName: state.users.find((item) => item.id === family.ownerId)?.nickname || "未知用户",
          members,
          childCount: state.children.filter((item) => item.familyId === family.id).length,
          entryCount: state.entries.filter((item) => item.familyId === family.id).length,
          assetCount: state.assets.filter((item) => item.familyId === family.id).length,
        };
      }),
      users: state.users.map((user) => ({
        user,
        familyCount: state.members.filter((item) => item.userId === user.id).length,
        entryCount: state.entries.filter((item) => item.creatorId === user.id).length,
      })),
    });
  }

  async updateMemberRole(
    familyId: Id,
    memberId: Id,
    role: "ADMIN" | "MEMBER",
  ): Promise<FamilyMember> {
    const state = loadState();
    requireSystemAdmin(state);
    const member = state.members.find((item) => item.id === memberId && item.familyId === familyId);
    if (!member || member.role === "OWNER") {
      throw new Error("不能调整家庭创建者的角色");
    }
    member.role = role;
    saveState(state);
    return clone(member);
  }

  async removeMember(familyId: Id, memberId: Id): Promise<void> {
    const state = loadState();
    requireSystemAdmin(state);
    const member = state.members.find((item) => item.id === memberId && item.familyId === familyId);
    if (!member || member.role === "OWNER") {
      throw new Error("不能移除家庭创建者");
    }
    state.members = state.members.filter((item) => item.id !== memberId);
    saveState(state);
  }
}

export const mockServices: ServiceContainer = {
  auth: new MockAuthService(),
  family: new MockFamilyService(),
  children: new MockChildService(),
  entries: new MockEntryService(),
  uploads: new MockUploadService(),
  exports: new MockExportService(),
  systemAdmin: new MockSystemAdminService(),
};
