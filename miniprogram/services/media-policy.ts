import { LocalMediaFile } from "./contracts";

export const MEDIA_LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 };

export function assertMediaSize(kind: string | undefined, size: number): void {
  if (kind !== "image" && kind !== "video") throw new Error("不支持的素材类型");
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("素材为空或无法读取大小");
  if (size > MEDIA_LIMITS[kind]) throw new Error(kind === "image" ? "图片压缩后仍超过10MB，请换一张图片" : "视频压缩后仍超过50MB，请缩短视频后重试");
}

export function readMediaSize(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({
    filePath, success: (result) => resolve(result.size), fail: () => reject(new Error("无法读取素材文件")),
  }));
}

interface PreparationOptions {
  cancelled: () => boolean;
  progress: (message: string) => void;
  toJpeg: (path: string, edge: number, quality: number) => Promise<string>;
}

// 只清理本次生成的文件，绝不删除相册原文件。取消在原生压缩回调后生效。
export async function prepareMedia(files: LocalMediaFile[], options: PreparationOptions) {
  const owned = new Set<string>();
  const originals = new Set(files.map((file) => file.tempFilePath));
  const dispose = async (keep: string[] = []) => {
    for (const path of owned) {
      if (keep.includes(path)) continue;
      await new Promise<void>((resolve) => wx.getFileSystemManager().unlink({ filePath: path, complete: () => resolve() }));
      owned.delete(path);
    }
  };
  const check = () => { if (options.cancelled()) throw new Error("已取消处理"); };
  const track = (path: string) => { if (!originals.has(path)) owned.add(path); return path; };
  try {
    const prepared: LocalMediaFile[] = [];
    for (const [index, file] of files.entries()) {
      check();
      const kind = file.fileType;
      if (kind !== "image" && kind !== "video") throw new Error("不支持的素材类型");
      options.progress(`正在检查第 ${index + 1}/${files.length} 个素材`);
      let path = file.tempFilePath, size = await readMediaSize(path);
      if (size > MEDIA_LIMITS[kind]) {
        if (kind === "image") {
          const info = await wx.getImageInfo({ src: path });
          if (info.type.toLowerCase() === "gif") throw new Error("动图超过10MB，请选择较小动图，避免压缩丢失动画");
          for (const [round, edge] of [2560, 1920, 1280].entries()) {
            check();
            options.progress(`正在压缩图片 ${index + 1}/${files.length}（第 ${round + 1}/3 轮）`);
            const quality = [80, 65, 50][round];
            const result = await wx.compressImage({ src: file.tempFilePath, quality,
              ...(info.width >= info.height ? { compressedWidth: Math.min(edge, info.width) } : { compressedHeight: Math.min(edge, info.height) }),
            });
            path = track(result.tempFilePath);
            check();
            size = await readMediaSize(path);
            if (size > MEDIA_LIMITS.image && !["jpg", "jpeg"].includes(info.type.toLowerCase())) {
              path = track(await options.toJpeg(path, edge, quality / 100));
              check();
              size = await readMediaSize(path);
            }
            if (size <= MEDIA_LIMITS.image) break;
          }
        } else {
          const info = await wx.getVideoInfo({ src: path });
          if (!Number.isFinite(info.duration) || info.duration <= 0) throw new Error("无法读取视频时长");
          for (let round = 0; round < 2; round++) {
            check();
            options.progress(`正在压缩视频 ${index + 1}/${files.length}（第 ${round + 1}/2 轮）`);
            const targetKbps = Math.floor(45 * 1024 * 1024 * 8 / info.duration / 1000 * (round ? 0.65 : 1) - 128);
            if (targetKbps < 128) throw new Error("视频过长，请缩短视频后重试");
            const result = await wx.compressVideo({ src: file.tempFilePath,
              bitrate: Math.min(targetKbps, info.bitrate > 0 ? info.bitrate : targetKbps),
              fps: Math.max(1, Math.min(round ? 24 : 30, info.fps || 30)),
              resolution: Math.min(1, (round ? 720 : 1280) / Math.max(info.width, info.height)),
            });
            path = track(result.tempFilePath);
            check();
            size = await readMediaSize(path);
            if (size <= MEDIA_LIMITS.video) break;
          }
        }
      }
      check();
      assertMediaSize(kind, size);
      prepared.push({ ...file, tempFilePath: path, size });
    }
    await dispose(prepared.map((file) => file.tempFilePath));
    check();
    return { files: prepared, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
