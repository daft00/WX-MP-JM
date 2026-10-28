import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service";
import { FamiliesService } from "../families/families.service";
import { AdminPageDto } from "../admin/admin.dto";

@Injectable()
export class GovernanceService {
  constructor(private readonly db: DatabaseService, private readonly families: FamiliesService, private readonly config: ConfigService) {}
  documents() {
    const operator = this.config.get<string>("LEGAL_OPERATOR") || "", contact = this.config.get<string>("LEGAL_CONTACT") || "";
    const retention = this.config.get<string>("LEGAL_RETENTION_NOTE") || "";
    const enabled = this.config.get("GOVERNANCE_ENABLED") === true;
    const paragraphs = [
      "成长日记用于家庭私有的成长记录。请仅上传你有权处理的资料；涉及未成年人时，你须为监护人或已获得监护人授权。不得上传违法、侵权或与服务无关的内容。",
      "微信登录处理微信身份标识并建立会话；保存昵称、家庭成员关系、宝宝档案、记录、成长指标及你主动选择的照片和视频。相关内容按家庭成员权限共享。",
      "后端和MySQL保存业务数据；媒体保存在腾讯云私有COS，数据万象处理媒体格式与预览图。访问使用短时签名地址；已下载文件和尚未过期的签名地址不能立即撤回。",
      "导出任务会保存内容快照并生成临时ZIP，导出包保留24小时，清理失败会重试；任务记录和快照仍可能保存在数据库中。电脑配对使用短时Cookie，不向电脑提供小程序登录令牌。",
      "本机保存登录会话、家庭选择、待上传任务及草稿；退出会清理应用保存的会话与草稿，已下载或分享的文件需要自行管理。相册、相机及扫码权限仅在你使用对应功能时申请，拒绝后仍可使用文字功能。",
      "退出家庭不会删除共享内容。本服务不提供账号注销。家庭管理员可删除指定记录及其媒体；删除申请通过审核后仍需申请人确认执行。解散家庭仅由当前OWNER确认，会清除该家庭所有宝宝档案、记录及媒体，影响所有成员。执行后不可撤销。",
      "删除时先停止相关内容访问，再异步清理媒体与受影响宝宝的历史导出包和快照，清理完成才标记完成。备份按运营者公布的周期到期清理；已下载副本无法远程删除。申请、幂等标识及必要审计记录仍保留，不宣称所有痕迹立即消失。",
      "成长指标仅用于记录和展示，不提供诊断或医疗结论。请自行保留重要资料的独立备份。",
      `运营者：${operator || "待配置"}；联系邮箱：${contact || "待配置"}`,
      `保存与备份处理说明：${retention || "待运营者核实并配置"}`,
    ];
    const version = createHash("sha256").update(JSON.stringify(paragraphs)).digest("hex");
    return { enabled, ready: Boolean(operator && contact && retention), version, operator, contact, paragraphs };
  }
  async status(user: string) {
    const doc = this.documents();
    const accepted = await this.db.transaction(async m => (await m.query("SELECT 1 FROM policy_consents WHERE user_id = ? AND version = ?", [user, doc.version])).length > 0);
    return { ...doc, accepted };
  }
  async requireConsent(user: string) {
    if (!this.documents().enabled) return;
    const status = await this.status(user);
    if (!status.ready || !status.accepted) throw new HttpException("POLICY_CONSENT_REQUIRED", 428);
  }
  accept(user: string, version: string) {
    const doc = this.documents();
    if (!doc.ready) throw new ServiceUnavailableException("Policy is not configured");
    if (doc.version !== version) throw new ConflictException("Policy changed; reload before accepting");
    return this.db.transaction(async m => {
      await m.query("INSERT INTO policy_consents (user_id, version) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)", [user, version]);
      return { accepted: true, version };
    });
  }
  submit(user: string, b: { requestId: string; kind: string; familyId?: string; entryId?: string; reason: string }) {
    if (!["DATA_DELETE", "FAMILY_DISSOLVE"].includes(b.kind) || !b.familyId || (b.kind === "DATA_DELETE" ? !b.entryId : Boolean(b.entryId))) throw new BadRequestException("Explicit family and record scope required; account closure is unavailable");
    return this.db.transaction(async m => {
      // Lock user first to bound simultaneous applications without a check/insert race.
      await m.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [user]);
      const [old] = await m.query("SELECT * FROM data_requests WHERE user_id = ? AND request_id = ?", [user, b.requestId]);
      if (old) {
        if (old.kind !== b.kind || old.reason !== b.reason || old.target_family_id !== b.familyId || old.entry_id !== (b.entryId || null)) throw new ConflictException();
        return old;
      }
      if (b.familyId) {
        const { actor } = await this.families.requireMember(m, b.familyId, user);
        if (b.kind === "FAMILY_DISSOLVE" && actor.role !== "OWNER") throw new ForbiddenException("Owner required");
        if (b.kind === "DATA_DELETE") {
          if (!["OWNER", "ADMIN"].includes(actor.role)) throw new ForbiddenException("Family administrator required");
          if (!(await m.query("SELECT id FROM entries WHERE family_id = ? AND id = ?", [b.familyId, b.entryId])).length) throw new NotFoundException("Entry not found");
        }
      }
      if ((await m.query("SELECT id FROM data_requests WHERE user_id = ? AND status IN ('PENDING','APPROVED','PROCESSING') LIMIT 1", [user])).length) throw new ConflictException("An application is already being handled");
      const id = randomUUID();
      await m.query("INSERT INTO data_requests (id, user_id, family_id, target_family_id, request_id, kind, reason, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, user, b.familyId, b.familyId, b.requestId, b.kind, b.reason, b.entryId || null]);
      const [row] = await m.query("SELECT * FROM data_requests WHERE id = ?", [id]); return row;
    });
  }
  list(user: string, query: AdminPageDto, admin = false) {
    return this.db.transaction(async m => {
      if (admin) {
        const [actor] = await m.query("SELECT system_role FROM users WHERE id = ? FOR SHARE", [user]);
        if (actor?.system_role !== "SYSTEM_ADMIN") throw new ForbiddenException();
      }
      const rows = await m.query(`SELECT * FROM data_requests ${admin ? "" : "WHERE user_id = ?"} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...(admin ? [] : [user]), query.pageSize + 1, (query.page - 1) * query.pageSize]);
      return { items: rows.slice(0, query.pageSize), hasMore: rows.length > query.pageSize, page: query.page };
    });
  }
  review(actor: string, id: string, decision: "APPROVED" | "REJECTED", reason: string) {
    return this.db.transaction(async m => {
      const [user] = await m.query("SELECT system_role FROM users WHERE id = ? FOR SHARE", [actor]);
      if (user?.system_role !== "SYSTEM_ADMIN") throw new ForbiddenException();
      const [row] = await m.query("SELECT * FROM data_requests WHERE id = ? FOR UPDATE", [id]);
      if (!row) throw new NotFoundException();
      if (row.user_id === actor) throw new ForbiddenException("Cannot review your own request");
      if (row.status !== "PENDING") throw new ConflictException("Already reviewed");
      await m.query("UPDATE data_requests SET status = ?, review_reason = ?, reviewer_id = ? WHERE id = ?", [decision, reason, actor, id]);
      await this.families.audit(m, actor, row.family_id, `DATA_REQUEST_${decision}`, "data_request", id, reason);
      return { id, status: decision };
    });
  }
  cancel(user: string, id: string) {
    return this.db.transaction(async m => {
      const [row] = await m.query("SELECT * FROM data_requests WHERE id = ? AND user_id = ? FOR UPDATE", [id, user]);
      if (!row) throw new NotFoundException();
      if (!["PENDING", "APPROVED", "CANCELLED"].includes(row.status)) throw new ConflictException("Deletion already started and cannot be cancelled");
      await m.query("UPDATE data_requests SET status = 'CANCELLED' WHERE id = ?", [id]);
    });
  }
}
