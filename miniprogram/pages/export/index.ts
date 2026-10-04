import { services } from "../../services/index";
import { Child, ExportJob } from "../../types/models";
import { formatDateTime, today } from "../../utils/date";
import { exportRange } from "../../utils/export-archive";

interface ExportView extends ExportJob {
  childName: string;
  statusLabel: string;
  createdLabel: string;
  canDownload: boolean;
  canConfirm: boolean;
  periodLabel: string;
  sizeLabel: string;
}

Page({
  data: {
    children: [] as Child[],
    childIndex: 0,
    selectedMonth: today().slice(0, 7),
    selectedYear: today().slice(0, 4),
    periodTypes: ["按月份", "按季度", "按年度"],
    periodIndex: 0,
    quarters: ["第一季度（1—3月）", "第二季度（4—6月）", "第三季度（7—9月）", "第四季度（10—12月）"],
    quarterIndex: Math.floor((Number(today().slice(5, 7)) - 1) / 3),
    progress: "",
    sharing: false,
    jobs: [] as ExportView[],
    isAdmin: false,
    creating: false,
  },

  cancelled: false,
  onUnload() { this.cancelled = true; },
  onHide() { if (this.data.creating) this.cancelled = true; },

  async onShow() {
    await this.loadData();
  },

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      PENDING: "等待生成",
      PROCESSING: "正在生成",
      READY: "导出包已生成",
      DOWNLOADED: "已分享导出包",
      CONFIRMED: "已人工确认上传夸克",
    };
    return labels[status] || status;
  },

  async loadData() {
    try {
      const [children, jobs, session] = await Promise.all([
        services.children.list(),
        services.exports.list(),
        services.auth.getSession(),
      ]);
      this.setData({
        children,
        childIndex: Math.min(this.data.childIndex, Math.max(0, children.length - 1)),
        isAdmin: session.membership.role === "OWNER" || session.membership.role === "ADMIN",
        jobs: jobs.map((job) => ({
          ...job,
          childName: children.find((child) => child.id === job.childId)?.name || "宝宝",
          statusLabel: job.entryCount === undefined ? "历史演示任务" : job.localZipPath ? this.statusLabel(job.status) : "本地包已清理",
          periodLabel: exportRange(job.yearMonth).label,
          sizeLabel: `${((job.sizeBytes || 0) / 1024 / 1024).toFixed(1)} MB`,
          createdLabel: formatDateTime(job.createdAt),
          canDownload: Boolean(job.localZipPath),
          canConfirm: job.entryCount !== undefined && job.status === "DOWNLOADED",
        })),
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
    }
  },

  changeChild(event: WechatMiniprogram.PickerChange) {
    this.setData({ childIndex: Number(event.detail.value) });
  },

  changeMonth(event: WechatMiniprogram.PickerChange) {
    this.setData({ selectedMonth: event.detail.value as string });
  },

  changePeriod(event: WechatMiniprogram.PickerChange) { this.setData({ periodIndex: Number(event.detail.value) }); },
  changeYear(event: WechatMiniprogram.PickerChange) { this.setData({ selectedYear: (event.detail.value as string).slice(0, 4) }); },
  changeQuarter(event: WechatMiniprogram.PickerChange) { this.setData({ quarterIndex: Number(event.detail.value) }); },
  cancelExport() { this.cancelled = true; this.setData({ progress: "正在取消并清理未完成的导出包…" }); },

  async createExport() {
    if (this.data.creating || !this.data.isAdmin) return;
    const child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: "请先创建宝宝档案", icon: "none" });
      return;
    }
    this.setData({ creating: true });
    this.cancelled = false;
    try {
      const period = this.data.periodIndex === 0 ? this.data.selectedMonth : this.data.periodIndex === 1 ? `${this.data.selectedYear}-Q${this.data.quarterIndex + 1}` : this.data.selectedYear;
      await services.exports.create(child.id, period, { cancelled: () => this.cancelled, progress: (progress) => this.setData({ progress }) });
      await this.loadData();
      wx.showToast({ title: "导出包已生成", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "创建失败", icon: "none" });
    } finally {
      this.setData({ creating: false, progress: "" });
    }
  },

  async shareArchive(event: WechatMiniprogram.TouchEvent) {
    if (this.data.sharing || this.data.creating) return;
    const id = event.currentTarget.dataset.id as string;
    this.setData({ sharing: true });
    try {
      const filePath = await services.exports.getArchivePath(id);
      const job = this.data.jobs.find((item) => item.id === id)!;
      await wx.shareFileMessage({ filePath, fileName: `record-wall-${job.yearMonth}.zip` });
      if (job.status !== "CONFIRMED") await services.exports.markDownloaded(id);
      await this.loadData();
    } catch (error) {
      const message = error instanceof Error ? error.message : (error as { errMsg?: string })?.errMsg || "分享失败，请在手机微信中重试";
      if (!message.includes("cancel")) wx.showToast({ title: message, icon: "none" });
    } finally { this.setData({ sharing: false }); }
  },

  async deleteArchive(event: WechatMiniprogram.TouchEvent) {
    if (this.data.creating || this.data.sharing) return;
    const result = await wx.showModal({ title: "清理本地导出包？", content: "只删除本机生成的ZIP以释放空间，照片、视频原文件和记录保留。请确认已保存需要的导出包。" });
    if (!result.confirm) return;
    try {
      await services.exports.deleteArchive(event.currentTarget.dataset.id as string);
      await this.loadData();
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "清理失败", icon: "none" }); }
  },

  async confirmBackup(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id as string;
    try {
      const result = await wx.showModal({ title: "确认已人工上传？", content: "系统无法验证夸克网盘中的文件，只会记录你的人工确认。", confirmText: "我已上传" });
      if (result.confirm) {
        await services.exports.confirmManualBackup(id);
        await this.loadData();
      }
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "确认失败", icon: "none" }); }
  },
});
