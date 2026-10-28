import { services } from "../../services/index";
import { LocalMediaFile } from "../../services/contracts";
import { Asset, Child, EntryDraft, EntryKind, MetricType } from "../../types/models";
import { prepareMedia } from "../../services/media-policy";
import { ApiError } from "../../services/http-services";
import { createRequestId, ENTRY_DRAFT_KEY, StoredEntryDraft } from "../../services/entry-draft";
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
    ready: false,
    pending: false,
    error: "",
    mediaEnabled: false,
    storageLabel: "",
    linkedAssetIds: [] as string[],
    titleCount: 0,
    bodyCount: 0,
  },

  loadedEditingId: "",
  mediaCancelled: false,

  scope: "",
  revision: 0,
  pendingDraft: null as EntryDraft | null,

  async onShow() {
    if (this.data.mediaBusy) return;
    const version = ++this.revision;
    this.setData({ ready: false, error: "" });
    try {
      const session = await services.auth.getSession();
      const selection = await services.family.getSelection();
      const children = await services.children.list();
      if (version !== this.revision) return;
      const editingId = (wx.getStorageSync("growth_diary_edit_entry_id") as string) || "";
      const scope = `${session.user.id}:${session.family.id}:${selection.childId}:${editingId}`;
      if (!selection.childId || !children.some((child) => child.id === selection.childId)) throw new Error("请先选择宝宝");
      this.scope = scope;
      this.resetForm(children);
      this.setData({ childIndex: children.findIndex((child) => child.id === selection.childId), editingId });
      const saved = wx.getStorageSync(ENTRY_DRAFT_KEY) as StoredEntryDraft | undefined;
      if (editingId) {
        const entry = await services.entries.get(editingId);
        if (!await services.entries.canEdit(entry)) throw new Error("不能编辑其他成员的记录");
        if (version !== this.revision) return;
        this.applyDraft({ ...entry, metricType: entry.metric?.type, metricValue: entry.metric?.value });
      }
      if (saved?.scope === scope) {
        this.applyDraft(saved.draft);
        this.pendingDraft = saved.pending ? saved.draft : null;
        this.setData({ pending: saved.pending });
      } else {
        this.pendingDraft = null;
        wx.removeStorageSync(ENTRY_DRAFT_KEY);
      }
      if (!editingId && !saved && wx.getStorageSync("growth_diary_new_entry_kind") === "MILESTONE") this.setData({ kind: "MILESTONE" });
      wx.removeStorageSync("growth_diary_new_entry_kind");
      this.setData({ ready: true });
      try {
        const quota = await services.uploads.quota();
        if (version !== this.revision) return;
        this.setData({ mediaEnabled: quota.enabled, storageLabel: `已用 ${(quota.usedBytes / 1024 ** 3).toFixed(2)} GiB / ${(quota.quotaBytes / 1024 ** 3).toFixed(2)} GiB，预留 ${(quota.reservedBytes / 1024 ** 2).toFixed(1)} MiB` });
        if (quota.enabled && this.data.linkedAssetIds.length) {
          const assets = await services.uploads.getAssets(this.data.linkedAssetIds);
          if (version !== this.revision) return;
          this.setData({ assets: assets.map(withSizeLabel) });
        }
      } catch (error) {
        if (version !== this.revision) return;
        this.setData({ mediaEnabled: false, error: error instanceof Error ? error.message : "媒体加载失败，文字草稿已保留" });
      }
    } catch (error) {
      if (version !== this.revision) return;
      this.resetForm([]);
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    }
  },

  applyDraft(draft: EntryDraft) {
    this.setData({
      editingId: draft.id || "", childIndex: Math.max(0, this.data.children.findIndex((child) => child.id === draft.childId)),
      kind: draft.kind, title: draft.title, body: draft.body, occurredAt: draft.occurredAt,
      linkedAssetIds: draft.assetIds, customEvent: draft.customEvent || "",
      metricType: draft.metricType || "", metricValue: draft.metricValue === undefined ? "" : String(draft.metricValue),
      titleCount: draft.title.length, bodyCount: draft.body.length,
    });
  },

  currentDraft(): EntryDraft {
    return {
      id: this.data.editingId || undefined, childId: this.data.children[this.data.childIndex]?.id || "",
      kind: this.data.kind, title: this.data.title, body: this.data.body, occurredAt: this.data.occurredAt,
      assetIds: this.data.linkedAssetIds,
      customEvent: this.data.kind === "MILESTONE" ? this.data.customEvent : undefined,
      metricType: this.data.kind === "MILESTONE" && this.data.metricType ? this.data.metricType : undefined,
      metricValue: this.data.kind === "MILESTONE" && this.data.metricType && this.data.metricValue ? Number(this.data.metricValue) : undefined,
    };
  },

  saveDraft() {
    if (this.data.ready && this.scope) wx.setStorageSync(ENTRY_DRAFT_KEY, {
      scope: this.scope, draft: this.pendingDraft || this.currentDraft(), pending: Boolean(this.pendingDraft),
    } as StoredEntryDraft);
  },

  resetForm(children: Child[]) {
    this.setData({
      editingId: "",
      pending: false,
      linkedAssetIds: [],
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
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    this.setData({ kind: event.currentTarget.dataset.kind as EntryKind });
    this.saveDraft();
  },

  changeChild(event: WechatMiniprogram.PickerChange) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    if (this.data.mediaBusy) return;
    const childIndex = Number(event.detail.value);
    const child = this.data.children[childIndex];
    this.setData({ childIndex });
    if (child) {
      void services.family.selectChild(child.id);
    }
  },

  changeDate(event: WechatMiniprogram.PickerChange) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    this.setData({ occurredAt: event.detail.value as string });
    this.saveDraft();
  },

  inputTitle(event: WechatMiniprogram.Input) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    const title = event.detail.value;
    this.setData({ title, titleCount: title.length });
    this.saveDraft();
  },

  inputBody(event: WechatMiniprogram.Input) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    const body = event.detail.value;
    this.setData({ body, bodyCount: body.length });
    this.saveDraft();
  },

  inputCustomEvent(event: WechatMiniprogram.Input) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    this.setData({ customEvent: event.detail.value });
    this.saveDraft();
  },

  inputMetricValue(event: WechatMiniprogram.Input) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    this.setData({ metricValue: event.detail.value });
    this.saveDraft();
  },

  selectMetric(event: WechatMiniprogram.TouchEvent) {
    if (this.data.pending || this.data.submitting || !this.data.ready) return;
    const type = event.currentTarget.dataset.type as MetricType;
    this.setData({ metricType: this.data.metricType === type ? "" : type, metricValue: "" });
    this.saveDraft();
  },

  async chooseMedia() {
    if (!this.data.ready || this.data.pending || !this.data.mediaEnabled || this.data.mediaBusy || this.data.submitting) return;
    const child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: "请先创建宝宝档案", icon: "none" });
      return;
    }
    const remaining = 9 - this.data.linkedAssetIds.length;
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
      const assets = await services.uploads.saveLocalMedia(child.id, prepared.files, this.uploadOptions());
      keepPaths = assets.map((asset) => asset.localPath || "");

      if (assets.some((asset) => asset.volatile)) {
        wx.showToast({ title: "部分大文件仅本次会话可预览", icon: "none" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : (error as { errMsg?: string } | null)?.errMsg || "素材处理失败，请更换文件重试";
      if (!message.includes("cancel") && !this.mediaCancelled) {
        wx.showToast({ title: message, icon: "none" });
      }
    } finally {
      // 失败时队列仍引用压缩文件，留待重试；成功后服务端URL不依赖本地文件。
      if (!wx.getStorageSync("growth_diary_upload_queue_v1")) await prepared?.dispose(keepPaths);
      this.setData({ mediaBusy: false, processingMedia: false, mediaProgress: "" });
    }
  },

  uploadOptions() {
    return {
      cancelled: () => this.mediaCancelled,
      progress: (mediaProgress: string) => this.setData({ mediaProgress }),
      saved: (asset: Asset) => {
        if (!this.data.linkedAssetIds.includes(asset.id)) {
          if (this.data.linkedAssetIds.length >= 9) throw new Error("最多关联9个素材，请移除后继续");
          this.setData({ linkedAssetIds: [...this.data.linkedAssetIds, asset.id], assets: [...this.data.assets, withSizeLabel(asset)] });
          this.saveDraft();
        }
      },
    };
  },

  async discardUploads() {
    if (this.data.mediaBusy || this.data.pending) return;
    this.setData({ mediaBusy: true });
    try { await services.uploads.discardPending(); this.setData({ error: "已取消待处理上传，可重新选择素材" }); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "取消失败" }); }
    finally { this.setData({ mediaBusy: false }); }
  },

  async resumeUploads() {
    if (this.data.mediaBusy || this.data.pending || !this.data.ready) return;
    this.mediaCancelled = false;
    this.setData({ mediaBusy: true, error: "" });
    try { await services.uploads.resumePending(this.data.children[this.data.childIndex].id, this.uploadOptions()); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "上传失败" }); }
    finally { this.setData({ mediaBusy: false, mediaProgress: "" }); }
  },

  cancelMedia() {
    this.mediaCancelled = true;
    this.setData({ mediaProgress: "正在取消，请等待当前压缩结束" });
  },

  onHide() { this.saveDraft(); this.revision++; if (this.data.processingMedia) this.cancelMedia(); },
  onUnload() { this.saveDraft(); this.mediaCancelled = true; },

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
    if (this.data.mediaBusy || this.data.pending || this.data.submitting) return;
    const id = event.currentTarget.dataset.id as string;
    this.setData({ assets: this.data.assets.filter((asset) => asset.id !== id), linkedAssetIds: this.data.linkedAssetIds.filter((item) => item !== id) });
    this.saveDraft();
  },

  async submit() {
    if (this.data.submitting || this.data.mediaBusy || !this.data.ready) return;
    const draft = this.pendingDraft || this.currentDraft();
    if (!draft.childId || !draft.title.trim()) { this.setData({ error: "请选择宝宝并填写标题" }); return; }
    if (draft.metricType && (!Number.isFinite(draft.metricValue) || !draft.metricValue)) {
      this.setData({ error: "请填写有效的指标数值" }); return;
    }
    this.setData({ submitting: true, error: "" });
    try {
      if (!draft.id && !draft.requestId) draft.requestId = await createRequestId();
      this.pendingDraft = draft;
      this.setData({ pending: true });
      this.saveDraft();
      await services.entries.save(draft);
      this.setData({ ready: false });
      this.pendingDraft = null;
      wx.removeStorageSync(ENTRY_DRAFT_KEY);
      wx.removeStorageSync("growth_diary_edit_entry_id");
      wx.showToast({ title: "记录已保存", icon: "success" });
      wx.switchTab({ url: "/pages/wall/index" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        this.pendingDraft = null;
        this.setData({ pending: false });
        this.saveDraft();
      }
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        this.setData({ ready: false });
        wx.reLaunch({ url: "/pages/select-family/index" });
      }
      this.setData({ error: error instanceof Error ? error.message : "保存失败，草稿已保留" });
    } finally { this.setData({ submitting: false }); }
  },
});
