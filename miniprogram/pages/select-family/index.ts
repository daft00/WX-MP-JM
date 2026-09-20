import { services } from "../../services/index";
import { Child, Family, Session } from "../../types/models";
import { calculateAge } from "../../utils/date";

interface FamilyCard extends Family {
  initial: string;
  color: string;
}

interface ChildCard extends Child {
  initial: string;
  ageLabel: string;
}

Page({
  data: {
    step: "FAMILY" as "FAMILY" | "CHILD",
    session: null as Session | null,
    families: [] as FamilyCard[],
    selectedFamily: null as Family | null,
    children: [] as ChildCard[],
    loading: true,
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
      const [session, families] = await Promise.all([
        services.auth.getSession(),
        services.family.listAccessibleFamilies(),
      ]);
      const colors = ["#E98F72", "#7FA48B", "#D28FA2", "#8FA7CB"];
      this.setData({
        session,
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
    wx.showToast({ title: "创建家庭将在后续版本开放", icon: "none" });
  },
});
