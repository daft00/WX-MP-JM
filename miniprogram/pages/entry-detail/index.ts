import { ApiError } from "../../services/http-services";
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
    deleting: false,
    error: "",
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
    this.setData({ loading: true, error: "", entry: null, assets: [], canEdit: false, canDelete: false });
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
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
      if (error instanceof ApiError && error.status === 401) wx.reLaunch({ url: "/pages/select-family/index" });
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
    if (this.data.deleting || !this.data.canDelete) return;
    this.setData({ deleting: true });
    wx.showModal({
      title: "永久删除这条记录？",
      content: "记录会立即移除且无法撤销。后台会清理关联媒体和该宝宝的历史导出包；已下载副本无法收回，备份按保存周期到期清理。可在数据处理页查看完成状态。",
      confirmText: "永久删除",
      confirmColor: "#BD5353",
      fail: () => this.setData({ deleting: false }),
      success: async (result) => {
        if (!result.confirm) {
          this.setData({ deleting: false });
          return;
        }
        try {
          await services.entries.deletePermanent(this.entryId);
          wx.showToast({ title: "已移除，清理中", icon: "none" });
          wx.navigateBack();
        } catch (error) {
          this.setData({ deleting: false, error: error instanceof Error ? error.message : "删除失败，请刷新确认结果" });
        }
      },
    });
  },
  requestDeletion() {
    if (!this.data.canDelete || !this.data.entry) return;
    wx.navigateTo({ url: `/pages/governance/index?entryId=${encodeURIComponent(this.entryId)}&familyId=${encodeURIComponent(this.data.entry.familyId)}` });
  },
});
