import { ExportService } from "./contracts";
import { ExportJob } from "../types/models";
import { createRequestId } from "./entry-draft";
type Call = <T>(path: string, method?: "GET" | "POST" | "PUT" | "DELETE", data?: object) => Promise<T>;
const KEY = "growth_diary_export_request_v1";
export function createExportService(call: Call, confirm: (id: string, secret: string) => Promise<void>, scope: () => string): ExportService {
  return {
    list: () => call<ExportJob[]>("/exports"),
    async create(childId, period) {
      const current = scope();
      const old = wx.getStorageSync(KEY) as { scope: string; childId: string; period: string; requestId: string } | undefined;
      if (old?.scope === current && (old.childId !== childId || old.period !== period)) throw new Error("请先重试上次导出范围，确认结果后再创建新任务");
      const request = old?.scope === current ? old : { scope: current, childId, period, requestId: await createRequestId() };
      wx.setStorageSync(KEY, request);
      let result: ExportJob;
      try { result = await call<ExportJob>("/exports", "POST", { childId, period, requestId: request.requestId }); }
      catch (e) {
        if (scope() === current && [400, 403, 404, 409].includes((e as { status?: number }).status || 0)) wx.removeStorageSync(KEY);
        throw e;
      }
      if (scope() !== current) throw new Error("家庭已切换");
      wx.removeStorageSync(KEY); return result;
    },
    async getArchivePath(id, part = 1) {
      const current = scope();
      const ticket = await call<{ url: string; sizeBytes: number }>(`/exports/${encodeURIComponent(id)}/parts/${part}/download`, "POST");
      if (scope() !== current) throw new Error("家庭已切换");
      if (!/^https:\/\/[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com\//.test(ticket.url) || ticket.sizeBytes > 100 * 1024 ** 2) throw new Error("下载地址或分包大小异常");
      const response = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url: ticket.url, timeout: 300000, success: resolve, fail: reject }));
      const path = response.tempFilePath;
      try {
        if (response.statusCode !== 200 || scope() !== current) throw new Error("下载失败或家庭已切换");
        const info = await new Promise<{ size: number }>((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: reject }));
        if (info.size !== ticket.sizeBytes) throw new Error("导出包下载不完整");
        return path;
      } catch (e) { wx.getFileSystemManager().unlink({ filePath: path }); throw e; }
    },
    deleteArchive: id => call<void>(`/exports/${encodeURIComponent(id)}`, "DELETE"),
    async markDownloaded(id) { const list = await call<ExportJob[]>("/exports"); const item = list.find(j => j.id === id); if (!item) throw new Error("导出任务不存在"); return item; },
    confirmManualBackup: id => call<ExportJob>(`/exports/${encodeURIComponent(id)}/confirm`, "POST"),
    authorizeComputer: confirm,
  };
}
