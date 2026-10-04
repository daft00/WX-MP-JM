import { Asset, Child, Entry } from "../types/models";
import { archiveHtml, utf8, writeZip, ZipSource, ArchiveMedia } from "../utils/export-archive";
import { readMediaSize } from "./media-policy";

export interface ExportProgress {
  progress?: (message: string) => void;
  cancelled?: () => boolean;
}

export async function createLocalArchive(path: string, child: Child, period: string, entries: Entry[], assets: Asset[], options: ExportProgress = {}) {
  const fs = wx.getFileSystemManager();
  const check = () => { if (options.cancelled?.()) throw new Error("已取消导出"); };
  const sources: ZipSource[] = [], media: ArchiveMedia[] = [];
  const ids = [...new Set(entries.flatMap((entry) => entry.assetIds))];
  for (const [index, id] of ids.entries()) {
    check();
    options.progress?.(`检查素材 ${index + 1}/${ids.length}`);
    const asset = assets.find((item) => item.id === id && item.familyId === child.familyId && item.childId === child.id);
    if (!asset?.localPath) throw new Error("记录包含演示占位或丢失素材，无法完整导出，请重新添加素材");
    const localPath = asset.localPath;
    const size = await readMediaSize(localPath);
    if (size <= 0) throw new Error("素材文件为空，无法导出");
    let extension: string;
    if (asset.kind === "IMAGE") {
      const info = await wx.getImageInfo({ src: localPath });
      extension = info.type.toLowerCase();
      if (!/^(jpeg|jpg|png|gif|webp|bmp|heic|heif)$/.test(extension)) throw new Error("图片格式无法识别，请重新选择图片");
    } else {
      const info = await wx.getVideoInfo({ src: localPath });
      extension = /^(mp4|mov|m4v|webm)$/i.test(info.type) ? info.type.toLowerCase() : (localPath.match(/\.(mp4|mov|m4v|webm)$/i)?.[1].toLowerCase() || "mp4");
    }
    const name = `media/${String(index + 1).padStart(5, "0")}.${extension}`;
    media.push({ asset, path: name });
    sources.push({ name, size, chunks: async function* () {
      for (let position = 0; position < size; position += 1024 * 1024) {
        check();
        const length = Math.min(1024 * 1024, size - position);
        const data = await new Promise<ArrayBuffer>((resolve, reject) => fs.readFile({
          filePath: localPath, position, length,
          success: (result) => typeof result.data === "string" ? reject(new Error("素材读取格式异常")) : resolve(result.data),
          fail: () => reject(new Error("素材读取失败，请检查原文件是否仍存在")),
        }));
        if (data.byteLength !== length) throw new Error("素材读取不完整");
        options.progress?.(`打包素材 ${index + 1}/${ids.length} · ${Math.round((position + length) / size * 100)}%`);
        yield new Uint8Array(data);
      }
    } });
  }
  const html = utf8(archiveHtml(child, period, entries, media));
  sources.unshift({ name: "index.html", size: html.length, chunks: async function* () { yield html; } });
  check();
  try {
    await new Promise<void>((resolve, reject) => fs.writeFile({ filePath: path, data: new ArrayBuffer(0), success: () => resolve(), fail: reject }));
    await writeZip(sources, async (data) => {
      check();
      await new Promise<void>((resolve, reject) => fs.appendFile({ filePath: path, data: data.buffer as ArrayBuffer, success: () => resolve(), fail: reject }));
    });
    check();
    return { sizeBytes: await readMediaSize(path), assetCount: ids.length, entryCount: entries.length };
  } catch (error) {
    await discardArchive(path);
    if (error instanceof Error) throw error;
    throw new Error("导出文件写入失败，可能是本机空间不足，请清理已导出包或缩小范围");
  }
}

export async function discardArchive(path: string): Promise<void> {
  await new Promise<void>((resolve) => wx.getFileSystemManager().unlink({ filePath: path, complete: () => resolve() }));
}
