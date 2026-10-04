import { services } from "../../services/index";
import { Asset, Child, Entry, FamilyMember } from "../../types/models";
import { calculateAge, formatDate } from "../../utils/date";
import { groupRecords, RecordYear } from "../../utils/record-groups";

interface EntryCard extends Entry {
  childName: string;
  childInitial: string;
  childColor: string;
  ageLabel: string;
  authorName: string;
  dateLabel: string;
  kindLabel: string;
  assets: Asset[];
  metricLabel: string;
}

Page({
  data: {
    familyName: "成长日记",
    selectedChildName: "",
    children: [] as Child[],
    selectedChildId: "",
    selectedYear: "",
    yearOptions: [{ value: "", label: "全部年份" }],
    yearIndex: 0,
    entries: [] as EntryCard[],
    years: [] as RecordYear<EntryCard>[],
    expandedMonth: "",
    nextCursor: "" as string,
    loading: true,
    hasMore: false,
  },

  async onShow() {
    await this.loadInitial();
  },

  async onPullDownRefresh() {
    await this.loadInitial();
    wx.stopPullDownRefresh();
  },

  async onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      await this.loadMore();
    }
  },

  async loadInitial() {
    this.setData({ loading: true });
    try {
      const [family, children, selection] = await Promise.all([
        services.family.getCurrentFamily(),
        services.children.list(),
        services.family.getSelection(),
      ]);
      const selectedChildId = children.some((child) => child.id === selection.childId)
        ? selection.childId
        : children[0]?.id || "";
      if (!selection.familyId || !selectedChildId) {
        wx.reLaunch({ url: "/pages/select-family/index" });
        return;
      }
      const availableYears = await services.entries.listYears(selectedChildId);
      const yearOptions = [{ value: "", label: "全部年份" }, ...availableYears.map((year) => ({ value: year, label: `${year}年` }))];
      const selectedYear = availableYears.includes(this.data.selectedYear) ? this.data.selectedYear : "";
      this.setData({
        yearOptions,
        selectedYear,
        yearIndex: yearOptions.findIndex((option) => option.value === selectedYear),
        familyName: family.name,
        children,
        selectedChildId,
        selectedChildName: children.find((child) => child.id === selectedChildId)?.name || "宝宝",
      });
      const page = await services.entries.list({
        childId: selectedChildId,
        year: selectedYear || undefined,
        pageSize: 8,
      });
      const cards = await this.toCards(page.items, children);
      const years = groupRecords(cards);
      this.setData({
        entries: cards,
        years,
        expandedMonth: years[0]?.months[0]?.key || "",
        nextCursor: page.nextCursor || "",
        hasMore: Boolean(page.nextCursor),
      });
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMore() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    try {
      const page = await services.entries.list({
        childId: this.data.selectedChildId,
        year: this.data.selectedYear || undefined,
        cursor: this.data.nextCursor,
        pageSize: 8,
      });
      const cards = await this.toCards(page.items, this.data.children);
      this.setData({
        entries: [...this.data.entries, ...cards],
        years: groupRecords([...this.data.entries, ...cards]),
        nextCursor: page.nextCursor || "",
        hasMore: Boolean(page.nextCursor),
      });
    } catch (error) {
      this.showError(error);
    } finally {
      this.setData({ loading: false });
    }
  },

  async toCards(entries: Entry[], children: Child[]): Promise<EntryCard[]> {
    const members = await services.family.listMembers();
    return Promise.all(
      entries.map(async (entry) => {
        const child = children.find((item) => item.id === entry.childId);
        const member = members.find((item: FamilyMember) => item.userId === entry.creatorId);
        const assets = await services.uploads.getAssets(entry.assetIds);
        const metricLabel = entry.metric
          ? `${this.metricName(entry.metric.type)} ${entry.metric.value}${entry.metric.unit}`
          : "";
        return {
          ...entry,
          childName: child?.name || "宝宝",
          childInitial: (child?.name || "宝").slice(0, 1),
          childColor: child?.avatarColor || "#F0A58A",
          ageLabel: child ? calculateAge(child.birthday, entry.occurredAt) : "",
          authorName: member?.user.nickname || "家人",
          dateLabel: formatDate(entry.occurredAt),
          kindLabel: entry.kind === "MILESTONE" ? "成长里程碑" : "生活日记",
          assets,
          metricLabel,
        };
      }),
    );
  },

  metricName(type: string): string {
    const labels: Record<string, string> = { HEIGHT: "身高", WEIGHT: "体重", HEAD: "头围" };
    return labels[type] || "成长数据";
  },

  toggleMonth(event: WechatMiniprogram.TouchEvent) {
    const month = event.currentTarget.dataset.month as string;
    this.setData({ expandedMonth: this.data.expandedMonth === month ? "" : month });
  },

  async changeYear(event: WechatMiniprogram.PickerChange) {
    if (this.data.loading) return;
    const option = this.data.yearOptions[Number(event.detail.value)];
    if (!option || option.value === this.data.selectedYear) return;
    this.setData({ selectedYear: option.value, entries: [], years: [], nextCursor: "", hasMore: false });
    await this.loadInitial();
  },

  async selectChild(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading) return;
    const childId = event.currentTarget.dataset.id as string;
    await services.family.selectChild(childId);
    this.setData({ selectedChildId: childId, selectedYear: "", yearIndex: 0, entries: [], years: [], nextCursor: "", hasMore: false });
    await this.loadInitial();
  },

  openEntry(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id as string;
    wx.navigateTo({ url: `/pages/entry-detail/index?id=${id}` });
  },

  goPublish() {
    wx.removeStorageSync("growth_diary_edit_entry_id");
    wx.switchTab({ url: "/pages/publish/index" });
  },

  switchFamily() {
    wx.reLaunch({ url: "/pages/select-family/index" });
  },

  showError(error: unknown) {
    const message = error instanceof Error ? error.message : "加载失败，请稍后重试";
    wx.showToast({ title: message, icon: "none" });
  },
});
