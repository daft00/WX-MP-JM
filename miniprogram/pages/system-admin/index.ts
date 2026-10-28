import { services } from "../../services/index";
import { ApiError } from "../../services/http-services";
import { SystemAdminDashboard } from "../../types/models";

import { AuditFilter, FailedTask, FailedTaskKind, StorageQuota } from "../../services/contracts";
import { confirmAction, promptText } from "../../utils/dialog";

interface ListRow { id: string; name: string; detail: string; guidance?: string; canRetry?: boolean; role?: string; canManage?: boolean }
function taskView(task: FailedTask): ListRow {
  const advice: Record<string, string> = {
    INVALID_MEDIA: "媒体格式或大小复核失败，系统清理后请上传者重新上传。",
    SNAPSHOT_CHANGED: "记录已变化，请家庭管理员按最新内容重新创建导出。",
    PERMISSION_REVOKED: "原创建者权限已变化，请当前家庭管理员重新创建导出。",
    RETRY_EXHAUSTED: "自动尝试次数已用尽；排查存储与worker后，由家庭管理员重新创建导出。",
    STORAGE_UNAVAILABLE: "请配置并启用对象存储，删除worker会继续处理。",
    LEGACY_MEDIA_REQUIRES_REVIEW: "历史媒体对象路径需要人工核查，不可强制跳过。",
    MEDIA_LEDGER_REQUIRES_REVIEW: "存储账本需要人工核对，不可手工标记删除完成。",
    WAITING_UPLOAD_EXPIRY: "等待上传凭证过期及保护期结束。",
  };
  const fallback = task.kind === "EXPORT"
    ? (task.status === "FAILED" ? "检查存储与导出worker，旧任务清理后由家庭管理员重新创建导出。" : "系统仍在重试或清理，请检查导出worker并刷新状态。")
    : "原有worker会自动重试；长期不恢复时检查存储配置和worker运行状态。";
  return { id: task.id, name: `${{ MEDIA: "媒体任务", EXPORT: "导出任务", DELETION: "删除任务" }[task.kind]} · ${task.status}`,
    detail: `家庭：${task.familyId} · 错误：${task.error} · 状态更新：${task.updatedAt}` +
      (task.attempts === null ? "" : ` · 已尝试 ${task.attempts} 次`) +
      (task.nextAttemptAt ? ` · 下次调度时间：${task.nextAttemptAt}` : "") +
      (task.cleaned === null ? "" : ` · 导出文件${task.cleaned ? "已清理" : "待清理"}`),
    guidance: advice[task.error] || fallback, canRetry: task.canRetry };
}

Page({
  data: {
    dashboard: null as SystemAdminDashboard | null,
    loading: false,
    error: "",
    updatedAt: "",
    listKind: "families" as "families" | "users" | "members" | "audits" | "quota" | FailedTaskKind,
    rows: [] as ListRow[],
    listPage: 0,
    listLoading: false,
    listError: "",
    hasMore: false,
    retrying: false,
    actionMessage: "",
    actorId: "",
    memberFamilyId: "",
    memberFamilyName: "",
    auditFamily: "",
    auditActor: "",
    auditAction: "",
    quota: null as StorageQuota | null,
    quotaLines: [] as string[],
    quotaMiB: "",
  },
  requestVersion: 0,
  listVersion: 0,
  auditFilter: {} as AuditFilter,

  async onShow() { await this.loadDashboard(); },
  onHide() { this.clearDashboard(); },
  onUnload() { this.clearDashboard(); },

  clearDashboard() {
    // 离开页面后丢弃迟到响应，避免再次进入时展示旧账号的统计。
    this.requestVersion++;
    this.resetList();
    this.auditFilter = {};
    this.setData({ dashboard: null, loading: false, error: "", updatedAt: "", actorId: "",
      memberFamilyId: "", memberFamilyName: "", auditFamily: "", auditActor: "", auditAction: "", listKind: "families" });
  },

  async loadDashboard() {
    if (this.data.loading) return;
    this.resetList();
    const version = ++this.requestVersion;
    this.setData({ loading: true, dashboard: null, error: "", updatedAt: "" });
    try {
      const identity = await services.auth.getIdentity();
      if (version !== this.requestVersion) return;
      if (identity.user.systemRole !== "SYSTEM_ADMIN") throw new ApiError("仅系统管理员可访问管理中心", 403);
      const dashboard = await services.systemAdmin.getDashboard();
      if (version !== this.requestVersion) return;
      this.setData({ dashboard, actorId: identity.user.id, updatedAt: new Date().toLocaleTimeString() });
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.setData({ dashboard: null, error: error instanceof Error ? error.message : "管理中心加载失败，请重试" });
    } finally {
      if (version === this.requestVersion) this.setData({ loading: false });
    }
  },

  resetList() {
    this.listVersion++;
    this.setData({ rows: [], listPage: 0, listLoading: false, listError: "", hasMore: false, retrying: false, actionMessage: "", quota: null, quotaLines: [], quotaMiB: "" });
  },

  async chooseList(event: WechatMiniprogram.TouchEvent) {
    const kind = event.currentTarget.dataset.kind;
    if (!this.data.dashboard || !["families", "users", "audits", "MEDIA", "EXPORT", "DELETION"].includes(kind)) return;
    this.resetList();
    this.setData({ listKind: kind as typeof this.data.listKind });
    await this.loadList(1);
  },
  async refreshList() { await this.loadList(1); },
  async previousPage() { if (this.data.listPage > 1) await this.loadList(this.data.listPage - 1); },
  async nextPage() { if (this.data.hasMore) await this.loadList(this.data.listPage + 1); },
  async retryList() { await this.loadList(this.data.listPage || 1); },

  async loadList(page: number) {
    if (!this.data.dashboard || this.data.loading || this.data.listLoading || this.data.retrying) return;
    const version = ++this.listVersion;
    const kind = this.data.listKind;
    this.setData({ rows: [], listPage: page, listLoading: true, listError: "", hasMore: false, retrying: false, actionMessage: "", quota: null, quotaLines: [], quotaMiB: "" });
    try {
      if (kind === "quota") {
        const quota = await services.systemAdmin.quota(this.data.memberFamilyId);
        if (version === this.listVersion) this.showQuota(quota);
        return;
      }
      const result = kind === "families"
        ? await services.systemAdmin.listFamilies(page)
        : kind === "users" ? await services.systemAdmin.listUsers(page)
        : kind === "members" ? await services.systemAdmin.listMembers(this.data.memberFamilyId, page)
        : kind === "audits" ? await services.systemAdmin.audits(page, this.auditFilter)
        : await services.systemAdmin.failedTasks(kind, page);
      if (version !== this.listVersion) return;
      const rows = result.items.map(item => "kind" in item ? taskView(item)
        : "actorId" in item ? { id: item.id, name: item.action,
          detail: `时间：${item.createdAt} · 操作者：${item.actorId} · 家庭：${item.familyId || "无关联家庭"} · 目标：${item.targetType} / ${item.targetId || "无"}`,
          guidance: `原因：${item.reason}` }
        : "role" in item ? { id: item.id, name: item.user.nickname, role: item.role,
          detail: `${{ OWNER: "家庭创建者", ADMIN: "管理员", MEMBER: "普通成员" }[item.role]} · 用户ID：${item.userId} · 加入时间：${item.joinedAt}`,
          canManage: item.role !== "OWNER" && item.userId !== this.data.actorId }
        : "family" in item
        ? { id: item.family.id, name: item.family.name, detail: `创建者：${item.ownerName} · ${item.childCount} 位宝宝 · ${item.entryCount} 条记录 · ${item.assetCount} 个素材` }
        : { id: item.user.id, name: item.user.nickname, detail: `${item.user.systemRole === "SYSTEM_ADMIN" ? "系统管理员" : "普通用户"} · 加入 ${item.familyCount} 个家庭 · 发布 ${item.entryCount} 条记录` });
      this.setData({ rows, listPage: result.page, hasMore: result.hasMore });
    } catch (error) {
      if (version !== this.listVersion) return;
      if (error instanceof ApiError && [401, 403, 428].includes(error.status)) {
        this.clearDashboard();
        this.setData({ error: error.message });
        return;
      }
      this.setData({ listError: error instanceof Error ? error.message : "列表加载失败，请重试" });
    } finally {
      if (version === this.listVersion) this.setData({ listLoading: false });
    }
  },

  showQuota(quota: StorageQuota) {
    const remaining = Math.max(0, quota.quotaBytes - quota.usedBytes - quota.reservedBytes);
    const format = (n: number) => `${(n / 1048576).toFixed(2)} MiB（${n} 字节）`;
    this.setData({ quota, listPage: 0, quotaMiB: "", quotaLines: [
      `配额：${format(quota.quotaBytes)}`, `已用：${format(quota.usedBytes)}`,
      `预留：${format(quota.reservedBytes)}`, `剩余：${format(remaining)}`,
    ] });
  },
  async openQuota(event: WechatMiniprogram.TouchEvent) {
    if (this.data.listKind !== "families" || this.data.retrying) return;
    const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
    if (!row) return;
    this.resetList();
    this.setData({ listKind: "quota", memberFamilyId: row.id, memberFamilyName: row.name });
    await this.loadList(1);
  },
  quotaInput(event: WechatMiniprogram.Input) { this.setData({ quotaMiB: event.detail.value }); },
  async saveQuota() {
    if (this.data.listKind !== "quota" || !this.data.quota || this.data.retrying || this.data.listLoading) return;
    const value = this.data.quotaMiB.trim();
    const bytes = Number(value) * 1048576;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 1048576 || bytes > 1024 ** 4) {
      this.setData({ actionMessage: "请输入1–1048576之间的整数MiB（1024 MiB = 1 GiB）" }); return;
    }
    const current = this.data.quota;
    if (bytes < current.usedBytes + current.reservedBytes) {
      this.setData({ actionMessage: "新配额不能低于已用与预留空间之和" }); return;
    }
    if (bytes === current.quotaBytes) { this.setData({ actionMessage: "配额未变化" }); return; }
    const version = this.listVersion, familyId = this.data.memberFamilyId;
    this.setData({ retrying: true, actionMessage: "" });
    try {
      const reason = await promptText("调整家庭配额", "填写1–470字原因，将记录审计日志");
      if (version !== this.listVersion || reason === null) return;
      if (!reason || reason.length > 470) { this.setData({ actionMessage: "请输入1–470字的原因" }); return; }
      const confirmed = await confirmAction("确认调整配额", `家庭：${this.data.memberFamilyName}（${familyId}）。配额从 ${current.quotaBytes} 字节调整为 ${bytes} 字节（${value} MiB）。不会删除已有数据或启用存储；提高配额可能增加云存储费用。`);
      if (!confirmed || version !== this.listVersion) return;
      const quota = await services.systemAdmin.setQuota(familyId, bytes, reason);
      if (version !== this.listVersion) return;
      this.showQuota(quota);
      this.setData({ actionMessage: "配额已更新，已记录审计日志" });
    } catch (error) {
      if (version !== this.listVersion) return;
      if (error instanceof ApiError && [401, 403, 428].includes(error.status)) {
        this.clearDashboard(); this.setData({ error: error.message }); return;
      }
      this.setData({ quota: null, quotaLines: [], listPage: 0, actionMessage: `${error instanceof Error ? error.message : "操作结果未确认"}；请刷新配额后再操作` });
    } finally {
      if (version === this.listVersion) this.setData({ retrying: false });
    }
  },

  async openMembers(event: WechatMiniprogram.TouchEvent) {
    if (this.data.listKind !== "families" || this.data.retrying) return;
    const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
    if (!row) return;
    this.resetList();
    this.setData({ listKind: "members", memberFamilyId: row.id, memberFamilyName: row.name });
    await this.loadList(1);
  },

  auditInput(event: WechatMiniprogram.Input) {
    const field = event.currentTarget.dataset.field;
    if (["auditFamily", "auditActor", "auditAction"].includes(field)) this.setData({ [field]: event.detail.value });
  },
  async applyAuditFilter() {
    if (this.data.listKind !== "audits" || this.data.retrying) return;
    const familyId = this.data.auditFamily.trim(), actorId = this.data.auditActor.trim(), action = this.data.auditAction.trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if ((familyId && !uuid.test(familyId)) || (actorId && !uuid.test(actorId)) || (action && !/^[A-Z][A-Z0-9_]{0,79}$/.test(action))) {
      this.setData({ actionMessage: "家庭/操作者ID需为UUID v4，操作代码需为大写字母、数字或下划线（字母开头，最多80字符）" }); return;
    }
    this.resetList();
    this.auditFilter = { ...(familyId ? { familyId } : {}), ...(actorId ? { actorId } : {}), ...(action ? { action } : {}) };
    await this.loadList(1);
  },
  async clearAuditFilter() {
    this.setData({ auditFamily: "", auditActor: "", auditAction: "" });
    await this.applyAuditFilter();
  },

  async maintainMember(event: WechatMiniprogram.TouchEvent) {
    if (this.data.listKind !== "members" || this.data.retrying || this.data.listLoading) return;
    const row = this.data.rows.find(item => item.id === event.currentTarget.dataset.id);
    const action = event.currentTarget.dataset.action;
    if (!row?.canManage || !["role", "remove"].includes(action)) return;
    const familyId = this.data.memberFamilyId, version = this.listVersion;
    const role = row.role === "ADMIN" ? "MEMBER" : "ADMIN";
    const label = action === "remove" ? "移除成员" : role === "ADMIN" ? "设为管理员" : "设为普通成员";
    this.setData({ retrying: true, actionMessage: "" });
    try {
      const reason = await promptText(label, "填写操作原因（1–400字，将记录在审计日志中）");
      if (version !== this.listVersion || reason === null) return;
      if (!reason || reason.length > 400) { this.setData({ actionMessage: "请输入1–400字的原因" }); return; }
      const confirmed = await confirmAction(label, `家庭：${this.data.memberFamilyName}；成员：${row.name}；成员ID：${row.id}。` +
        (action === "remove" ? "移除后不能访问该家庭；已有记录保留，已下载文件不会被撤回。" : role === "ADMIN" ? "该成员将获得家庭内容和成员管理权限。" : "该成员将失去家庭管理权限，已有邀请码将失效。"));
      if (!confirmed || version !== this.listVersion) return;
      if (action === "remove") await services.systemAdmin.removeMember(familyId, row.id, reason);
      else await services.systemAdmin.updateMemberRole(familyId, row.id, role, reason);
      if (version !== this.listVersion) return;
      this.setData({ retrying: false });
      await this.loadList(1);
    } catch (error) {
      if (version !== this.listVersion) return;
      if (error instanceof ApiError && [401, 403, 428].includes(error.status)) {
        this.clearDashboard(); this.setData({ error: error.message }); return;
      }
      // 写入结果不确定时清空旧按钮，先刷新再决定是否重试。
      this.setData({ rows: [], hasMore: false, actionMessage: error instanceof Error ? error.message : "操作结果未确认，请刷新成员列表" });
    } finally {
      if (version === this.listVersion) this.setData({ retrying: false });
    }
  },

  async retryTask(event: WechatMiniprogram.TouchEvent) {
    if (this.data.retrying || this.data.listLoading || this.data.listKind !== "MEDIA") return;
    const id = String(event.currentTarget.dataset.id);
    if (!this.data.rows.find(row => row.id === id)?.canRetry) return;
    const version = this.listVersion;
    this.setData({ retrying: true, actionMessage: "" });
    try {
      const reason = await promptText("重新排队媒体任务", "填写处理原因；仍由worker复核或清理，不会直接标记成功");
      if (version !== this.listVersion || reason === null) return;
      if (!reason || reason.length > 400) { this.setData({ actionMessage: "请输入1–400字的处理原因" }); return; }
      await services.systemAdmin.retryMedia(id, reason);
      if (version !== this.listVersion) return;
      this.setData({ rows: this.data.rows.map(row => row.id === id ? { ...row, canRetry: false } : row),
        actionMessage: "已重新排队，等待worker处理；请刷新查看结果。" });
    } catch (error) {
      if (version !== this.listVersion) return;
      if (error instanceof ApiError && [401, 403, 428].includes(error.status)) {
        this.clearDashboard(); this.setData({ error: error.message }); return;
      }
      this.setData({ actionMessage: error instanceof Error ? error.message : "操作失败，请先刷新确认状态" });
    } finally {
      if (version === this.listVersion) this.setData({ retrying: false });
    }
  },

  returnToFamilies() { wx.reLaunch({ url: "/pages/select-family/index" }); },
});
