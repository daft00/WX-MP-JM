import { services } from "../../services/index";
import { ChildDraft } from "../../types/models";
import { today } from "../../utils/date";

Page({
  data: {
    id: "",
    name: "",
    nameInitial: "宝",
    birthday: today(),
    maxDate: today(),
    genderLabel: "宝宝",
    avatarColor: "#F0A58A",
    colors: ["#F0A58A", "#D991A2", "#87AAA0", "#D9AE72", "#8FA7CB"],
    saving: false,
  },

  async onLoad(options: Record<string, string>) {
    if (!options.id) {
      return;
    }
    try {
      const child = await services.children.get(options.id);
      this.setData({
        id: child.id,
        name: child.name,
        nameInitial: child.name.slice(0, 1) || "宝",
        birthday: child.birthday,
        genderLabel: child.genderLabel,
        avatarColor: child.avatarColor,
      });
      wx.setNavigationBarTitle({ title: "编辑宝宝档案" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
    }
  },

  inputName(event: WechatMiniprogram.Input) {
    const name = event.detail.value;
    this.setData({ name, nameInitial: name.slice(0, 1) || "宝" });
  },

  inputGender(event: WechatMiniprogram.Input) {
    this.setData({ genderLabel: event.detail.value });
  },

  changeBirthday(event: WechatMiniprogram.PickerChange) {
    this.setData({ birthday: event.detail.value as string });
  },

  chooseColor(event: WechatMiniprogram.TouchEvent) {
    this.setData({ avatarColor: event.currentTarget.dataset.color as string });
  },

  async save() {
    if (this.data.saving) {
      return;
    }
    const draft: ChildDraft = {
      id: this.data.id || undefined,
      name: this.data.name,
      birthday: this.data.birthday,
      genderLabel: this.data.genderLabel,
      avatarColor: this.data.avatarColor,
    };
    this.setData({ saving: true });
    try {
      await services.children.save(draft);
      wx.showToast({ title: "档案已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 450);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  },
});
