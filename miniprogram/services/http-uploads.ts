import { LocalMediaFile, UploadOptions, UploadService } from "./contracts";
import { Asset } from "../types/models";
import { createRequestId } from "./entry-draft";

const KEY = "growth_diary_upload_queue_v1";
type RemoteAsset = Asset & { status: string; error?: string };
type Ticket = { asset: RemoteAsset; upload?: { url: string; formData: Record<string, string> } };
type Task = { requestId: string; childId: string; kind: string; name: string; sizeBytes: number; path: string; id?: string; uploaded?: boolean };
type Call = <T>(path: string, method?: "GET" | "POST" | "PUT" | "DELETE", data?: object) => Promise<T>;

export function createUploadService(call: Call, scope: () => string): UploadService {
  let busy = false;
  async function run(childId: string, files: LocalMediaFile[], options: UploadOptions = {}): Promise<Asset[]> {
    if (busy) throw new Error("素材正在处理，请稍候");
    busy = true;
    const current = scope();
    const check = () => { if (scope() !== current || options.cancelled?.()) throw new Error("素材上传已取消"); };
    try {
      const stored = wx.getStorageSync(KEY) as { scope: string; tasks: Task[] } | undefined;
      const tasks = stored?.scope === current ? stored.tasks : [];
      if (files.length && tasks.length) throw new Error("请先继续处理上次上传");
      for (const file of files) {
        const stat = await new Promise<{ size: number }>((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: file.tempFilePath, success: resolve, fail: reject }));
        const kind = file.fileType === "video" ? "VIDEO" : "IMAGE";
        if (stat.size <= 0 || stat.size > (kind === "VIDEO" ? 50 : 10) * 1024 ** 2) throw new Error("素材大小超限");
        tasks.push({ requestId: await createRequestId(), childId, kind, name: file.tempFilePath.split("/").pop() || "media", sizeBytes: stat.size, path: file.tempFilePath });
      }
      check();
      const persist = () => { check(); wx.setStorageSync(KEY, { scope: current, tasks }); };
      persist();
      const result: Asset[] = [];
      while (tasks.length) {
        check();
        const task = tasks[0];
        if (task.childId !== childId) throw new Error("请切换回原宝宝继续上传");
        options.progress?.("正在申请上传权限");
        let ticket: Ticket;
        if (task.id) ticket = await call<Ticket>(`/assets/${task.id}/authorize`, "POST");
        else {
          const { path, id, uploaded, ...body } = task;
          ticket = await call<Ticket>("/assets", "POST", body);
          check(); task.id = ticket.asset.id; persist();
        }
        if (ticket.upload && !task.uploaded) {
          check();
          const url = ticket.upload.url;
          if (!/^https:\/\/[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com\/$/.test(url)) throw new Error("上传地址无效");
          await new Promise<void>((resolve, reject) => {
            const upload = wx.uploadFile({ url, filePath: task.path, name: "file", formData: ticket.upload!.formData, timeout: 120000,
              success: (r) => r.statusCode >= 200 && r.statusCode < 300 ? resolve() : reject(new Error("上传失败，请重试；临时文件丢失时请取消并重新选择")),
              fail: () => reject(new Error("上传中断，请继续上次上传")) });
            upload.onProgressUpdate((r) => { if (scope() !== current || options.cancelled?.()) upload.abort(); else options.progress?.(`正在上传 ${r.progress}%`); });
          });
          check(); task.uploaded = true; persist();
        }
        let asset = ticket.asset;
        if (asset.status === "PENDING") asset = await call<RemoteAsset>(`/assets/${task.id}/complete`, "POST");
        for (let attempt = 0; asset.status === "PENDING" && attempt < 8; attempt++) {
          check(); options.progress?.("正在复核素材并生成预览，可稍后继续");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          asset = await call<RemoteAsset>(`/assets/${task.id}`);
        }
        check();
        if (asset.status !== "READY") throw new Error(asset.status === "PENDING" ? "素材仍在处理，请稍后继续上次上传" : "素材复核失败，请取消后重新选择");
        // 先保存素材到草稿再移出队列，异常重试不会丢失已完成素材。
        options.saved?.(asset); result.push(asset); tasks.shift(); persist();
      }
      wx.removeStorageSync(KEY);
      return result;
    } finally { busy = false; }
  }
  return {
    quota: () => call("/storage"),
    async discardPending() {
      if (busy) throw new Error("请等待当前上传结束");
      const stored = wx.getStorageSync(KEY) as { scope: string; tasks: Task[] } | undefined;
      const current = scope();
      if (stored?.scope === current) {
        for (const task of stored.tasks) {
          if (task.id) await call(`/assets/${task.id}`, "DELETE");
        }
      }
      if (scope() === current) wx.removeStorageSync(KEY);
    },
    saveLocalMedia: (child, files, options) => run(child, files, options),
    resumePending: (child, options) => run(child, [], options),
    async getAssets(ids) {
      const assets: Asset[] = [];
      for (const id of ids) {
        const asset = await call<RemoteAsset>(`/assets/${encodeURIComponent(id)}`);
        if (asset.status === "READY") assets.push(asset);
      }
      return assets;
    },
  };
}
