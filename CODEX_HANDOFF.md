# 成长日记项目交接文档

更新时间：2026-10-28（Asia/Shanghai）。本文统一替换之前混有过时状态的交接内容；以下区分本地代码、已执行测试和用户此前确认的服务器情况。本文不含密码、Token、密钥或数据库连接串。

## 接手必读

- 实际Git根目录为当前文档所在的 `manman WX program`；外层工作区为 `C:\Users\Daft Jiang\Desktop\Daft Dev\WX MP JM`。外层还有 `正式版实施计划.md`。
- 小程序已经接入真实HTTP服务，不再是仅Mock原型。阶段3–8的主要业务、管理及运维代码已实现，但不等于部署或正式上线。
- 2026-10-28核对：分支main，HEAD为`58ae428`（`update 1022`），相对本地origin/main超前1提交；未fetch，不能断言远端实时状态。大量已跟踪修改及未跟踪文件仍未提交。本次交接整理不提交、不推送、不部署。
- 用户原有 `Design/` 未跟踪目录、`project-architecture.png` 删除/移动状态及其他修改必须保留。不要reset、clean、覆盖或恢复这些文件。
- 默认中文沟通。用户希望逐步实施，给出可操作步骤并按阶段确认；明确要求开发时直接实现，避免无关重构。生产迁移、删除、上线须结合当次授权和实际状态执行，不沿用历史授权。
- 开始下一任务先读本文、相关阶段文档及代码，检查git status/diff。文档中旧阶段测试数字是历史，不用其否定本文最新结果。

## 1. 项目目标和当前需求

“成长日记”是家庭私有的微信小程序：微信登录，邀请/审批开户，多家庭、多宝宝，文字、图片、视频、里程碑和成长指标记录，记录墙、导出、家庭协作及系统管理。

当前用户需求已明确：

- 家庭角色OWNER、ADMIN、MEMBER；SYSTEM_ADMIN是独立系统角色，不自动获得家庭私有内容访问权。
- 不做内容审核、申诉、账号注销。不要再次把这三项列为待开发；平台正式审核条件仍需以实际主体/类目核实。
- 单独删除数据限“选定的一条记录及其媒体”；家庭解散清理整个家庭，保留用户账号及必要审计。
- 不接入付费内容审核服务。COS和数据万象媒体处理属于另一类服务，尚待配置及费用确认。
- 管理中心入口/概览、家庭用户列表、失败任务、成员维护、审计及配额界面均已完成代码接入。
- 最新讨论转向上线准备：需要工具清单、每步操作与验收标准。当前应推进正式界面/权限收尾、真实测试、配置、部署与上线验收，而不是重复开发已完成模块。
- AI成长/健康分析只讨论过，未确定模型或实现，不在本轮上线核心范围。

## 2. 已完成修改

### 2.1 阶段3–4：真实会话、家庭和记录

- 真实微信HTTP登录、独立IdentitySession、401清理、并发/身份切换保护；家庭/宝宝选择与档案维护。
- 邀请加入、一次性创建家庭资格、系统管理员开户审批、昵称维护、家庭成员管理。
- 真实记录墙、年份/月份筛选、分页、记录创建/编辑/删除、指标分页。创建请求ID幂等。
- 图片/视频本地压缩及上传大小限制；媒体支持后由真实服务管理，不回退Mock。
- 开户审批现有入口仍在家庭选择页，需要输入用户UUID和理由；尚未做用户列表内的一键审批扩展，不是现有审批功能缺失。

### 2.2 阶段5–6：私有媒体和云导出

- 私有COS单对象临时上传表单、后台冻结/格式和大小复核、图片缩略图/视频封面、私有短时读取。
- 家庭配额默认10GiB；预留、已用及历史资产统计，真实清理成功才释放占用。
- 媒体上传恢复、取消、孤立素材和临时对象清理；默认MEDIA_ENABLED=false，不能宣称真实COS已开通。
- 云导出100MiB分包、离线HTML、快照与权限复核、有限重试、过期/取消清理；电脑扫码配对下载。
- 单个导出包过期24小时、签名读取短时有效；全局export worker锁协调导出与删除，不能并行手动绕开worker。

### 2.3 阶段7：隐私、家庭退出和实际删除

- 隐私/使用说明、监护人确认、版本化同意、服务端428拦截；GOVERNANCE_ENABLED默认关闭。运营者及联系方式已由用户提供并填入配置示例，真实留存规则仍待配置。
- 普通成员退出，OWNER先转让所有权或申请解散，不能留下无OWNER家庭。
- 明确目标的数据请求、SYSTEM_ADMIN分页审核，禁止自行审核自己的申请；APPROVED后仍由申请本人确认执行。
- 直接删除记录与申请执行共用持久清理流程；PROCESSING/COMPLETED状态，云清理失败保留任务与配额并重试。
- 单条删除清理该记录媒体及该宝宝既有导出/快照；解散家庭清理成员、宝宝、记录、媒体和导出，家庭进入deleting_at后拒绝业务访问。
- 删除前等待上传凭证到期加60秒，避免仍有效上传表单重新写入；只清理认可的对象键，历史路径/账本异常需人工核查。
- 外键SET NULL保留申请/审计，target_family_id保留目标身份。用户账号不删除。离线备份和用户已下载文件不在即时清理范围。

### 2.4 管理中心（2026-10-27至28最新工作）

- 注册system-admin页面；家庭选择页仅向SYSTEM_ADMIN显示入口，不要求先选家庭。
- GET /admin/dashboard读取家庭、用户、宝宝、记录、素材计数。每次进入重新核验身份；失败清空旧数据，离开/切换忽略迟到响应。
- 家庭/用户列表每页20条，上一页/下一页、刷新、错误重试，公开身份/统计及可复制ID；不加载私有记录内容。
- 异常任务按MEDIA/EXPORT/DELETION分页，仅返回安全错误码、状态、时间、尝试次数、清理状态等元数据。
- 媒体PROCESSING_RETRY符合当前worker条件时可填原因重新排队，仅更新next_attempt_at并审计SYSTEM_MEDIA_RETRY，不改状态、不释放配额。保护期内、无效媒体等拒绝。导出失败由家庭管理员重新创建，删除worker自动重试；无强制成功入口。
- 家庭卡片“维护成员”：分页，ADMIN/MEMBER调整和移出，保护OWNER/自身；原因1–400字，明确目标和影响后二次确认；结果不确定时清空旧按钮要求刷新。
- wx.request不支持PATCH，新增PUT /admin/families/:familyId/members/:memberId，复用原changeRole；原PATCH保留。DELETE同路径带reason。必须先部署新后端再使用小程序角色调整。
- 审计分页，按familyId、actorId（UUID v4）、action筛选；草稿须点应用后生效，翻页沿用已应用条件。显示UTC时间、目标、原因，家庭解散后familyId可空；无编辑/删除审计入口。
- 家庭卡片“管理配额”：新增管理员GET /admin/families/:familyId/storage，在角色/家庭锁内复用用量统计，含无上传账本的历史资产。
- 配额PUT复用原服务；前端整数MiB输入1–1048576，显示MiB与精确字节；原因1–470字及二次确认，后端reason新增trim；后端接受1字节至1TiB整数，禁止低于已用+预留。审计STORAGE_QUOTA_UPDATE，不删除文件或启用COS。失败清空旧配额要求刷新。

### 2.5 阶段8：运维代码

- Python标准库实现加密异机备份、SHA256回执、最近7天/4周保留、专用空库恢复检查。
- GPG加密不落明文SQL，生产只持公钥；SSH固定host key，恢复凭据只限测试恢复库。
- systemd备份/巡检timer；磁盘、API、数据库连接、备份时效、TLS、worker、失败任务与Nginx 5xx巡检。
- 通知模板支持变化/恢复/持续故障重报，实际通知渠道未选定/验收；主机宕机需外部监控。
- 发布证据门槛检查域名校验、干净Git、提交号、近期验收证据及至少7天体验；不自动上传/发布，不保证审核通过。
- GitHub workflow保持用户要求的PR检查，不擅自恢复push触发。

## 3. 涉及文件和关键代码位置

以下相对路径均从本文件目录解析；行号为本次核对时的位置，后续可能移动。

| 位置 | 用途 |
| --- | --- |
| miniprogram/pages/system-admin/index.ts | 管理中心：loadDashboard约72行，loadList约109行，openQuota约159行，saveQuota约168行，applyAuditFilter约216行，maintainMember约232行 |
| miniprogram/pages/system-admin/index.wxml / index.wxss | 概览、列表、异常、成员、审计和配额界面 |
| miniprogram/pages/select-family/index.ts / index.wxml | 登录/家庭选择、管理入口、开户审批；仍有待整理的旧文案 |
| miniprogram/app.json | 正式页面注册与Tab配置 |
| miniprogram/services/contracts.ts / types/models.ts | 服务与数据契约，StorageQuota、AuditFilter/Record、FailedTask等 |
| miniprogram/services/http-services.ts | 真实会话、鉴权请求、管理接口；未接入拒绝仅剩原型账号操作 |
| miniprogram/services/api-config.ts | 正式API与仅开发者工具可用的本机隧道覆盖 |
| miniprogram/services/http-uploads.ts / http-exports.ts | 上传恢复、私有媒体、云导出客户端 |
| miniprogram/services/mock-services.ts | 历史原型/测试实现；生产services/index.ts不导入它 |
| miniprogram/utils/dialog.ts | 原因输入、确认框复用 |
| backend/src/admin/admin.service.ts | failedTasks约37行，retryMedia约67行，members约133行，audits约143行；target/changeRole/remove保护与审计 |
| backend/src/admin/admin.controller.ts / admin.dto.ts | 管理路由、分页/UUID/原因校验；setRole PUT约46行 |
| backend/src/media/media.service.ts | adminQuota约30行，setQuota约38行；usage统计与上传/清理worker |
| backend/src/media/media.controller.ts / media.dto.ts | 配额GET/PUT、上传接口，配额边界与原因trim |
| backend/src/governance/ | 政策同意、请求审核、deletion.service.ts持久删除、worker.ts |
| backend/src/exports/ | 导出快照、分包、worker、电脑配对 |
| backend/src/database/data-source.ts / migrations/ | 按顺序注册8项迁移 |
| backend/.env.example / src/config.ts | 变量示例及配置校验；只保留示例，不写真实凭据 |
| test/http-services.test.cjs | 管理中心与HTTP客户端、分页、确认、并发、配额/审计测试 |
| backend/test/admin.test.ts / media.test.ts | 管理/配额边界、真实Nest HTTP路由（数据库fixture） |
| backend/test/admin.integration.ts / media.integration.ts / database.integration.test.ts | 真实MySQL套件；已编译未在本轮执行 |
| scripts/build-backend.sh / deploy-backend.sh | 构建、导入、备份、迁移、激活/验证流程 |
| scripts/deploy/ | Nginx、API和media/export/deletion systemd模板，COS权限模板 |
| scripts/ops/ | backup.py、monitor.py、配置模板、notify.example.sh、backup/monitor units、test_ops.py |
| scripts/release-readiness.cjs / docs/release-evidence.example.json | 发布前人工证据检查 |
| docs/stage-3.1.md 至 stage-8.md | 各阶段详细说明；旧段落以最新增量和实际代码为准 |
| backend/docs/media.md / exports.md / admin-failures.md / deployment.md | API契约与部署验收 |
| ../正式版实施计划.md | 外层正式版计划，已增加10月28日管理中心完成进展 |

## 4. 已确定架构和技术决策

- 原生微信小程序TypeScript + NestJS + MySQL8.4，TypeORM迁移，API前缀/api/v1；Nginx反代/systemd运行，无Redis/Kubernetes需求。
- 不自动同步数据库结构；运行账号和迁移账号分离。生产MySQL/API仅本机监听，公网由Nginx HTTPS接入。
- 业务操作在事务中复核成员/系统角色，使用家庭行锁协调配额、上传、删除；前端隐藏按钮不代替服务端鉴权。
- SYSTEM_ADMIN可维护元数据和管理流程，但不能自动读取家庭照片/视频/记录。
- 当前分页复用page/pageSize/hasMore的offset方式；并发增删可能造成跨页变动，不宣称快照一致。
- COS桶私有、测试与生产分离；当前实际删除/配额模型要求关闭桶版本控制。不设media原件自动过期，不公开CDN。
- 图片上限10MiB、视频50MiB，临时表单和最终对象隔离，客户端不持有长期密钥/任意列举删除权限。
- 配额是应用占用限制，不等于云账单封顶；数据万象与流量也可能计费。
- 删除与导出共享连接级GET_LOCK，媒体与删除共享家庭锁。重排不绕过等待期、配额或权限检查。
- production只使用真实服务；原型切换账号/重置数据不可恢复到正式入口。

## 5. 尝试但未采用的方案

- 直接用小程序PATCH改角色：TypeScript/微信wx.request方法集不支持，改为后端同逻辑PUT兼容入口；没有用强制类型转换掩盖问题。
- 旧管理原型一次返回全部家庭/成员/用户：不符合真实分页接口，已替换为独立分页；不为了页面复用把真实数据接回Mock。
- 对所有失败任务提供通用重试/强制成功：会绕过导出快照、无效媒体及删除安全条件，未采用；仅媒体临时错误重新排队，其余提供真实处理建议。
- 账号注销、内容审核和申诉：用户明确移出范围；不要继续实施或当作当前代码欠项。
- 直接在正式库跑集成测试或盲目重试DDL：未采用，要求专用空库；MySQL DDL可能部分提交。
- 手动DNS证书只开timer即自动续期：不可行，需自动验证插件或认证hook/更换验证方式后dry-run。
- 为当前规模引入云数据库、Redis、容器编排、额外测试平台：不是现阶段必要项，没有因此增加依赖或购买服务。
- 早期迁移中year_month未转义导致MySQL语法失败、GET_LOCK返回字符串被严格比较误判，用户后续服务器迁移已通过；不要把这些历史失败继续描述为当前未解决根因。
- 第七迁移外键名曾与旧表重复，已改为fk_data_request_user/family；若服务器曾执行旧版，需先检查残表。

## 6. 当前未完成事项

### 代码收尾

1. 家庭选择页仍有“媒体上传及导出将在后续开放”等过时文案；需按配置更新。开发验收提示只能在达到发布条件后调整。
2. 核对相册/相机/扫码取消、拒绝授权、隐私原生流程与重新尝试；已有调用及错误处理，但尚未完整真机验收，必要时补代码。
3. 告警已有通用HTTPS模板；选定实际渠道后可能需适配，不是假定已收到通知。
4. 自动续期需落地配置，必要时补认证hook。现有监控仅检查证书到期，不会续期。
5. 旧阶段文档存在历史“管理界面未完成”段落，应按最新状态继续整理；本文已统一。
6. 真实联调暴露的问题再做定向修复；不预先宣称不存在缺陷。

### 配置/验收/上线（不能算缺少主要业务代码）

- 空MySQL8.4测试库8项迁移及test:db；新增集成测试仅编译。
- 真实COS/CAM/STS/数据万象配置与上传/读取/删除/导出验收。
- 生产配置、三个业务worker与备份/监控timer安装；角色兼容PUT和配额管理员GET需先部署后端。
- HTTPS公网开放、自动续期、备案、微信类目/合法域名/隐私后台配置；本地关闭域名校验的覆盖需处理。
- GPG公钥、异机备份账号/机器、恢复私钥保管、真实恢复演练；数据库备份不包含COS二进制，需明确媒体保留策略。
- 通知送达/恢复演练、外部主机监控、云预算告警。
- iOS/Android、至少两个家庭三个账号全流程及越权验证，体验版至少一周，审核人员受控进入流程、提交审核。

## 7. 已知风险和服务器历史

- 本地代码仍未部署；不要将单元/本地HTTP模拟通过等同真实MySQL/COS/微信验收。
- 用户此前确认服务器Ubuntu26.04、Node22.22.1、MySQL8.4.11、约2GB内存+2GB swap，MySQL127.0.0.1:3306、API127.0.0.1:3000；本轮未SSH核实。
- 用户最后明确验证过的发布目录为 `/opt/growth-diary/releases/r20261022T162436Z`，systemd/健康/数据库/迁移检查PASS，代理限流前10次400、第11次429。不能假定后续阶段已上线。
- 域名api.daftjiang.cn；此前备案中、HTTPS仅本机验证通过，Nginx曾只监听127.0.0.1:443。现在状态待核实。
- 手动DNS证书此前显示到期2027-01-20且未自动续期；必须重新查看实际证书状态，不把历史日期当作当前实测。
- 当前共8项迁移：InitialSchema、AuthSessions、FamilyCreation、EntryRequests、Media、Exports、Governance、DataDeletion；实际名称以data-source.ts为准。
- 第八迁移取消旧模糊范围PENDING/APPROVED申请并要求明确目标重提；不删除业务内容。DDL失败需检查schema_migrations和实际结构再重试；有删除历史时不可随意回滚。
- 删除仅在云端删除成功后结算；PROCESSING不等于完成。legacy对象路径或账本异常需人工检查，不能强制清空用量。
- 已下载文件/离线备份不会随在线删除自动撤回；隐私说明须匹配真实留存规则。
- project.config.json启用urlCheck，但用户project.private.config.json此前关闭覆盖仍保留，发布门槛会阻断。
- SSH异机备份不是不可变备份；生产凭据泄露可能影响备份。GPG私钥丢失则无法恢复。
- 当前全局worker/家庭事务串行方案适合初期；云请求延迟会影响同家庭操作。规模扩大再考虑租约/分阶段执行。
- 历史GitHub CI曾在真实库测试失败，当前远端CI未重新核对。不要套用旧“当前前端仅Mock/未联网”或“工作区干净”的描述。

## 8. 测试、构建和验证结果

以下是本会话实际运行结果；本次交接整理只核对文件/Git，不重跑测试。

| 时间/范围 | 结果 | 边界 |
| --- | --- | --- |
| 2026-10-28前端npm run check | 63项：60通过、0失败、3跳过；类型与原型JS语法检查通过 | 3项依赖本地HTTP模拟，未启动时跳过 |
| 2026-10-28后端npm run check | 99项：96通过、0失败、3跳过；Nest构建和测试TS编译通过 | 无真实MySQL连接及相应COS HTTP模拟条件；不是test:db通过 |
| 成员/审计后端针对性测试 | admin.test 9项通过 | 真实Nest HTTP、数据库fixture，包含PUT兼容接口 |
| 管理中心WXML | 微信wcc编译通过 | 未实机视觉/交互验收 |
| git diff --check | 各批次通过 | 仅格式检查 |
| 运维工具历史 | Python8项、发布工具2项和发布门槛1项通过 | GPG/SSH/systemd/真实恢复未跑 |
| 删除功能历史 | 曾运行COS实际SDK访问本机HTTP模拟的失败/重试用例通过 | 未访问真实COS，不代表线上删除验收 |

常规命令（项目根目录）：

```powershell
npm run check
npm --prefix backend run check
```

真实库测试：先安全配置进程变量TEST_MIGRATION_DATABASE_URL，仅指向允许命名的专用空测试库和隔离账号，再运行：

```powershell
npm --prefix backend run test:db
```

严禁指向业务库。TEST_MYSQL_URL仅控制普通套件SELECT 1检查，不是迁移集成变量。

本地HTTP模拟（两个终端分别运行）：

```powershell
$env:PORT='14901'; node postman/mocks/cos/default.js
$env:PORT='14902'; node postman/mocks/growth-read/default.js
```

测试终端可设置COS_SIM_URL为本机14901的/cos，GROWTH_SIM_URL为本机14902的/api/v1再执行检查；不要把模拟变量带入生产。此前没有可用Postman CLI，沿用同一Node mock与真实HTTP测试，未声称通过Postman编排器。本次没有留下已知运行中的mock服务器。

环境辅助：PowerShell；Python位于用户缓存codex-primary-runtime/dependencies/python/python.exe；Git Bash位于D盘Git安装目录；微信wcc在微信开发者工具的node_modules/wcc-exec/wcc.exe。优先先查本机可用路径，勿把旧路径视为通用安装要求。

## 9. 下一步建议与上线顺序

1. 核对备案/微信后台/AppID及服务器当前实际状态；只读取不打印秘密配置。
2. 收尾正式文案和原生权限流程，执行测试并整理Git发布提交；保留用户原有修改。
3. 创建隔离空测试库，执行8项迁移及全套test:db，解决实际失败。
4. 配置测试COS私有桶、CAM最小权限、STS及数据万象，完成真实媒体/导出/删除联调。
5. 配置独立生产桶和服务器受保护app.env；关闭开发登录，核实隐私/导出地址/留存参数，不上传真实密钥到聊天或Git。
6. 在异机建立加密备份，完成空隔离库恢复后再启用周期备份。
7. 用现有构建/导入/备份/迁移/激活工具部署。维护窗口停止API及media/export/deletion timer/service；迁移后显式激活并核实三个timer重新启动。不得直接复制旧版本路径执行。
8. 在备案及条件就绪后开放公网HTTPS，保持DB/API本机监听；配置自动续期并dry-run及reload验收。
9. 微信后台配置API和实际COS域名、隐私说明；开启域名校验，包括本地私有覆盖；正式API已在api-config.ts配置。
10. 配置监控通知和云费用提醒，触发测试异常/恢复，验证实际送达；为主机宕机设置外部监控。
11. iOS/Android两家庭三账号验收；体验版试用至少一周；补真实发布证据。
12. 使用 `npm run release:check -- <验收证据JSON路径>` 检查当前提交/干净工作区/近期证据/体验时长；通过后由用户在微信平台提交审核和发布。脚本不会发布，也不保证过审。

当前不需要额外购买云数据库、Redis或容器平台。优先完成真实验证，不再以增加功能替代上线验收。用户最近要求的是交接整理，本次只更新本文件，不自动继续部署或改业务代码。
