import { services } from "../../services/index";
import { Child, MetricType, MetricValue } from "../../types/models";
import { formatDate } from "../../utils/date";

interface MetricPoint extends MetricValue {
  dateLabel: string;
  barHeight: number;
}

Page({
  data: {
    children: [] as Child[],
    selectedChildId: "",
    metricType: "HEIGHT" as MetricType,
    points: [] as MetricPoint[],
    latestLabel: "暂无记录",
    latestDate: "",
    metricCounts: { HEIGHT: 0, WEIGHT: 0, HEAD: 0 } as Record<MetricType, number>,
    unit: "cm",
  },

  async onShow() {
    await this.loadData();
  },

  async loadData() {
    try {
      const [children, selection] = await Promise.all([
        services.children.list(),
        services.family.getSelection(),
      ]);
      const selectedChildId = children.some((item) => item.id === selection.childId)
        ? selection.childId
        : children[0]?.id || "";
      const page = await services.entries.list({ childId: selectedChildId, pageSize: 200 });
      const metrics = page.items
        .map((entry) => entry.metric)
        .filter((metric): metric is MetricValue => Boolean(metric))
        .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
      const metricCounts: Record<MetricType, number> = { HEIGHT: 0, WEIGHT: 0, HEAD: 0 };
      metrics.forEach((metric) => {
        metricCounts[metric.type] += 1;
      });
      this.setData({ children, selectedChildId, metricCounts });
      this.applyMetric(metrics, this.data.metricType);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
    }
  },

  applyMetric(metrics: MetricValue[], type: MetricType) {
    const filtered = metrics.filter((metric) => metric.type === type);
    const values = filtered.map((metric) => metric.value);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    const span = Math.max(1, max - min);
    const points: MetricPoint[] = filtered.map((metric) => ({
      ...metric,
      dateLabel: formatDate(metric.measuredAt).replace("年", "/").replace("月", "/").replace("日", ""),
      barHeight: Math.round(50 + ((metric.value - min) / span) * 130),
    }));
    const latest = filtered[filtered.length - 1];
    this.setData({
      metricType: type,
      points,
      unit: type === "WEIGHT" ? "kg" : "cm",
      latestLabel: latest ? `${latest.value}${latest.unit}` : "暂无记录",
      latestDate: latest ? formatDate(latest.measuredAt) : "",
    });
  },

  async selectChild(event: WechatMiniprogram.TouchEvent) {
    const childId = event.currentTarget.dataset.id as string;
    await services.family.selectChild(childId);
    this.setData({ selectedChildId: childId });
    await this.loadData();
  },

  async selectMetric(event: WechatMiniprogram.TouchEvent) {
    const type = event.currentTarget.dataset.type as MetricType;
    this.setData({ metricType: type });
    await this.loadData();
  },

  addMetric() {
    wx.removeStorageSync("growth_diary_edit_entry_id");
    wx.setStorageSync("growth_diary_new_entry_kind", "MILESTONE");
    wx.setStorageSync("growth_diary_new_entry_child_id", this.data.selectedChildId);
    wx.switchTab({ url: "/pages/publish/index" });
  },
});
