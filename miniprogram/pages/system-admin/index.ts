import { services } from "../../services/index";
import {
  FamilyMember,
  SystemAdminDashboard,
  SystemFamilyOverview,
} from "../../types/models";

interface AdminMemberView extends FamilyMember {
  roleLabel: string;
  canManage: boolean;
}

interface AdminFamilyView extends SystemFamilyOverview {
  id: string;
  members: AdminMemberView[];
}

Page({
  data: {
    dashboard: null as SystemAdminDashboard | null,
    families: [] as AdminFamilyView[],
    loading: true,
  },

  async onShow() {
    await this.loadDashboard();
  },

  roleLabel(role: string): string {
    return { OWNER: "家庭创建者", ADMIN: "管理员", MEMBER: "普通成员" }[role] || role;
  },

  async loadDashboard() {
    this.setData({ loading: true });
    try {
      const dashboard = await services.systemAdmin.getDashboard();
      this.setData({
        dashboard,
        families: dashboard.families.map((item) => ({
          ...item,
          id: item.family.id,
          members: item.members.map((member) => ({
            ...member,
            roleLabel: this.roleLabel(member.role),
            canManage: member.role !== "OWNER",
          })),
        })),
      });
    } catch (error) {
      wx.showModal({
        title: "无法访问",
        content: error instanceof Error ? error.message : "系统管理中心加载失败",
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  manageMember(event: WechatMiniprogram.TouchEvent) {
    const familyId = event.currentTarget.dataset.family as string;
    const memberId = event.currentTarget.dataset.member as string;
    const family = this.data.families.find((item) => item.family.id === familyId);
    const member = family?.members.find((item) => item.id === memberId);
    if (!member?.canManage) return;

    const roleAction = member.role === "ADMIN" ? "设为普通成员" : "设为管理员";
    wx.showActionSheet({
      itemList: [roleAction, "移除成员"],
      success: async (result) => {
        if (result.tapIndex === 0) {
          await this.updateRole(familyId, member);
        } else if (result.tapIndex === 1) {
          this.confirmRemove(familyId, member);
        }
      },
    });
  },

  async updateRole(familyId: string, member: AdminMemberView) {
    try {
      await services.systemAdmin.updateMemberRole(
        familyId,
        member.id,
        member.role === "ADMIN" ? "MEMBER" : "ADMIN",
      );
      wx.showToast({ title: "角色已更新", icon: "success" });
      await this.loadDashboard();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "调整失败", icon: "none" });
    }
  },

  confirmRemove(familyId: string, member: AdminMemberView) {
    wx.showModal({
      title: `从家庭移除${member.user.nickname}？`,
      content: "移除后，该用户将无法查看这个家庭的宝宝和记录。",
      confirmText: "确认移除",
      confirmColor: "#BD5353",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await services.systemAdmin.removeMember(familyId, member.id);
          wx.showToast({ title: "成员已移除", icon: "success" });
          await this.loadDashboard();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "移除失败", icon: "none" });
        }
      },
    });
  },
});
