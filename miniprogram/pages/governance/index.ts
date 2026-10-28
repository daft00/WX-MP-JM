import { services } from "../../services/index";
import { DataApplication, PolicyDocument } from "../../services/contracts";
import { confirmAction, promptText } from "../../utils/dialog";
import { createRequestId } from "../../services/entry-draft";

const statusLabels: Record<string, string> = { PENDING: "待审核", APPROVED: "已批准，等待本人确认", REJECTED: "已驳回", CANCELLED: "已撤销", PROCESSING: "处理中（不可撤销）", COMPLETED: "在线清理已完成" };
const progressLabels: Record<string, string> = { WAITING_UPLOAD_EXPIRY: "等待已签发上传权限到期", CLEANING_EXPORTS: "正在清理历史导出包", CLEANING_MEDIA: "正在清理媒体", CLEANUP_RETRY: "清理失败，后台将重试", STORAGE_UNAVAILABLE: "云存储尚未配置，请联系运营者", LEGACY_MEDIA_REQUIRES_REVIEW: "旧媒体路径需运营者核实", MEDIA_LEDGER_REQUIRES_REVIEW: "存储账本需运营者核实", RESUBMIT_WITH_EXPLICIT_TARGET: "旧申请范围不明确，请重新提交", FAMILY_DISSOLUTION: "已由家庭解散申请替代" };

Page({
  data: {
    document: null as PolicyDocument | null, loggedIn: false, isAdmin: false, adminView: false,
    agree: false, guardian: false, busy: false, error: "", page: 1, hasMore: false,
    requests: [] as (DataApplication & { statusLabel: string; kindLabel: string; progressLabel: string })[], kindIndex: 0,
    kinds: ["申请删除选定记录及媒体", "申请解散当前家庭"], targetLabel: "请从记录详情选择要删除的记录",
  },
  pending: null as { requestId: string; kind: string; reason: string; familyId: string; entryId?: string } | null,
  target: null as { familyId: string; entryId: string } | null,
  identityId: "",
  onLoad(options: Record<string, string>) {
    if (options.entryId && options.familyId) this.target = { entryId: options.entryId, familyId: options.familyId };
  },
  async onShow() { await this.load(); },
  async load() {
    try {
      const loggedIn = services.auth.hasSession();
      const document = loggedIn ? await services.governance.status() : await services.governance.documents();
      const identity = loggedIn ? await services.auth.getIdentity() : null;
      if (this.identityId && this.identityId !== identity?.user.id) {
        this.pending = null; this.target = null;
        this.setData({ targetLabel: "请从记录详情选择要删除的记录", adminView: false });
      }
      this.identityId = identity?.user.id || "";
      if (this.target && (await services.family.getSelection()).familyId === this.target.familyId) {
        try { const entry = await services.entries.get(this.target.entryId); this.setData({ targetLabel: `${entry.title || "无标题记录"} · ${entry.occurredAt}` }); }
        catch { this.target = null; this.setData({ targetLabel: "记录不可用，请重新从记录详情选择" }); }
      } else if (this.target) { this.target = null; this.setData({ targetLabel: "家庭选择已变化，请重新选择记录" }); }
      this.setData({ document, loggedIn, isAdmin: identity?.user.systemRole === "SYSTEM_ADMIN", agree: false, guardian: false, requests: [], page: 1, error: "" });
      if (loggedIn) await this.loadRequests();
    } catch (e) { this.setData({ requests: [], loggedIn: services.auth.hasSession(), error: e instanceof Error ? e.message : "加载失败" }); }
  },
  async login() { try { await services.auth.login(); await this.load(); } catch (e) { this.setData({ error: e instanceof Error ? e.message : "登录失败" }); } },
  checks(e: WechatMiniprogram.CheckboxGroupChange) { this.setData({ agree: e.detail.value.includes("agree"), guardian: e.detail.value.includes("guardian") }); },
  async accept() {
    if (this.data.busy || !this.data.agree || !this.data.guardian || !this.data.document?.ready) return;
    this.setData({ busy: true });
    try { await services.governance.accept(this.data.document.version); wx.reLaunch({ url: "/pages/select-family/index" }); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : "确认失败" }); }
    finally { this.setData({ busy: false }); }
  },
  async logout() { await services.auth.logout(); this.pending = null; wx.reLaunch({ url: "/pages/select-family/index" }); },
  changeKind(e: WechatMiniprogram.PickerChange) { if (!this.pending) this.setData({ kindIndex: Number(e.detail.value) }); },
  async submit() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      if (!this.pending) {
        const kind = ["DATA_DELETE", "FAMILY_DISSOLVE"][this.data.kindIndex];
        const selection = await services.family.getSelection();
        if (!selection.familyId) throw new Error("请先选择家庭");
        if (kind === "DATA_DELETE" && (!this.target || this.target.familyId !== selection.familyId)) throw new Error("请从记录详情选择要删除的记录");
        const family = await services.family.getCurrentFamily();
        if (!await confirmAction("确认申请范围", kind === "FAMILY_DISSOLVE" ? `申请解散「${family.name}」，将清理所有成员共享的宝宝档案、记录和媒体。审核通过后仍需你再次确认执行。` : `申请删除「${this.data.targetLabel}」及其媒体，不删除宝宝档案或其他记录。`)) return;
        const reason = await promptText(this.data.kinds[this.data.kindIndex], "填写申请理由，不要填写密码或密钥");
        if (!reason) return;
        this.pending = { requestId: await createRequestId(), kind, reason, familyId: selection.familyId,
          ...(kind === "DATA_DELETE" ? { entryId: this.target!.entryId } : {}) };
      }
      await services.governance.submit(this.pending); this.pending = null;
      this.setData({ adminView: false, page: 1 }); await this.loadRequests();
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : "提交失败，可重试同一申请" }); }
    finally { this.setData({ busy: false }); }
  },
  async loadRequests() {
    try {
      const result = await services.governance.list(this.data.page, this.data.adminView);
      this.setData({ requests: result.items.map(item => ({ ...item, statusLabel: statusLabels[item.status] || "未知状态，请联系运营者", kindLabel: item.kind === "DATA_DELETE" ? "删除单条记录" : item.kind === "FAMILY_DISSOLVE" ? "解散家庭" : "旧申请（已停用）", progressLabel: progressLabels[item.last_error || ""] || "" })), hasMore: result.hasMore });
    } catch (e) { this.setData({ requests: [], error: e instanceof Error ? e.message : "加载失败" }); }
  },
  async toggleAdmin() { this.setData({ adminView: !this.data.adminView, page: 1 }); await this.loadRequests(); },
  async nextPage() { this.setData({ page: this.data.page + 1 }); await this.loadRequests(); },
  async previousPage() { this.setData({ page: Math.max(1, this.data.page - 1) }); await this.loadRequests(); },
  async cancel(e: WechatMiniprogram.TouchEvent) {
    if (!await confirmAction("撤销申请", "尚未开始执行的申请可以撤销，不删除任何记录。")) return;
    try { await services.governance.cancel(String(e.currentTarget.dataset.id)); await this.loadRequests(); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : "撤销失败" }); }
  },
  async review(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const reason = await promptText("填写审核理由", "通过仅表示接受处理，不表示数据已删除");
    if (!reason) return;
    this.setData({ busy: true });
    try { await services.governance.review(String(e.currentTarget.dataset.id), String(e.currentTarget.dataset.decision), reason); await this.loadRequests(); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : "审核失败" }); }
    finally { this.setData({ busy: false }); }
  },
  async execute(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const request = this.data.requests.find(r => r.id === String(e.currentTarget.dataset.id));
    if (!request || request.status !== "APPROVED" || this.data.adminView) return;
    this.setData({ busy: true, error: "" });
    try {
      const family = (await services.family.listAccessibleFamilies()).find(f => f.id === request.target_family_id);
      if (!family) throw new Error("该家庭已不可访问");
      const scope = request.kind === "FAMILY_DISSOLVE" ? `「${family.name}」的所有宝宝档案、记录和媒体` : `「${family.name}」中申请指定的单条记录及媒体`;
      if (!await confirmAction("开始不可撤销的删除？", `将清理${scope}，并作废相关历史导出包。开始后无法撤销；备份按保存周期清理。`)) return;
      await services.governance.execute(request.id);
      if (request.kind === "FAMILY_DISSOLVE") await services.family.clearSelection();
      await this.loadRequests();
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : "执行失败，请刷新状态后重试" }); }
    finally { this.setData({ busy: false }); }
  },
});
