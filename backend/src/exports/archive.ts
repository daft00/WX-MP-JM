import { archiveHtml, exportRange, ZipSource } from "./shared/archive";
import { Asset, Child, Entry } from "./shared/models";

export { exportRange };
export const PACK_LIMIT = 100 * 1024 ** 2;
export interface StoredAsset extends Asset { key: string; mime: string; sizeBytes: number }
export interface Snapshot { child: Child; entries: Entry[]; assets: StoredAsset[] }
export interface Part { number: number; ids: string[]; size: number }
export const canonical = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const assetPath = (a: StoredAsset) => `media/${a.id}.${({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4" } as Record<string, string>)[a.mime] || "bin"}`;
export function partHtml(s: Snapshot, period: string, ids: string[]) {
  const included = new Set(ids);
  const entries = s.entries.map(e => ({ ...e, assetIds: e.assetIds.filter(id => included.has(id)),
    body: e.body + (e.assetIds.some(id => !included.has(id)) ? "\n【本记录部分素材位于其他分包，请保留全部分包。】" : "") }));
  return archiveHtml(s.child, period, entries, s.assets.filter(a => included.has(a.id)).map(asset => ({ asset, path: assetPath(asset) })));
}
export const zipSize = (files: Pick<ZipSource, "name" | "size">[]) => 22 + files.reduce((n, f) => n + 92 + 2 * Buffer.byteLength(f.name) + f.size, 0);
export function planParts(s: Snapshot, period: string, limit = PACK_LIMIT): Part[] {
  // Reserve a worst-case HTML size once; avoid regenerating the entire album for every file.
  const note = "\n【本记录部分素材位于其他分包，请保留全部分包。】";
  const htmlBudget = Buffer.byteLength(archiveHtml(s.child, period, s.entries.map(e => ({ ...e, body: e.body + note })),
    s.assets.map(asset => ({ asset, path: assetPath(asset) }))));
  const base = zipSize([{ name: "index.html", size: htmlBudget }]);
  const groups: string[][] = []; let ids: string[] = [], used = base;
  for (const a of s.assets) {
    const bytes = a.sizeBytes + 92 + 2 * Buffer.byteLength(assetPath(a));
    if (base + bytes > limit) throw new Error("EXPORT_TOO_LARGE");
    if (used + bytes > limit) { groups.push(ids); ids = []; used = base; }
    ids.push(a.id); used += bytes;
  }
  if (ids.length || !groups.length) groups.push(ids);
  const parts = groups.map((ids, index) => {
    const included = new Set(ids);
    const size = zipSize([{ name: "index.html", size: Buffer.byteLength(partHtml(s, period, ids)) },
      ...s.assets.filter(a => included.has(a.id)).map(a => ({ name: assetPath(a), size: a.sizeBytes }))]);
    return { number: index + 1, ids, size };
  });
  if (parts.some(p => p.size > limit) || parts.length > 200) throw new Error("EXPORT_TOO_LARGE");
  return parts;
}
