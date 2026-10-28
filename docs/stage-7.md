# 阶段7：隐私、记录删除与家庭解散

更新：2026-10-26。代码已修改，未部署、未操作生产数据库。

用户明确范围：**不做内容审核、申诉和账号注销**。删除数据仅针对选定的一条记录及其媒体；解散家庭则处理整个家庭。运营者daft，联系邮箱daft138@gmail.com。平台发布要求仍须在实际后台核验，本次范围调整不代表已经通过平台审核。

## 已实现

- 隐私/使用约定、监护人确认、SHA256版本化同意及服务端428检查。业务、电脑导出会话均复核同意；说明、身份、退出与数据申请可独立访问。
- 非OWNER退出家庭；OWNER可转让给现有成员，旧OWNER降为ADMIN，未使用的邀请码失效。退出不会删除共享记录。
- 指定记录删除申请、家庭解散申请、SYSTEM_ADMIN分页审核与理由审计；不能审核自己的申请，系统管理角色不会获得家庭内容访问权。
- 审核通过后由申请人再次确认执行，重新核对当前家庭权限。执行前可撤销；PROCESSING后不可撤销。
- 删除状态PROCESSING/COMPLETED，后台清理失败保留进度并重试，页面显示中文状态和错误说明。
- 现有家庭OWNER/ADMIN直接删除单条记录的权限保留，也通过同一持久清理流程处理，并能在“数据处理申请”查看进度。普通MEMBER不获得删除权限。

## 删除范围与完成含义

### 单条记录

指定familyId及entryId，服务端验证记录确实属于该家庭。直接删除或批准后确认执行时，在一个事务中：锁定家庭、记录关联媒体ID、作废该宝宝现有历史导出、撤销家庭电脑配对会话、标记媒体DELETING、删除记录（级联指标和素材关联），写入清理任务与审计。

其他记录、宝宝档案不删除。该宝宝所有历史导出包及数据库快照会清理，避免已删除内容通过旧导出继续访问；原始剩余记录可重新导出。同一家庭同时只执行一个删除任务，处理期间暂不新建导出。

后台逐批清理原媒体、预览图、临时上传对象和历史导出包。已签发的上传权限须等到到期并额外等待60秒，避免删除后客户端再次写入。每个对象删除成功后才删除对应数据库资产并释放配额；任一失败回滚该批数据库变更，下一轮幂等重试云删除。

### 解散家庭

必须由当前OWNER申请，另一名SYSTEM_ADMIN审核，再由该申请人（仍为当前OWNER）确认执行。转让后原OWNER不能执行旧申请。审核本身不启动删除。

执行即标记家庭正在解散，从家庭选择列表隐藏，并拒绝成员读取、写入、加入、角色变更及新签名；撤销邀请和电脑会话，取消其他未执行申请，移除家庭记录并标记媒体删除。先清理全部导出与媒体，确认无剩余占用后删除宝宝、成员、配额账本及家庭行。

用户账号、其他家庭及一次性开户资格不会被重置。申请与必要审计保留，family_id外键置空并保留目标UUID用于处理追踪；不保留记录正文在清理任务中。单条记录的幂等账本保留，避免旧创建请求重试复活记录；家庭解散后其账本随家庭清理。

### 边界

- COMPLETED表示本流程涉及的在线业务数据和当前COS对象清理完成，不表示离线备份、用户下载/分享副本被同步销毁。
- 备份按运营者实际配置的保存周期到期处理；恢复旧备份时必须复核备份之后的删除审计，不能把旧备份直接恢复后开放访问。
- COS须符合阶段5要求：私有桶、关闭版本控制。多版本、对象锁定或额外复制不属于此执行器的删除范围，启用前需另行设计。
- 已签发短时链接在对象实际删除前可能仍可使用；已下载文件无法远程撤回。
- 非标准历史媒体键会停留在处理中并报LEGACY_MEDIA_REQUIRES_REVIEW，维护者需核实迁移/清理，不能随意更新为COMPLETED。MEDIA_LEDGER_REQUIRES_REVIEW同理。
- 删除worker和导出worker共用数据库连接锁，防止取消后的在途ZIP重新生成。媒体worker和删除worker共用家庭行锁；不提前释放占用。

## 接口约定

前缀 `/api/v1`；除说明外使用本人Bearer会话：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| GET | /governance/documents | 公开说明及版本 |
| GET / POST | /governance/consent | 查询同意；提交version、accepted=true、guardian=true |
| GET | /governance/requests | 本人申请分页 |
| POST | /governance/requests | requestId(UUIDv4)、kind、familyId、reason；DATA_DELETE还必须有entryId；FAMILY_DISSOLVE不允许entryId |
| DELETE | /governance/requests/:id | 本人撤销PENDING/APPROVED申请 |
| POST | /governance/requests/:id/execute | 本人明确提交confirmed=true；只执行已批准的明确目标，处理中/完成重试返回当前状态 |
| GET | /governance/admin/requests | SYSTEM_ADMIN分页查看申请 |
| POST | /governance/admin/requests/:id/review | decision=APPROVED/REJECTED及reason，不执行删除 |
| DELETE | /families/:familyId/entries/:id | 保留原有OWNER/ADMIN直接删除权限；204表示记录已移除并已排队清理，不是COS已清理完成 |
| POST | /families/:familyId/leave | 非OWNER退出 |
| POST | /families/:familyId/owner/:memberId | OWNER转让 |

仅支持DATA_DELETE和FAMILY_DISSOLVE；ACCOUNT_CLOSE请求返回400。申请入口限制每用户最多一项待审核、已批准或处理中的申请；现有直接删除入口按家庭串行。请求ID幂等且绑定明确家庭/记录。系统管理员审核不绕过成员身份及删除权限。完成状态带completed_at，失败原因只使用固定错误码，不输出COS签名、SQL或密钥。

## 配置、迁移与部署顺序

1. 第七项迁移的两个外键名曾与entry_requests重复，已改为fk_data_request_user/fk_data_request_family。这是修复尚未部署代码的建表冲突；若曾尝试旧第七项迁移且产生policy_consents残表，先核对schema_migrations及实际表，不盲目重跑或删除生产表。
2. 新增第八项迁移DataDeletion1790985607000：家庭删除标识、申请精确目标、媒体ID清单、开始/完成/错误字段及新状态；保留审计和申请时允许家庭外键SET NULL。
3. 第八项将旧PENDING/APPROVED申请取消并标记RESUBMIT_WITH_EXPLICIT_TARGET，要求重新确认明确范围，不让旧的泛化申请授权破坏性操作。迁移不删除业务内容；已有删除历史则拒绝回滚。
4. 必须先在专用空MySQL8.4库执行全部8项迁移及 `npm --prefix backend run test:db`。新增真实库用例覆盖记录范围、配额失败回滚和家庭外键清理；本机尚未运行。
5. 部署维护窗口先备份，并停止API及media/export/deletion三个timer和service；按现有流程迁移、激活，再安装新worker：

```bash
sudo install -m 0644 scripts/deploy/growth-diary-deletion.service scripts/deploy/growth-diary-deletion.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now growth-diary-deletion.timer
sudo systemctl start growth-diary-media.timer growth-diary-export.timer
sudo systemctl list-timers 'growth-diary-*'
sudo journalctl -u growth-diary-deletion.service -n 30 --no-pager
```

这些命令仅为后续部署说明，本次未执行。删除worker每60秒运行一次，最多处理一个申请的一批数据；COS未配置时，有媒体的任务会停留在处理中并告警，不能用于正式数据删除承诺。仅文字且无导出对象的任务无需COS可完成。

运维monitor.py已增加删除worker、处理超时及清理错误检查，须在第八项迁移及新worker部署后一起更新。

公开配置保持：

```dotenv
GOVERNANCE_ENABLED=false
LEGAL_OPERATOR=daft
LEGAL_CONTACT=daft138@gmail.com
LEGAL_RETENTION_NOTE=
```

按真实备份和审计留存规则填写LEGAL_RETENTION_NOTE并核对正文后再启用GOVERNANCE_ENABLED=true，配置不足拒绝启动/同意。此次正文变更会使旧同意版本失效。

## 验证与剩余工作

- 后端构建/测试：95项，94通过、1项真实MySQL连接检查跳过；包括实际COS SDK经本地HTTP模拟服务验证503后重试、配额不提前释放、重复删除的幂等性。
- MySQL集成测试已扩充并编译，未实际运行；真实COS、systemd、微信真机尚待验收。未部署、提交或推送Git。
- 阶段7仍需补齐管理页的配额/失败任务等界面，以及微信原生权限拒绝流程的真机验收。内容审核、申诉和账号注销已移出开发范围，不继续列为待开发事项。

## 管理中心入口与概览（2026-10-27）

家庭选择页向系统管理员显示“管理中心”，无需选择家庭或宝宝；进入后读取当前身份及GET /admin/dashboard，展示家庭、用户、宝宝、记录、素材数量。素材计数包含处理中及待清理资产，不等于存储用量。提供刷新/错误重试/返回入口；失败与离开页面清空统计并拒绝迟到响应。普通用户直达页面不能获取概览，服务端仍按数据库当前系统角色鉴权。

验收：以系统管理员进入并刷新；以普通用户直达页面应显示无权限；断网刷新不保留旧数据；无家庭的系统管理员也能访问。配额、失败任务及列表等不在本次范围。未做真机和线上联调。

## 管理中心家庭与用户列表（2026-10-27）

概览下提供家庭/用户列表切换，点击后加载第一页，每页20条，支持翻页、刷新及失败时重试当前页。家庭展示名称、创建者、宝宝/记录/素材数量；用户展示昵称、系统角色、参与家庭和发布记录数量；均展示可选择复制的ID。复用GET /admin/families及GET /admin/users的page/pageSize/hasMore契约，不新增数据库迁移。

验收：管理员无家庭选择时也可读取；检查空列表及20条以上数据的翻页；断网重试应请求原失败页；加载期间切换列表或离开不能被旧响应覆盖；撤销权限后的读取应清空管理视图。offset分页不提供跨页快照，并发增删后可刷新。真实MySQL和微信真机联调待执行。

## 失败任务管理（2026-10-27）

管理中心已添加媒体、导出和删除异常任务分页，显示安全错误码、时间、尝试次数与处理建议。可重新排队的媒体临时故障需填写原因并记录审计，仍由原有worker复核/清理。导出失败需家庭管理员重新创建；删除任务自动重试，历史对象/账本异常仅提示人工核查。无强制完成、绕过权限或提前释放配额操作。详见[接口与验收](../backend/docs/admin-failures.md)。先部署后端，再验收小程序；真实数据库、COS、timer和真机尚未联调。家庭/用户列表已完成，配额、成员维护和审计界面仍待实施。

## 成员维护与审计记录（2026-10-27）

家庭列表的“维护成员”进入独立家庭范围的分页列表，无需成为家庭成员。SYSTEM_ADMIN只能修改非OWNER、非自身成员的ADMIN/MEMBER角色或移出成员。需填写1–400字原因并再次确认目标和影响；移出不会删除已有记录，已下载内容无法撤回。写入失败或结果不确定时清空旧按钮，先刷新核实。服务端在事务内复核角色、成员范围，降级/移除撤销邀请码并记审计。

微信wx.request不支持PATCH，新增PUT /api/v1/admin/families/:familyId/members/:memberId，JSON为role和reason，返回成员；原PATCH接口保留。DELETE同路径JSON为reason，成功204。成员GET同家庭路径，page/pageSize分页。先部署新后端再使用小程序角色调整，无新迁移。

“审计记录”复用GET /api/v1/admin/audit-logs，支持familyId、actorId（UUID v4）和action（大写字母开头，后续大写字母/数字/下划线，最多80字符）；均可留空，每页20条。输入条件需点击应用后才生效，翻页/重试使用已应用条件。返回id、actorId、familyId、action、targetType、targetId、reason、createdAt；时间UTC，解散家庭后的familyId可为null。页面展示原因原文，不提供修改或删除审计功能。

本地验证：前端60项57通过/3项既有HTTP模拟跳过，管理后端9项通过，后端构建、测试编译、WXML编译通过。尚未真实MySQL/微信真机联调。验收重点：普通用户不可访问；OWNER/自身无操作按钮；其他成员升降级/移除后列表刷新；对应SYSTEM_MEMBER_ROLE/SYSTEM_MEMBER_REMOVE可在审计筛选中找到；断网和撤权不可沿用旧按钮。

## 配额管理（2026-10-28）

家庭列表新增配额读取/调整，展示已用/预留/剩余及存储启用状态，原因与二次确认，复用后端占用下限及审计。详见[媒体配额说明](../backend/docs/media.md)。此前列出的管理中心入口、家庭/用户列表、异常任务、成员维护、审计、配额界面均已接入；不表示阶段7真实环境验收完成。下一步为测试库迁移与业务验证、COS/worker及原生权限真机验收。
