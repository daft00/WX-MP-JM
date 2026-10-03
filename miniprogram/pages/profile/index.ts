import { services } from "../../services/index";
import { Child, FamilyMember, Invite, Session } from "../../types/models";
import { calculateAge, formatDateTime } from "../../utils/date";

interface SessionView extends Session {
  userId: string;
  roleLabel: string;
  active: boolean;
}

interface ChildView extends Child {
  ageLabel: string;
  initial: string;
}

interface MemberView extends FamilyMember {
  roleLabel: string;
  canManage: boolean;
}

Page({
  data: {
    session: null as Session | null,
    sessions: [] as SessionView[],
    children: [] as ChildView[],
    members: [] as MemberView[],
    latestInvite: null as (Invite & { expiresLabel: string }) | null,
    isAdmin: false,
  },

  async onShow() {
    await this.loadProfile();
  },

  roleLabel(role: string): string {
    const labels: Record<string, string> = { OWNER: "家庭创建者", ADMIN: "管理员", MEMBER: "家庭成员" };
    return labels[role] || role;
  },

  async loadProfile() {
    try {
      const [session, sessions, children, members] = await Promise.all([
        services.auth.getSession(),
        services.auth.listPrototypeSessions(),
        services.children.list(),
        services.family.listMembers(),
      ]);
      this.setData({
        session,
        sessions: sessions.map((item) => ({
          ...item,
          userId: item.user.id,
          roleLabel: this.roleLabel(item.membership.role),
          active: item.user.id === session.user.id,
        })),
        children: children.map((child) => ({
          ...child,
          ageLabel: calculateAge(child.birthday),
          initial: child.name.slice(0, 1),
        })),
        members: members.map((member) => ({
          ...member,
          roleLabel: this.roleLabel(member.role),
          canManage: member.userId !== session.user.id
            && member.role !== "OWNER"
            && (session.membership.role === "OWNER"
              || (session.membership.role === "ADMIN" && member.role === "MEMBER")),
        })),
        isAdmin: session.membership.role === "OWNER" || session.membership.role === "ADMIN",
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
    }
  },

  async switchUser(event: WechatMiniprogram.TouchEvent) {
    const userId = event.currentTarget.dataset.id as string;
    try {
      await services.auth.switchPrototypeUser(userId);
      wx.showToast({ title: "演示身份已切换", icon: "success" });
      await this.loadProfile();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "切换失败", icon: "none" });
    }
  },

  addChild() {
    wx.navigateTo({ url: "/pages/child-form/index" });
  },

  editChild(event: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/child-form/index?id=${event.currentTarget.dataset.id}` });
  },

  async createInvite() {
    try {
      const invite = await services.family.createInvite();
      this.setData({ latestInvite: { ...invite, expiresLabel: formatDateTime(invite.expiresAt) } });
      wx.showToast({ title: "邀请已生成", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "生成失败", icon: "none" });
    }
  },

  copyInvite() {
    if (this.data.latestInvite) {
      wx.setClipboardData({ data: this.data.latestInvite.code });
    }
  },

  manageMember(event: WechatMiniprogram.TouchEvent) {
    const member = this.data.members.find((item) => item.id === event.currentTarget.dataset.id);
    const session = this.data.session;
    if (!member || !member.canManage || !session) return;

    const canChangeRole = session.membership.role === "OWNER";
    const roleAction = member.role === "ADMIN" ? "设为普通成员" : "设为管理员";
    const itemList = canChangeRole ? [roleAction, "移除成员"] : ["移除成员"];
    wx.showActionSheet({
      itemList,
      success: async (result) => {
        if (canChangeRole && result.tapIndex === 0) {
          try {
            await services.family.updateMemberRole(member.id, member.role === "ADMIN" ? "MEMBER" : "ADMIN");
            wx.showToast({ title: "角色已更新", icon: "success" });
            await this.loadProfile();
          } catch (error) {
            wx.showToast({ title: error instanceof Error ? error.message : "调整失败", icon: "none" });
          }
          return;
        }
        const removeIndex = canChangeRole ? 1 : 0;
        if (result.tapIndex === removeIndex) this.confirmRemoveMember(member);
      },
    });
  },

  confirmRemoveMember(member: MemberView) {
    wx.showModal({
      title: `移除${member.user.nickname}？`,
      content: "移除后，该成员将不能查看这个家庭的宝宝照片和记录。",
      confirmText: "确认移除",
      confirmColor: "#BD5353",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await services.family.removeMember(member.id);
          wx.showToast({ title: "成员已移除", icon: "success" });
          await this.loadProfile();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "移除失败", icon: "none" });
        }
      },
    });
  },

  openExport() {
    wx.navigateTo({ url: "/pages/export/index" });
  },

  resetData() {
    wx.showModal({
      title: "重置全部演示数据？",
      content: "你在原型中新增的宝宝、记录、素材引用和导出状态都会被清除。",
      confirmText: "确认重置",
      confirmColor: "#BD5353",
      success: async (result) => {
        if (!result.confirm) {
          return;
        }
        await services.auth.resetPrototypeData();
        wx.removeStorageSync("growth_diary_edit_entry_id");
        wx.showToast({ title: "演示数据已重置", icon: "success" });
        setTimeout(() => wx.reLaunch({ url: "/pages/select-family/index" }), 450);
      },
    });
  },
});
