import { services } from "../../services/index";
import { Asset, Entry } from "../../types/models";
import { calculateAge, formatDate } from "../../utils/date";

Page({
  data: {
    entry: null as Entry | null,
    assets: [] as Asset[],
    childName: "",
    childColor: "#F0A58A",
    childInitial: "宝",
    ageLabel: "",
    authorName: "",
    dateLabel: "",
    metricLabel: "",
    canEdit: false,
    canDelete: false,
    loading: true,
  },

  entryId: "",

  onLoad(options: Record<string, string>) {
    this.entryId = options.id || "";
  },

  async onShow() {
    if (this.entryId) {
      await this.loadEntry();
    }
  },

  async loadEntry() {
    this.setData({ loading: true });
    try {
      const entry = await services.entries.get(this.entryId);
      const [children, members, assets, canEdit, canDelete] = await Promise.all([
        services.children.list(),
        services.family.listMembers(),
        services.uploads.getAssets(entry.assetIds),
        services.entries.canEdit(entry),
        services.entries.canDelete(),
      ]);
      const child = children.find((item) => item.id === entry.childId);
      const member = members.find((item) => item.userId === entry.creatorId);
      const metricNames: Record<string, string> = { HEIGHT: "身高", WEIGHT: "体重", HEAD: "头围" };
      this.setData({
        entry,
        assets,
        childName: child?.name || "宝宝",
        childColor: child?.avatarColor || "#F0A58A",
        childInitial: (child?.name || "宝").slice(0, 1),
        ageLabel: child ? calculateAge(child.birthday, entry.occurredAt) : "",
        authorName: member?.user.nickname || "家人",
        dateLabel: formatDate(entry.occurredAt),
        metricLabel: entry.metric
          ? `${metricNames[entry.metric.type]} ${entry.metric.value}${entry.metric.unit}`
          : "",
        canEdit,
        canDelete,
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  previewImage(event: WechatMiniprogram.TouchEvent) {
    const current = event.currentTarget.dataset.path as string;
    const urls = this.data.assets
      .filter((asset) => asset.kind === "IMAGE" && asset.localPath)
      .map((asset) => asset.localPath as string);
    if (current && urls.length) {
      wx.previewImage({ current, urls });
    }
  },

  editEntry() {
    wx.setStorageSync("growth_diary_edit_entry_id", this.entryId);
    wx.switchTab({ url: "/pages/publish/index" });
  },

  deleteEntry() {
    wx.showModal({
      title: "永久删除这条记录？",
      content: "删除后记录和关联媒体会立即移除，原型不提供回收站，也无法恢复。",
      confirmText: "永久删除",
      confirmColor: "#BD5353",
      success: async (result) => {
        if (!result.confirm) {
          return;
        }
        try {
          await services.entries.deletePermanent(this.entryId);
          wx.showToast({ title: "已永久删除", icon: "success" });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "删除失败", icon: "none" });
        }
      },
    });
  },
});
