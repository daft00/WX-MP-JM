import { services } from "../../services/index";
import { ApiError } from "../../services/http-services";
import { Child, MetricType, MetricValue } from "../../types/models";
import { formatDate } from "../../utils/date";

Page({
  data: {
    children: [] as Child[], selectedChildId: "", metricType: "HEIGHT" as MetricType,
    metrics: [] as MetricValue[], points: [] as (MetricValue & { dateLabel: string; barHeight: number })[],
    latestLabel: "暂无记录", latestDate: "", unit: "cm", nextCursor: "", loading: false, error: "",
  },
  revision: 0,
  async onShow() { await this.loadData(); },
  onHide() { this.revision++; },
  async onReachBottom() { if (this.data.nextCursor) await this.loadMore(); },

  async loadData() {
    const version = ++this.revision;
    this.setData({ loading: true, error: "", metrics: [], points: [], nextCursor: "", latestLabel: "暂无记录", latestDate: "" });
    try {
      const selection = await services.family.getSelection();
      const children = await services.children.list();
      if (version !== this.revision) return;
      if (!children.some((child) => child.id === selection.childId)) throw new Error("请先选择宝宝");
      this.setData({ children, selectedChildId: selection.childId });
      const page = await services.entries.metrics(selection.childId, this.data.metricType);
      if (version !== this.revision) return;
      this.renderMetrics(page.items, page.nextCursor || "");
    } catch (error) { if (version === this.revision) this.showError(error); }
    finally { if (version === this.revision) this.setData({ loading: false }); }
  },

  async loadMore() {
    if (this.data.loading || !this.data.nextCursor) return;
    const version = this.revision;
    this.setData({ loading: true, error: "" });
    try {
      const page = await services.entries.metrics(this.data.selectedChildId, this.data.metricType, this.data.nextCursor);
      if (version !== this.revision) return;
      this.renderMetrics([...this.data.metrics, ...page.items], page.nextCursor || "");
    } catch (error) { if (version === this.revision) this.showError(error); }
    finally { if (version === this.revision) this.setData({ loading: false }); }
  },

  renderMetrics(values: MetricValue[], nextCursor: string) {
    const metrics = Array.from(new Map(values.map((value) => [value.id, value])).values())
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || b.id.localeCompare(a.id));
    const chart = metrics.slice(0, 30).reverse();
    const min = Math.min(...chart.map((value) => value.value)), max = Math.max(...chart.map((value) => value.value));
    const points = chart.map((value) => ({ ...value, dateLabel: formatDate(value.measuredAt), barHeight: Math.round(50 + (value.value - min) / Math.max(1, max - min) * 130) }));
    this.setData({ metrics, points, nextCursor, unit: this.data.metricType === "WEIGHT" ? "kg" : "cm",
      latestLabel: metrics[0] ? `${metrics[0].value}${metrics[0].unit}` : "暂无记录",
      latestDate: metrics[0] ? formatDate(metrics[0].measuredAt) : "" });
  },

  async selectChild(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try { await services.family.selectChild(event.currentTarget.dataset.id as string); await this.loadData(); }
    catch (error) { this.showError(error); this.setData({ loading: false }); }
  },
  async selectMetric(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    this.setData({ metricType: event.currentTarget.dataset.type as MetricType });
    await this.loadData();
  },
  showError(error: unknown) {
    this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      this.setData({ metrics: [], points: [], children: [], latestLabel: "", latestDate: "" });
      wx.reLaunch({ url: "/pages/select-family/index" });
    }
  },
  addMetric() {
    wx.removeStorageSync("growth_diary_edit_entry_id");
    wx.setStorageSync("growth_diary_new_entry_kind", "MILESTONE");
    wx.switchTab({ url: "/pages/publish/index" });
  },
});
