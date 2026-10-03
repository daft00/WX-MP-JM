import { services } from "../../services/index";
import { Child, Family, Session, User } from "../../types/models";
import { calculateAge } from "../../utils/date";

interface FamilyCard extends Family {
  initial: string;
  color: string;
}

interface ChildCard extends Child {
  initial: string;
  ageLabel: string;
}

interface UserCard extends User {
  active: boolean;
}

Page({
  data: {
    step: "FAMILY" as "FAMILY" | "CHILD",
    session: null as Session | null,
    users: [] as UserCard[],
    families: [] as FamilyCard[],
    selectedFamily: null as Family | null,
    children: [] as ChildCard[],
    loading: true,
    isSystemAdmin: false,
  },

  async onLoad() {
    await services.family.clearSelection();
    await this.loadFamilies();
  },

  async onShow() {
    if (this.data.step === "CHILD" && this.data.selectedFamily) {
      await this.loadChildren();
    }
  },

  async loadFamilies() {
    this.setData({ loading: true });
    try {
      const [session, families, users] = await Promise.all([
        services.auth.getSession(),
        services.family.listAccessibleFamilies(),
        services.auth.listPrototypeUsers(),
      ]);
      const colors = ["#E98F72", "#7FA48B", "#D28FA2", "#8FA7CB"];
      this.setData({
        session,
        isSystemAdmin: session.user.systemRole === "SYSTEM_ADMIN",
        users: users.map((user) => ({ ...user, active: user.id === session.user.id })),
        families: families.map((family, index) => ({
          ...family,
          initial: family.name.slice(0, 1),
          color: colors[index % colors.length],
        })),
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "家庭加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async switchUser(event: WechatMiniprogram.TouchEvent) {
    try {
      await services.auth.switchPrototypeUser(event.currentTarget.dataset.id as string);
      await services.family.clearSelection();
      this.setData({ step: "FAMILY", selectedFamily: null, children: [] });
      await this.loadFamilies();
      wx.showToast({ title: "演示身份已切换", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "切换失败", icon: "none" });
    }
  },

  async chooseFamily(event: WechatMiniprogram.TouchEvent) {
    const familyId = event.currentTarget.dataset.id as string;
    try {
      const family = await services.family.selectFamily(familyId);
      this.setData({ selectedFamily: family, step: "CHILD" });
      await this.loadChildren();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "无法进入家庭", icon: "none" });
    }
  },

  async loadChildren() {
    try {
      const children = await services.children.list();
      this.setData({
        children: children.map((child) => ({
          ...child,
          initial: child.name.slice(0, 1),
          ageLabel: calculateAge(child.birthday),
        })),
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "宝宝档案加载失败", icon: "none" });
    }
  },

  async chooseChild(event: WechatMiniprogram.TouchEvent) {
    try {
      await services.family.selectChild(event.currentTarget.dataset.id as string);
      wx.switchTab({ url: "/pages/wall/index" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "无法选择宝宝", icon: "none" });
    }
  },

  backToFamilies() {
    this.setData({ step: "FAMILY", selectedFamily: null, children: [] });
  },

  addChild() {
    wx.navigateTo({ url: "/pages/child-form/index" });
  },

  createFamily() {
    wx.showModal({
      title: "创建家庭",
      content: "",
      editable: true,
      placeholderText: "请输入家庭名称（2-20字）",
      confirmText: "创建",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const family = await services.family.createFamily(result.content || "");
          this.setData({ selectedFamily: family, step: "CHILD", children: [] });
          await this.loadChildren();
          wx.showToast({ title: "家庭已创建", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "创建失败", icon: "none" });
        }
      },
    });
  },

  joinFamily() {
    wx.showModal({
      title: "加入家庭",
      content: "",
      editable: true,
      placeholderText: "请输入一次性邀请码",
      confirmText: "加入",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const family = await services.family.joinFamily(result.content || "");
          this.setData({ selectedFamily: family, step: "CHILD", children: [] });
          await this.loadChildren();
          wx.showToast({ title: "已加入家庭", icon: "success" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "加入失败", icon: "none" });
        }
      },
    });
  },

  openSystemAdmin() {
    wx.navigateTo({ url: "/pages/system-admin/index" });
  },
});
