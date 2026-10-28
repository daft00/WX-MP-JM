import { apiConfig, services } from "../../services/index";
import { ApiError } from "../../services/http-services";
import { Child, Family, FamilyMember, IdentitySession } from "../../types/models";
import { confirmAction, promptText } from "../../utils/dialog";
import { calculateAge } from "../../utils/date";

Page({
  data: {
    contentTop: 88,
    session: null as IdentitySession | null,
    families: [] as Family[],
    selectedFamily: null as Family | null,
    children: [] as (Child & { ageLabel: string })[],
    selectedChild: null as Child | null,
    loading: false,
    error: "",
    canCreate: false,
    members: [] as FamilyMember[],
    role: "",
    inviteCode: "",
    development: apiConfig.development,
  },

  async onLoad() {
    this.updateContentTop();
    await services.family.clearSelection();
    if (services.auth.hasSession()) await this.loadFamilies();
  },

  openSystemAdmin() {
    if (!this.data.loading && this.data.session?.user.systemRole === "SYSTEM_ADMIN") {
      wx.navigateTo({ url: "/pages/system-admin/index" });
    }
  },

  openGovernance() { wx.navigateTo({ url: "/pages/governance/index" }); },
  async leaveFamily() {
    if (!this.data.selectedFamily || this.data.loading) return;
    const answer = await confirmAction("退出家庭", "退出后将无法访问该家庭的记录；共享内容保留，已下载文件不会被撤回。");
    if (!answer) return;
    try { await services.governance.leave(); await this.loadFamilies(); } catch (e) { await this.showError(e); }
  },
  async transferOwner(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    const target = this.data.members.find(m => m.id === id);
    if (!target || this.data.role !== "OWNER") return;
    const answer = await confirmAction("转让家庭所有权", `确认转让给“${target.user.nickname}”？你将成为管理员，不能自行恢复所有者身份。`);
    if (!answer) return;
    try { await services.governance.transfer(id); await this.loadFamily(this.data.selectedFamily!.id); } catch (e) { await this.showError(e); }
  },

  onResize() { this.updateContentTop(); },

  async onShow() {
    if (this.data.selectedFamily && !this.data.loading) await this.loadFamily(this.data.selectedFamily.id);
  },

  updateContentTop() {
    const windowInfo = wx.getWindowInfo();
    const statusBarHeight = Math.max(windowInfo.statusBarHeight || 0, windowInfo.safeArea?.top || 0);
    const menu = wx.getMenuButtonBoundingClientRect();
    const contentTop = menu.height > 0 && menu.top >= statusBarHeight
      ? Math.max(statusBarHeight + 44, menu.bottom + (menu.top - statusBarHeight))
      : statusBarHeight + 44;
    this.setData({ contentTop });
  },

  async showError(error: unknown) {
    const selection = await services.family.getSelection();
    this.setData({ error: error instanceof Error ? error.message : "加载失败，请重试" });
    if (!selection.familyId) this.setData({ selectedFamily: null, children: [], selectedChild: null, members: [], role: "", inviteCode: "" });
    if (error instanceof ApiError && error.status === 401) {
      this.setData({ session: null, families: [], selectedFamily: null, children: [], selectedChild: null, canCreate: false });
    }
  },

  async login() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "", session: null, families: [], children: [], selectedFamily: null, selectedChild: null });
    try {
      const session = await services.auth.login();
      this.setData({ session });
      const families = await services.family.listAccessibleFamilies();
      this.setData({ families });
      this.setData(await services.family.creationStatus());
    } catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
  },

  async loadFamilies() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "", families: [], selectedFamily: null, children: [], selectedChild: null, members: [], role: "", inviteCode: "", canCreate: false });
    await services.family.clearSelection();
    try {
      const session = await services.auth.getIdentity();
      this.setData({ session });
      const families = await services.family.listAccessibleFamilies();
      this.setData({ families });
      this.setData(await services.family.creationStatus());
    } catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
  },

  async chooseFamily(event: WechatMiniprogram.TouchEvent) {
    await this.loadFamily(event.currentTarget.dataset.id as string);
  },

  async loadFamily(id: string) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "", selectedFamily: null, children: [], selectedChild: null, members: [], role: "", inviteCode: "" });
    try {
      const selectedFamily = await services.family.selectFamily(id);
      this.setData({ selectedFamily });
      const members = await services.family.listMembers();
      this.setData({ members, role: members.find((member) => member.userId === this.data.session?.user.id)?.role || "" });
      const children = await services.children.list();
      this.setData({ children: children.map((child) => ({ ...child, ageLabel: calculateAge(child.birthday) })) });
    } catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
  },

  async chooseChild(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "", selectedChild: null });
    try {
      const selectedChild = await services.family.selectChild(event.currentTarget.dataset.id as string);
      this.setData({ selectedChild });
    } catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
  },

  async retry() {
    if (this.data.selectedFamily) {
      await this.loadFamily(this.data.selectedFamily.id);
    } else if (services.auth.hasSession()) await this.loadFamilies();
    else await this.login();
  },

  async logout() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "", session: null, families: [], selectedFamily: null, children: [], selectedChild: null, members: [], role: "", inviteCode: "", canCreate: false });
    try { await services.auth.logout(); }
    catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
  },

  enterWall() {
    if (this.data.selectedChild && !this.data.loading) wx.switchTab({ url: "/pages/wall/index" });
  },

  copyUserId() {
    if (this.data.session) wx.setClipboardData({ data: this.data.session.user.id });
  },

  editChild(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading || !["OWNER", "ADMIN"].includes(this.data.role)) return;
    const id = event.currentTarget.dataset.id as string | undefined;
    wx.navigateTo({ url: `/pages/child-form/index${id ? `?id=${encodeURIComponent(id)}` : ""}` });
  },

  async writeAction(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });
    const action = event.currentTarget.dataset.action as string;
    let refresh = false;
    try {
      if (action === "nickname") {
        const nickname = await promptText("修改昵称", "1–40字");
        if (nickname === null) return;
        this.setData({ session: await services.auth.updateNickname(nickname) });
      } else if (action === "create" || action === "join") {
        const value = await promptText(action === "create" ? "创建家庭" : "加入家庭", action === "create" ? "家庭名称（2–20字）" : "16位一次性邀请码");
        if (value === null) return;
        if (action === "create") await services.family.createFamily(value);
        else await services.family.joinFamily(value);
        refresh = true;
      } else if (action === "approve") {
        const id = await promptText("批准开户资格", "粘贴待批准用户UUID");
        if (id === null) return;
        const reason = await promptText("审批理由", "说明核实身份及批准原因");
        if (reason === null) return;
        if (!reason || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error("请输入有效用户UUID和审批理由");
        if (!await confirmAction("确认批准", `用户：${id}\n理由：${reason}\n批准后可创建一个家庭。`)) return;
        await services.systemAdmin.approveFamilyCreation(id, reason);
        refresh = true;
      } else if (action === "invite") {
        const invite = await services.family.createInvite();
        this.setData({ inviteCode: invite.code });
      } else if (action === "role" || action === "remove") {
        const member = this.data.members.find((item) => item.id === event.currentTarget.dataset.id);
        if (!member) throw new Error("请刷新成员列表");
        const role = member.role === "ADMIN" ? "MEMBER" : "ADMIN";
        if (!await confirmAction("确认成员操作", `${member.user.nickname}：${action === "remove" ? "移出家庭（保留历史记录）" : `调整为${role}`}？`)) return;
        if (action === "remove") await services.family.removeMember(member.id);
        else await services.family.updateMemberRole(member.id, role);
        refresh = true;
      } else return;
      wx.showToast({ title: "操作成功", icon: "success" });
    } catch (error) { await this.showError(error); }
    finally { this.setData({ loading: false }); }
    if (refresh) await this.retry();
  },
});
