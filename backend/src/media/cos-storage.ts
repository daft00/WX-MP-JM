import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac } from "node:crypto";
import COS from "cos-nodejs-sdk-v5";
import { sts } from "tencentcloud-sdk-nodejs-sts";
import { XMLParser } from "fast-xml-parser";
import { Readable } from "node:stream";

export const PREVIEW_LIMIT = 1024 * 1024;
export class InvalidMedia extends Error {}

export function postForm(bucket: string, key: string, size: number, secretId: string, secretKey: string, token: string, expires: number): Record<string, string> {
  const keyTime = `${Math.floor(Date.now() / 1000) - 30};${expires}`;
  const fields: Record<string, string> = { key, acl: "default", "q-sign-algorithm": "sha1", "q-ak": secretId, "q-sign-time": keyTime,
    "x-cos-security-token": token, success_action_status: "204" };
  const policy = JSON.stringify({ expiration: new Date(expires * 1000).toISOString(),
    conditions: [{ bucket }, ...Object.entries(fields).map(([name, value]) => ({ [name]: value })), ["content-length-range", size, size]] });
  const signKey = createHmac("sha1", secretKey).update(keyTime).digest("hex");
  return { ...fields, policy: Buffer.from(policy).toString("base64"),
    "q-key-time": keyTime, "q-signature": createHmac("sha1", signKey).update(createHash("sha1").update(policy).digest("hex")).digest("hex") };
}

@Injectable()
export class CosStorage {
  private client?: COS;
  private exportClient?: COS;
  private tokenClient?: InstanceType<typeof sts.v20180813.Client>;
  constructor(private readonly config: ConfigService) {}
  get enabled() { return this.config.get("MEDIA_ENABLED") === true; }
  private settings() {
    if (!this.enabled) throw new ServiceUnavailableException("Media storage is not configured");
    return { Bucket: this.config.getOrThrow<string>("COS_BUCKET"), Region: this.config.getOrThrow<string>("COS_REGION") };
  }
  private sdk() {
    this.settings();
    return this.client ??= new COS({ SecretId: this.config.getOrThrow("COS_SECRET_ID"), SecretKey: this.config.getOrThrow("COS_SECRET_KEY"),
      Timeout: 15000, Protocol: "https:" });
  }
  private params(Key: string) { return { ...this.settings(), Key }; }
  async upload(key: string, size: number, deadline: Date) {
    const { Bucket, Region } = this.settings();
    const duration = Math.min(300, Math.floor((deadline.getTime() - Date.now()) / 1000));
    if (duration < 30) throw new InvalidMedia("Upload authorization expired");
    const client = this.tokenClient ??= new sts.v20180813.Client({ credential: { secretId: this.config.getOrThrow("COS_SECRET_ID"), secretKey: this.config.getOrThrow("COS_SECRET_KEY") },
      region: Region, profile: { httpProfile: { reqTimeout: 10 } } });
    const result = await client.GetFederationToken({ Name: "growth-media", DurationSeconds: duration,
      Policy: JSON.stringify({ version: "2.0", statement: [{ effect: "allow", action: ["name/cos:PostObject"],
        resource: [`qcs::cos:${Region}:uid/${Bucket.split("-").at(-1)}:${Bucket}/${key}`] }] }) });
    const c = result.Credentials;
    if (!c?.TmpSecretId || !c.TmpSecretKey || !c.Token || !result.ExpiredTime) throw new Error("Invalid STS response");
    // 不下发TmpSecretKey；签名表单进一步固定对象大小，客户端不能扩大STS权限。
    return { url: `https://${Bucket}.cos.${Region}.myqcloud.com/`,
      formData: postForm(Bucket, key, size, c.TmpSecretId, c.TmpSecretKey, c.Token, Math.min(result.ExpiredTime, Math.floor(deadline.getTime() / 1000))) };
  }
  async head(key: string): Promise<{ size: number; etag: string } | undefined> {
    try {
      const result = await this.sdk().headObject(this.params(key));
      const size = Number(result.headers?.["content-length"]);
      if (!Number.isSafeInteger(size) || size <= 0) throw new InvalidMedia("Invalid object size");
      return { size, etag: result.ETag };
    } catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return undefined; throw error; }
  }
  async freeze(source: string, target: string, size: number) {
    if (await this.head(target)) return;
    const info = await this.head(source);
    if (!info || info.size !== size) throw new InvalidMedia("Uploaded size differs from reservation");
    const { Bucket, Region } = this.settings();
    await this.sdk().putObjectCopy({ ...this.params(target), CopySource: `${Bucket}.cos.${Region}.myqcloud.com/${source}`,
      CopySourceIfMatch: info.etag, MetadataDirective: "Replaced", ContentType: "application/octet-stream", CacheControl: "private, no-store" });
  }
  url(key: string, query: Record<string, string> = {}): string {
    return this.sdk().getObjectUrl({ ...this.params(key), Sign: true, Expires: 300, Query: query });
  }
  private async read(key: string, query: Record<string, string>, limit: number): Promise<Buffer> {
    const response = await fetch(this.url(key, query), { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("COS processing failed"); }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > limit) throw new InvalidMedia("Processing output exceeds limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async inspect(key: string, kind: string): Promise<string> {
    if (kind === "IMAGE") {
      const info = JSON.parse((await this.read(key, { imageInfo: "" }, 64 * 1024)).toString());
      if (!["jpeg", "png", "gif", "webp"].includes(info.format) || !(Number(info.width) > 0) || !(Number(info.height) > 0)) throw new InvalidMedia("Unsupported image format");
      return `image/${info.format}`;
    }
    const info = new XMLParser().parse((await this.read(key, { "ci-process": "videoinfo" }, 256 * 1024)).toString());
    const media = info.Response?.MediaInfo;
    if (!media?.Stream?.Video || !String(media.Format?.FormatName).split(",").some((v) => ["mov", "mp4"].includes(v))) throw new InvalidMedia("Unsupported video format");
    return "video/mp4";
  }
  async preview(key: string, kind: string, target: string): Promise<number> {
    const existing = await this.head(target);
    if (existing) { if (existing.size > PREVIEW_LIMIT) throw new InvalidMedia("Preview too large"); return existing.size; }
    const query: Record<string, string> = kind === "IMAGE" ? { "imageMogr2/thumbnail/600x600/format/jpg/quality/75": "" }
      : { "ci-process": "snapshot", time: "0", width: "600", format: "jpg" };
    const bytes = await this.read(key, query, PREVIEW_LIMIT);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new InvalidMedia("Invalid preview");
    await this.sdk().putObject({ ...this.params(target), Body: bytes, ContentType: "image/jpeg", CacheControl: "private, no-store" });
    return bytes.length;
  }
  async remove(key: string) { await this.sdk().deleteObject(this.params(key)); }
  async *stream(key: string, size: number): AsyncIterable<Uint8Array> {
    const head = await this.head(key);
    if (!head || head.size !== size) throw new InvalidMedia("Export source changed");
    const response = await fetch(this.url(key), { headers: { "If-Match": head.etag }, redirect: "error", signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Export source unavailable"); }
    let read = 0;
    for await (const bytes of response.body) { read += bytes.length; if (read > size) throw new InvalidMedia("Export source changed"); yield bytes; }
    if (read !== size) throw new InvalidMedia("Export source incomplete");
  }
  async putStream(key: string, body: Readable, size: number) {
    const params = this.params(key);
    const client = this.exportClient ??= new COS({ SecretId: this.config.getOrThrow("COS_SECRET_ID"), SecretKey: this.config.getOrThrow("COS_SECRET_KEY"), Timeout: 300000, Protocol: "https:" });
    await client.putObject({ ...params, Body: body, ContentLength: size, ContentType: "application/zip", CacheControl: "private, no-store" });
    if ((await this.head(key))?.size !== size) throw new Error("Export upload incomplete");
  }
}
