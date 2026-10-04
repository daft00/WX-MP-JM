import { services } from "../../services/index";
import { LocalMediaFile } from "../../services/contracts";
import { Asset, Child, EntryKind, MetricType } from "../../types/models";
import { prepareMedia } from "../../services/media-policy";
import { today } from "../../utils/date";

function withSizeLabel(asset: Asset) {
  return { ...asset, sizeLabel: asset.sizeBytes ? `${(asset.sizeBytes / 1024 / 1024).toFixed(2)} MB` : "" };
}

Page({
  data: {
    editingId: "",
    children: [] as Child[],
    childIndex: 0,
    kind: "DIARY" as EntryKind,
    title: "",
    body: "",
    occurredAt: today(),
    assets: [] as ReturnType<typeof withSizeLabel>[],
    customEvent: "",
    metricType: "" as MetricType | "",
    metricValue: "",
    mediaBusy: false,
    processingMedia: false,
    mediaProgress: "",
    submitting: false,
    titleCount: 0,
    bodyCount: 0,
  },

  loadedEditingId: "",
  mediaCancelled: false,

  async onShow() {
    if (this.data.mediaBusy) return;
    const editingId = (wx.getStorageSync("growth_diary_edit_entry_id") as string) || "";
    const [children, selection] = await Promise.all([
      services.children.list(),
      services.family.getSelection(),
    ]);
    const activeChildIndex = Math.max(0, children.findIndex((child) => child.id === selection.childId));
    this.setData({ children, childIndex: activeChildIndex });
    if (editingId && editingId !== this.loadedEditingId) {
      await this.loadEntry(editingId, children);
      this.loadedEditingId = editingId;
      return;
    }
    if (!editingId && this.loadedEditingId) {
      this.resetForm(children);
      this.loadedEditingId = "";
    }
    if (!editingId) {
      const requestedKind = wx.getStorageSync("growth_diary_new_entry_kind") as EntryKind | "";
      const requestedChildId = wx.getStorageSync("growth_diary_new_entry_child_id") as string;
      if (requestedKind) {
        const childIndex = Math.max(0, children.findIndex((child) => child.id === requestedChildId));
        this.setData({ kind: requestedKind, childIndex });
        wx.removeStorageSync("growth_diary_new_entry_kind");
        wx.removeStorageSync("growth_diary_new_entry_child_id");
      }
    }
  },

  onTabItemTap() {
    if (!wx.getStorageSync("growth_diary_edit_entry_id") && this.loadedEditingId) {
      this.resetForm(this.data.children);
      this.loadedEditingId = "";
    }
  },

  async loadEntry(id: string, children: Child[]) {
    try {
      const entry = await services.entries.get(id);
      const assets = await services.uploads.getAssets(entry.assetIds);
      const childIndex = Math.max(0, children.findIndex((child) => child.id === entry.childId));
      this.setData({
        editingId: id,
        childIndex,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        occurredAt: entry.occurredAt,
        assets: assets.map(withSizeLabel),
        customEvent: entry.customEvent || "",
        metricType: entry.metric?.type || "",
        metricValue: entry.metric ? String(entry.metric.value) : "",
        titleCount: entry.title.length,
        bodyCount: entry.body.length,
      });
      wx.setNavigationBarTitle({ title: "编辑成长记录" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "记录加载失败", icon: "none" });
    }
  },

  resetForm(children: Child[]) {
    this.setData({
      editingId: "",
      children,
      childIndex: 0,
      kind: "DIARY",
      title: "",
      body: "",
      occurredAt: today(),
      assets: [],
      customEvent: "",
      metricType: "",
      metricValue: "",
      titleCount: 0,
      bodyCount: 0,
    });
    wx.setNavigationBarTitle({ title: "记录成长" });
  },

  selectKind(event: WechatMiniprogram.TouchEvent) {
    this.setData({ kind: event.currentTarget.dataset.kind as EntryKind });
  },

  changeChild(event: WechatMiniprogram.PickerChange) {
    if (this.data.mediaBusy) return;
    const childIndex = Number(event.detail.value);
    const child = this.data.children[childIndex];
    this.setData({ childIndex });
    if (child) {
      void services.family.selectChild(child.id);
    }
  },

  changeDate(event: WechatMiniprogram.PickerChange) {
    this.setData({ occurredAt: event.detail.value as string });
  },

  inputTitle(event: WechatMiniprogram.Input) {
    const title = event.detail.value;
    this.setData({ title, titleCount: title.length });
  },

  inputBody(event: WechatMiniprogram.Input) {
    const body = event.detail.value;
    this.setData({ body, bodyCount: body.length });
  },

  inputCustomEvent(event: WechatMiniprogram.Input) {
    this.setData({ customEvent: event.detail.value });
  },

  inputMetricValue(event: WechatMiniprogram.Input) {
    this.setData({ metricValue: event.detail.value });
  },

  selectMetric(event: WechatMiniprogram.TouchEvent) {
    const type = event.currentTarget.dataset.type as MetricType;
    this.setData({ metricType: this.data.metricType === type ? "" : type, metricValue: "" });
  },

  async chooseMedia() {
    if (this.data.mediaBusy || this.data.submitting) return;
    const child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: "请先创建宝宝档案", icon: "none" });
      return;
    }
    const remaining = 9 - this.data.assets.length;
    if (remaining <= 0) {
      wx.showToast({ title: "每条记录最多9个素材", icon: "none" });
      return;
    }
    this.mediaCancelled = false;
    this.setData({ mediaBusy: true });
    let prepared: Awaited<ReturnType<typeof prepareMedia>> | undefined;
    let keepPaths: string[] = [];
    try {
      const result = await wx.chooseMedia({
        count: remaining,
        mediaType: ["image", "video"],
        sizeType: ["original"],
        sourceType: ["album", "camera"],
        maxDuration: 60,
        camera: "back",
      });
      if (this.mediaCancelled) return;
      this.setData({ processingMedia: true });
      const files: LocalMediaFile[] = result.tempFiles.map((file) => ({
        tempFilePath: file.tempFilePath,
        size: file.size,
        fileType: (file.fileType || (file.thumbTempFilePath ? "video" : "image")) as "image" | "video",
        thumbTempFilePath: file.thumbTempFilePath,
      }));
      prepared = await prepareMedia(files, {
        cancelled: () => this.mediaCancelled,
        progress: (mediaProgress) => this.setData({ mediaProgress }),
        toJpeg: (path, edge, quality) => this.toJpeg(path, edge, quality),
      });
      if (this.mediaCancelled) return;
      this.setData({ processingMedia: false, mediaProgress: "正在保存素材" });
      const assets = await services.uploads.saveLocalMedia(child.id, prepared.files);
      keepPaths = assets.map((asset) => asset.localPath || "");
      this.setData({ assets: [...this.data.assets, ...assets.map(withSizeLabel)].slice(0, 9) });
      if (assets.some((asset) => asset.volatile)) {
        wx.showToast({ title: "部分大文件仅本次会话可预览", icon: "none" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : (error as { errMsg?: string } | null)?.errMsg || "素材处理失败，请更换文件重试";
      if (!message.includes("cancel") && !this.mediaCancelled) {
        wx.showToast({ title: message, icon: "none" });
      }
    } finally {
      await prepared?.dispose(keepPaths);
      this.setData({ mediaBusy: false, processingMedia: false, mediaProgress: "" });
    }
  },

  cancelMedia() {
    this.mediaCancelled = true;
    this.setData({ mediaProgress: "正在取消，请等待当前压缩结束" });
  },

  onHide() { if (this.data.processingMedia) this.cancelMedia(); },
  onUnload() { this.mediaCancelled = true; },

  previewAsset(event: WechatMiniprogram.TouchEvent) {
    if (this.data.mediaBusy) return;
    const asset = this.data.assets.find((item) => item.id === event.currentTarget.dataset.id);
    if (asset?.localPath) void wx.previewMedia({ sources: [{ url: asset.localPath, type: asset.kind === "VIDEO" ? "video" : "image", poster: asset.posterPath }] });
  },

  async toJpeg(path: string, edge: number, quality: number): Promise<string> {
    const info = await wx.getImageInfo({ src: path });
    const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
      wx.createSelectorQuery().in(this).select("#compression-canvas").fields({ node: true }).exec((results) => {
        if (results[0]?.node) resolve(results[0].node);
        else reject(new Error("当前设备不支持图片转换，请更换图片"));
      });
    });
    const scale = Math.min(1, edge / Math.max(info.width, info.height));
    canvas.width = Math.max(1, Math.round(info.width * scale));
    canvas.height = Math.max(1, Math.round(info.height * scale));
    try {
      const image = canvas.createImage();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片解码失败，请更换图片"));
        image.src = path;
      });
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = await wx.canvasToTempFilePath({ canvas, fileType: "jpg", quality, width: canvas.width, height: canvas.height, destWidth: canvas.width, destHeight: canvas.height });
      return result.tempFilePath;
    } finally { canvas.width = 1; canvas.height = 1; }
  },

  removeAsset(event: WechatMiniprogram.TouchEvent) {
    if (this.data.mediaBusy) return;
    const id = event.currentTarget.dataset.id as string;
    this.setData({ assets: this.data.assets.filter((asset) => asset.id !== id) });
  },

  async submit() {
    if (this.data.submitting || this.data.mediaBusy) {
      return;
    }
    const child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: "请先创建宝宝档案", icon: "none" });
      return;
    }
    if (!this.data.title.trim()) {
      wx.showToast({ title: "请填写记录标题", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      await services.entries.save({
        id: this.data.editingId || undefined,
        childId: child.id,
        kind: this.data.kind,
        title: this.data.title,
        body: this.data.body,
        occurredAt: this.data.occurredAt,
        assetIds: this.data.assets.map((asset) => asset.id),
        customEvent: this.data.kind === "MILESTONE" ? this.data.customEvent : undefined,
        metricType:
          this.data.kind === "MILESTONE" && this.data.metricType ? this.data.metricType : undefined,
        metricValue:
          this.data.kind === "MILESTONE" && this.data.metricValue
            ? Number(this.data.metricValue)
            : undefined,
      });
      wx.removeStorageSync("growth_diary_edit_entry_id");
      this.loadedEditingId = "";
      wx.showToast({ title: this.data.editingId ? "修改已保存" : "成长已记录", icon: "success" });
      this.resetForm(this.data.children);
      setTimeout(() => wx.switchTab({ url: "/pages/wall/index" }), 500);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
