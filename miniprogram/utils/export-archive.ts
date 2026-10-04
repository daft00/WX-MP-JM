import { Asset, Child, Entry } from "../types/models";

export function exportRange(period: string) {
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2]|Q[1-4]))?$/.test(period)) throw new Error("请选择有效的月份、季度或年份");
  const year = Number(period.slice(0, 4));
  if (year < 1900 || year > 9998) throw new Error("年份超出支持范围");
  const quarter = period.includes("Q");
  const startMonth = period.length === 4 ? 1 : quarter ? (Number(period.slice(-1)) - 1) * 3 + 1 : Number(period.slice(-2));
  const endMonth = startMonth + (period.length === 4 ? 12 : quarter ? 3 : 1);
  const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const end = `${year + (endMonth > 12 ? 1 : 0)}-${String(endMonth > 12 ? endMonth - 12 : endMonth).padStart(2, "0")}-01`;
  return { start, end, label: period.length === 4 ? `${year}年` : quarter ? `${year}年第${period.slice(-1)}季度` : `${year}年${startMonth}月` };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

export interface ArchiveMedia { asset: Asset; path: string }

export function archiveHtml(child: Child, period: string, entries: Entry[], media: ArchiveMedia[]): string {
  const escape = escapeHtml;
  const ordered = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const months = new Map<string, Entry[]>();
  for (const entry of ordered) {
    const month = entry.occurredAt.slice(0, 7);
    months.set(month, [...(months.get(month) || []), entry]);
  }
  const cards = [...months].map(([month, items]) => `<details open><summary>${escape(month.replace("-", "年"))}月</summary>${items.map((entry) => {
    const assets = entry.assetIds.map((id) => {
      const item = media.find((file) => file.asset.id === id);
      if (!item) throw new Error("记录包含未导出的素材");
      const url = escape(item.path);
      return item.asset.kind === "VIDEO" ? `<video controls preload="metadata" src="${url}"></video><a href="${url}" download>保存视频</a>` : `<a href="${url}" target="_blank" rel="noopener"><img loading="lazy" src="${url}" alt="${escape(item.asset.name)}"></a>`;
    }).join("");
    const metric = entry.metric ? `<p>${escape(({ HEIGHT: "身高", WEIGHT: "体重", HEAD: "头围" })[entry.metric.type])} ${entry.metric.value}${escape(entry.metric.unit)}</p>` : "";
    return `<article><time>${escape(entry.occurredAt)}</time><p class="meta">${escape(child.name)} · ${entry.kind === "MILESTONE" ? "成长里程碑" : "生活日记"}</p><h2>${escape(entry.title)}</h2><p class="body">${escape(entry.body)}</p>${entry.customEvent ? `<p>${escape(entry.customEvent)}</p>` : ""}${metric}<div class="media">${assets}</div></article>`;
  }).join("")}</details>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(child.name)}的记录墙</title><style>body{margin:0;background:#fff9f2;color:#503b32;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:24px}h1{font-size:28px}h2{font-size:21px}summary{cursor:pointer;padding:16px 0;color:#a36e55;font-weight:700}article{background:#fffdf9;border:1px solid #eee4db;border-radius:18px;padding:20px;margin:0 0 20px}time,.meta{color:#91857c;font-size:14px}.body{white-space:pre-wrap;overflow-wrap:anywhere}.media{display:grid;gap:12px}.media img,.media video{display:block;max-width:100%;max-height:70vh;border-radius:10px}a{color:#a36e55}</style></head><body><main><h1>${escape(child.name)}的记录墙</h1><p>${escape(exportRange(period).label)} · ${entries.length}条记录 · 按记录日期正序</p><p class="meta">离线相册：请先解压整个ZIP，保留index.html与media目录的相对位置。视频能否播放取决于浏览器对原文件编码的支持，也可下载后用播放器打开。</p>${cards}</main></body></html>`;
}

export function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of value) {
    let code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
    else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
    else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
  }
  return new Uint8Array(bytes);
}

export interface ZipSource { name: string; size: number; chunks: () => AsyncIterable<Uint8Array> }
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

// 媒体已压缩，采用ZIP STORE逐块写入，避免把整个年度相册载入内存。不支持ZIP64。
export async function writeZip(files: ZipSource[], write: (data: Uint8Array) => Promise<void>) {
  if (files.length > 65535) throw new Error("素材数量过多，请缩小导出范围");
  let offset = 0;
  const central: Uint8Array[] = [];
  const names = new Set<string>();
  const append = async (data: Uint8Array) => {
    if (offset + data.length >= 0xffffffff) throw new Error("导出包超过4GB，请按月导出");
    await write(data); offset += data.length;
  };
  for (const file of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.name) || file.name.includes("..") || file.name.startsWith("/") || names.has(file.name)) throw new Error("无效的导出文件名");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size >= 0xffffffff) throw new Error("素材大小异常");
    names.add(file.name);
    const name = utf8(file.name), start = offset;
    const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 8, true);
    view.setUint16(12, 33, true); view.setUint16(26, name.length, true); local.set(name, 30);
    await append(local);
    let crc = 0xffffffff, size = 0;
    for await (const chunk of file.chunks()) {
      size += chunk.length;
      if (size > file.size) throw new Error("素材在导出期间发生变化，请重试");
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
      await append(chunk);
    }
    if (size !== file.size) throw new Error("素材读取不完整，导出已停止");
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = new Uint8Array(16), d = new DataView(descriptor.buffer);
    d.setUint32(0, 0x08074b50, true); d.setUint32(4, crc, true); d.setUint32(8, size, true); d.setUint32(12, size, true);
    await append(descriptor);
    const header = new Uint8Array(46 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 8, true);
    h.setUint16(14, 33, true); h.setUint32(16, crc, true); h.setUint32(20, size, true); h.setUint32(24, size, true);
    h.setUint16(28, name.length, true); h.setUint32(42, start, true); header.set(name, 46); central.push(header);
  }
  const start = offset;
  for (const header of central) await append(header);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, offset - start, true); e.setUint32(16, start, true); await append(end);
}
