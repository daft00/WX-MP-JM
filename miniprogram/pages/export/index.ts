import { services } from "../../services/index";
import { Child, ExportJob } from "../../types/models";
import { today } from "../../utils/date";
import { API_BASE_URL } from "../../services/api-config";

Page({
  data: {
    children: [] as Child[], jobs: [] as ExportJob[], childIndex: 0, periodIndex: 0, quarterIndex: 0,
    periodTypes: ["按月份", "按季度", "按年度"], quarters: ["第一季度", "第二季度", "第三季度", "第四季度"],
    selectedMonth: today().slice(0, 7), selectedYear: today().slice(0, 4), isAdmin: false,
    busy: false, error: "", computerUrl: API_BASE_URL + "/export-browser",
  },
  async onShow() { await this.loadData(); },
  async loadData() {
    try {
      const session = await services.auth.getSession();
      const isAdmin = session.membership.role === "OWNER" || session.membership.role === "ADMIN";
      this.setData({ isAdmin, jobs: [], error: "" });
      if (!isAdmin) return;
      const [children, jobs] = await Promise.all([services.children.list(), services.exports.list()]);
      this.setData({ children, jobs, childIndex: Math.min(this.data.childIndex, Math.max(0, children.length - 1)) });
    } catch (e) { this.setData({ jobs: [], error: e instanceof Error ? e.message : "加载失败" }); }
  },
  changeChild(e: WechatMiniprogram.PickerChange) { this.setData({ childIndex: Number(e.detail.value) }); },
  changePeriod(e: WechatMiniprogram.PickerChange) { this.setData({ periodIndex: Number(e.detail.value) }); },
  changeQuarter(e: WechatMiniprogram.PickerChange) { this.setData({ quarterIndex: Number(e.detail.value) }); },
  changeMonth(e: WechatMiniprogram.PickerChange) { this.setData({ selectedMonth: String(e.detail.value) }); },
  changeYear(e: WechatMiniprogram.PickerChange) { this.setData({ selectedYear: String(e.detail.value).slice(0, 4) }); },
  async createExport() {
    if (this.data.busy || !this.data.isAdmin || !this.data.children.length) return;
    this.setData({ busy: true, error: "" });
    try {
      const period = this.data.periodIndex === 0 ? this.data.selectedMonth : this.data.periodIndex === 1 ? `${this.data.selectedYear}-Q${this.data.quarterIndex + 1}` : this.data.selectedYear;
      await services.exports.create(this.data.children[this.data.childIndex].id, period);
      await this.loadData();
      wx.showToast({ title: "后台任务已创建", icon: "success" });
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : "创建失败，请重试原范围" }); }
    finally { this.setData({ busy: false }); }
  },
  async shareArchive(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" }); let path = "";
    try {
      const id = String(e.currentTarget.dataset.id), part = Number(e.currentTarget.dataset.part);
      path = await services.exports.getArchivePath(id, part);
      await wx.shareFileMessage({ filePath: path, fileName: `growth-${part}.zip` });
    } catch { this.setData({ error: "下载或分享未完成。空间不足时请改用电脑下载；取消分享后可以重试。" }); }
    finally { if (path) wx.getFileSystemManager().unlink({ filePath: path }); this.setData({ busy: false }); }
  },
  async deleteArchive(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    const answer = await wx.showModal({ title: "取消并清理导出？", content: "只清理导出分包，不删除原照片、视频或记录。" });
    if (!answer.confirm) return;
    this.setData({ busy: true });
    try { await services.exports.deleteArchive(String(e.currentTarget.dataset.id)); await this.loadData(); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : "取消失败" }); }
    finally { this.setData({ busy: false }); }
  },
  async confirmBackup(e: WechatMiniprogram.TouchEvent) {
    const answer = await wx.showModal({ title: "确认全部分包已备份？", content: "这里只记录人工确认，系统无法验证网盘文件。请先检查全部分包。" });
    if (!answer.confirm) return;
    try { await services.exports.confirmManualBackup(String(e.currentTarget.dataset.id)); await this.loadData(); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : "确认失败" }); }
  },
  copyComputerUrl() { wx.setClipboardData({ data: this.data.computerUrl }); },
  async authorizeComputer() {
    if (this.data.busy || !this.data.isAdmin) return;
    this.setData({ busy: true });
    try {
      const scan = await wx.scanCode({ onlyFromCamera: true, scanType: ["qrCode"] });
      const match = /^growth-export:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(scan.result);
      if (!match) throw new Error("请扫描电脑导出页的配对二维码");
      const family = await services.family.getCurrentFamily();
      const answer = await wx.showModal({ title: `核对配对码 ${match[1].slice(-6)}`, content: `允许这台电脑在15分钟内下载“${family.name}”的导出包？只授权自己的电脑。`, confirmText: "允许下载" });
      if (answer.confirm && (await services.family.getCurrentFamily()).id === family.id) { await services.exports.authorizeComputer(match[1], match[2]); wx.showToast({ title: "已授权，请刷新电脑页", icon: "none" }); }
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : "扫码授权未完成" }); }
    finally { this.setData({ busy: false }); }
  },
});
