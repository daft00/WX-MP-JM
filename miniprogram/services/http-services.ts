import { createExportService } from "./http-exports";
import { createUploadService } from "./http-uploads";
import { ServiceContainer } from "./contracts";
import { Child, CursorPage, Entry, Family, FamilyMember, FamilySelection, IdentitySession, Invite, MetricValue, SystemAdminDashboard } from "../types/models";

export class ApiError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); }
}

interface Credential { accessToken: string; expiresAt: string }
interface LoginResponse extends Credential, IdentitySession {}

const unavailable = async (): Promise<never> => { throw new Error("此功能尚未接入，当前仅支持家庭与宝宝读取"); };

export function createHttpServices(baseUrl: string): ServiceContainer {
  const storageKey = `growth_diary_session_v1:${baseUrl}`;
  let credential: Credential | undefined;
  let selection: FamilySelection = { familyId: "", childId: "" };
  let revision = 0;
  let loginPending: Promise<IdentitySession> | undefined;
  const stored = wx.getStorageSync(storageKey) as Partial<Credential> | undefined;
  if (stored && typeof stored.accessToken === "string" && typeof stored.expiresAt === "string"
    && Date.parse(stored.expiresAt) > Date.now()) credential = stored as Credential;

  function clearSelection(): void {
    selection = { familyId: "", childId: "" }; revision++;
    wx.removeStorageSync("growth_diary_upload_queue_v1");
    wx.removeStorageSync("growth_diary_export_request_v1");
    wx.removeStorageSync("growth_diary_entry_draft_v1");
    wx.removeStorageSync("growth_diary_edit_entry_id");
  }
  function clearSession(): void {
    credential = undefined;
    clearSelection();
    wx.removeStorageSync(storageKey);
  }
  function requireToken(): string {
    if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
      clearSession();
      throw new ApiError("请重新微信登录", 401);
    }
    return credential.accessToken;
  }
  function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", data?: object, token?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${baseUrl}${path}`, method, data, timeout: 15000,
        header: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        success: (response) => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(response.data as T);
            return;
          }
          if (response.statusCode === 401 && token && credential?.accessToken === token) clearSession();
          if (response.statusCode === 428) wx.reLaunch({ url: "/pages/governance/index" });
          const messages: Record<number, string> = {
            428: "请阅读并确认当前版本的隐私说明",
            400: "请求参数无效，请重试", 401: "登录已失效，请重新微信登录",
            403: "没有访问权限或未获批开户", 404: "数据不存在或已无访问权限", 409: "操作冲突或空间不足，请刷新确认", 429: "操作过于频繁，请稍后重试",
          };
          reject(new ApiError(messages[response.statusCode] || "服务暂时不可用，请稍后重试", response.statusCode));
        },
        fail: () => reject(new ApiError(method === "GET" ? "网络连接失败或超时，请检查网络后重试" : "网络中断，操作结果未确认；请先刷新数据，不要立即重复提交")),
      });
    });
  }
  async function authenticated<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", data?: object): Promise<T> {
    const token = requireToken();
    const result = await request<T>(path, method, data, token);
    if (credential?.accessToken !== token) throw new ApiError("会话已变化，请重试", 401);
    return result;
  }
  function familyPath(): string {
    if (!selection.familyId) throw new Error("请先选择家庭");
    return `/families/${encodeURIComponent(selection.familyId)}`;
  }
  async function familyRead<T>(suffix: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", data?: object): Promise<T> {
    const version = revision;
    try {
      const result = await authenticated<T>(`${familyPath()}${suffix}`, method, data);
      if (version !== revision) throw new Error("家庭选择已变化，请重试");
      return result;
    } catch (error) {
      if (version === revision && error instanceof ApiError && [403, 404].includes(error.status)) clearSelection();
      throw error;
    }
  }
  const services: ServiceContainer = {
    auth: {
      updateNickname: (nickname) => authenticated<IdentitySession>("/auth/me", "PUT", { nickname }),
      hasSession: () => Boolean(credential && Date.parse(credential.expiresAt) > Date.now()),
      login() {
        if (loginPending) return loginPending;
        clearSession();
        const version = revision;
        loginPending = (async () => {
          const code = await new Promise<string>((resolve, reject) => wx.login({
            timeout: 15000,
            success: (result) => result.code ? resolve(result.code) : reject(new Error("未取得微信登录凭证，请重试")),
            fail: () => reject(new Error("微信登录失败，请重试")),
          }));
          const result = await request<LoginResponse>("/auth/wechat/login", "POST", { code });
          if (version !== revision) throw new Error("登录已取消，请重试");
          if (!result.user?.id || !result.accessToken || !(Date.parse(result.expiresAt) > Date.now())) {
            throw new Error("登录响应无效，请重试");
          }
          const next = { accessToken: result.accessToken, expiresAt: result.expiresAt };
          wx.setStorageSync(storageKey, next);
          credential = next;
          return { user: result.user };
        })().finally(() => { loginPending = undefined; });
        return loginPending;
      },
      getIdentity: () => authenticated<IdentitySession>("/auth/me"),
      async getSession() {
        const [identity, family, members] = await Promise.all([
          services.auth.getIdentity(), services.family.getCurrentFamily(), services.family.listMembers(),
        ]);
        const membership = members.find((member) => member.userId === identity.user.id);
        if (!membership) { clearSelection(); throw new Error("已无该家庭访问权限"); }
        return { ...identity, family, membership };
      },
      async logout() {
        const token = credential?.accessToken;
        clearSession();
        if (token) {
          try { await request("/auth/logout", "POST", undefined, token); }
          catch (error) {
            if (!(error instanceof ApiError && error.status === 401)) {
              throw new Error("已清除本机会话；服务器退出未确认，原会话将在到期后失效");
            }
          }
        }
      },
      listPrototypeUsers: unavailable, listPrototypeSessions: unavailable,
      switchPrototypeUser: unavailable, resetPrototypeData: unavailable,
    },
    family: {
      creationStatus: () => authenticated<{ canCreate: boolean }>("/families/creation-status"),
      listAccessibleFamilies: () => authenticated<Family[]>("/families"),
      getCurrentFamily: () => familyRead<Family>(""),
      listMembers: () => familyRead<FamilyMember[]>("/members"),
      getSelection: async () => ({ ...selection }),
      clearSelection: async () => clearSelection(),
      async selectFamily(id) {
        clearSelection();
        const version = revision;
        const family = await authenticated<Family>(`/families/${encodeURIComponent(id)}`);
        if (version !== revision) throw new Error("家庭选择已变化，请重试");
        selection = { familyId: family.id, childId: "" };
        return family;
      },
      async selectChild(id) {
        const version = revision;
        const child = await services.children.get(id);
        if (version !== revision) throw new Error("家庭选择已变化，请重试");
        selection.childId = child.id;
        return child;
      },
      createFamily: (name) => authenticated<Family>("/families", "POST", { name }),
      joinFamily: (code) => authenticated<Family>("/families/join", "POST", { code }),
      createInvite: () => familyRead<Invite>("/invites", "POST"),
      updateMemberRole: (id, role) => familyRead<FamilyMember>(`/members/${encodeURIComponent(id)}`, "PUT", { role }),
      removeMember: (id) => familyRead<void>(`/members/${encodeURIComponent(id)}`, "DELETE"),
    },
    children: {
      list: () => familyRead<Child[]>("/children"),
      get: (id) => familyRead<Child>(`/children/${encodeURIComponent(id)}`),
      save: ({ id, name, birthday, genderLabel, avatarColor }) => familyRead<Child>(
        `/children${id ? `/${encodeURIComponent(id)}` : ""}`, id ? "PUT" : "POST", { name, birthday, genderLabel, avatarColor }),
    },
    entries: {
      listYears: (childId) => familyRead<string[]>(`/entries/years?childId=${encodeURIComponent(childId)}`),
      list: (query = {}) => familyRead<CursorPage<Entry>>(`/entries?${Object.entries(query)
        .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&")}`),
      metrics: (childId, type, cursor) => familyRead<CursorPage<MetricValue>>(
        `/metrics?childId=${encodeURIComponent(childId)}&type=${type}&order=DESC&pageSize=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
      get: (id) => familyRead<Entry>(`/entries/${encodeURIComponent(id)}`),
      save: ({ id, requestId, childId, kind, title, body, occurredAt, assetIds, customEvent, metricType, metricValue }) => familyRead<Entry>(
        `/entries${id ? `/${encodeURIComponent(id)}` : ""}`, id ? "PUT" : "POST",
        { childId, kind, title, body, occurredAt, assetIds, customEvent, metricType, metricValue, ...(!id ? { requestId } : {}) }),
      deletePermanent: (id) => familyRead<void>(`/entries/${encodeURIComponent(id)}`, "DELETE"),
      async canEdit(entry) {
        const session = await services.auth.getSession();
        return session.family.id === entry.familyId && (session.membership.role !== "MEMBER" || entry.creatorId === session.user.id);
      },
      async canDelete() { return (await services.auth.getSession()).membership.role !== "MEMBER"; },
    },
    governance: {
      documents: () => request("/governance/documents"),
      status: () => authenticated("/governance/consent"),
      accept: version => authenticated<void>("/governance/consent", "POST", { version, accepted: true, guardian: true }),
      list: (page, admin = false) => authenticated(`/governance/${admin ? "admin/" : ""}requests?page=${page}&pageSize=20`),
      submit: body => authenticated("/governance/requests", "POST", body),
      async execute(id) { await authenticated(`/governance/requests/${encodeURIComponent(id)}/execute`, "POST", { confirmed: true }); },
      cancel: id => authenticated<void>(`/governance/requests/${encodeURIComponent(id)}`, "DELETE"),
      review: (id, decision, reason) => authenticated<void>(`/governance/admin/requests/${encodeURIComponent(id)}/review`, "POST", { decision, reason }),
      async leave() { await familyRead("/leave", "POST"); clearSelection(); },
      async transfer(memberId) { await familyRead(`/owner/${encodeURIComponent(memberId)}`, "POST"); },
    },
    uploads: createUploadService(familyRead, () => `${storageKey}:${selection.familyId}:${selection.childId}:${revision}`),
    exports: createExportService(familyRead, (id, secret) => authenticated<void>("/export-browser/confirm", "POST", { id, secret, familyId: selection.familyId }),
      () => `${storageKey}:${selection.familyId}:${revision}`),
    systemAdmin: {
      quota: (familyId) => authenticated(`/admin/families/${encodeURIComponent(familyId)}/storage`),
      setQuota: (familyId, quotaBytes, reason) => authenticated(`/admin/families/${encodeURIComponent(familyId)}/storage`, "PUT", { quotaBytes, reason }),
      listMembers: (familyId, page) => authenticated(`/admin/families/${encodeURIComponent(familyId)}/members?page=${page}&pageSize=20`),
      audits: (page, filter) => {
        const params = ["familyId", "actorId", "action"] as const;
        const query = params.filter(key => filter[key]).map(key => `${key}=${encodeURIComponent(filter[key]!)}`).join("&");
        return authenticated(`/admin/audit-logs?page=${page}&pageSize=20${query ? `&${query}` : ""}`);
      },
      failedTasks: (kind, page) => authenticated(`/admin/failed-tasks?kind=${encodeURIComponent(kind)}&page=${page}&pageSize=20`),
      retryMedia: (id, reason) => authenticated(`/admin/failed-tasks/media/${encodeURIComponent(id)}/retry`, "PUT", { reason }),
      listFamilies: (page) => authenticated(`/admin/families?page=${page}&pageSize=20`),
      listUsers: (page) => authenticated(`/admin/users?page=${page}&pageSize=20`),
      approveFamilyCreation: (userId, reason) => authenticated<{ userId: string; canCreate: boolean }>(
        `/admin/users/${encodeURIComponent(userId)}/family-creation`, "PUT", { reason }),
      getDashboard: () => authenticated<SystemAdminDashboard>("/admin/dashboard"), updateMemberRole: (familyId, memberId, role, reason) => authenticated<FamilyMember>(
        `/admin/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(memberId)}`, "PUT", { role, reason }),
      removeMember: (familyId, memberId, reason) => authenticated<void>(
        `/admin/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(memberId)}`, "DELETE", { reason }),
    },
  };
  return services;
}

