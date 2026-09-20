import { services } from "../../services/index";
import { Child, ExportJob } from "../../types/models";
import { formatDateTime, today } from "../../utils/date";

interface ExportView extends ExportJob {
  childName: string;
  statusLabel: string;
  createdLabel: string;
  expiresLabel: string;
  canDownload: boolean;
  canConfirm: boolean;
}

Page({
  data: {
    children: [] as Child[],
    childIndex: 0,
    selectedMonth: today().slice(0, 7),
    jobs: [] as ExportView[],
    isAdmin: false,
    creating: false,
  },

  async onShow() {
    await this.loadData();
  },

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      PENDING: "等待生成",
      PROCESSING: "正在生成",
      READY: "演示包已生成",
      DOWNLOADED: "已模拟下载",
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
          statusLabel: this.statusLabel(job.status),
          createdLabel: formatDateTime(job.createdAt),
          expiresLabel: job.expiresAt ? formatDateTime(job.expiresAt) : "—",
          canDownload: job.status === "READY",
          canConfirm: job.status === "DOWNLOADED",
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

  async createExport() {
    const child = this.data.children[this.data.childIndex];
    if (!child) {
      wx.showToast({ title: "请先创建宝宝档案", icon: "none" });
      return;
    }
    this.setData({ creating: true });
    try {
      await services.exports.create(child.id, this.data.selectedMonth);
      await this.loadData();
      wx.showToast({ title: "演示导出已生成", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "创建失败", icon: "none" });
    } finally {
      this.setData({ creating: false });
    }
  },

  simulateDownload(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id as string;
    wx.showModal({
      title: "模拟下载",
      content: "纯前端原型不会生成真实 ZIP。本操作仅用于演示下载后的状态变化。",
      confirmText: "模拟完成",
      success: async (result) => {
        if (result.confirm) {
          await services.exports.markDownloaded(id);
          await this.loadData();
        }
      },
    });
  },

  confirmBackup(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id as string;
    wx.showModal({
      title: "确认已人工上传？",
      content: "系统无法验证夸克网盘中的文件，只会记录你的人工确认。",
      confirmText: "我已上传",
      success: async (result) => {
        if (result.confirm) {
          await services.exports.confirmManualBackup(id);
          await this.loadData();
        }
      },
    });
  },
});
