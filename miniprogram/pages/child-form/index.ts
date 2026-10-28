import { services } from "../../services/index";
import { ApiError } from "../../services/http-services";
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
    ready: false,
    error: "",
  },

  async onLoad(options: Record<string, string>) {
    this.setData({ id: options.id || "" });
    await this.load();
  },

  async load() {
    this.setData({ ready: false, error: "" });
    try {
      const session = await services.auth.getSession();
      if (!["OWNER", "ADMIN"].includes(session.membership.role)) throw new Error("只有家庭管理员可以维护宝宝档案");
      if (!this.data.id) { this.setData({ ready: true }); return; }
      const child = await services.children.get(this.data.id);
      this.setData({
        id: child.id,
        name: child.name,
        nameInitial: child.name.slice(0, 1) || "宝",
        birthday: child.birthday,
        genderLabel: child.genderLabel,
        avatarColor: child.avatarColor,
      });
      wx.setNavigationBarTitle({ title: "编辑宝宝档案" });
      this.setData({ ready: true });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
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
    if (this.data.saving || !this.data.ready) {
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
      this.setData({ ready: false });
      wx.showToast({ title: "档案已保存", icon: "success" });
      setTimeout(() => wx.navigateBack(), 450);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "保存失败" });
      if (error instanceof ApiError && [0, 401, 403, 404].includes(error.status)) this.setData({ ready: false });
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        this.setData({ name: "", nameInitial: "宝", birthday: "", genderLabel: "" });
      }
    } finally {
      this.setData({ saving: false });
    }
  },
});
