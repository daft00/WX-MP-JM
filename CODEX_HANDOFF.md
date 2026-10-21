# 成长日记项目交接文档

更新时间：2026-10-06（Asia/Shanghai）
实际项目/Git 根目录：`C:\Users\Daft Jiang\Desktop\WX MP JM\manman WX program`
外层工作区：`C:\Users\Daft Jiang\Desktop\WX MP JM`

本文整合替换旧交接文档中的历史状态，以当前代码与本次 Git 核对为依据；不包含密码、令牌、私钥或其他真实凭据。后续对话先读本文、README、相关代码，再检查 git status/git diff，保留用户已有修改。

## 接手时先知道

- 微信小程序仍使用本地 Mock 服务；NestJS 后端模块1–8已有代码，但小程序尚未调用它。不能把后端已开发等同于已上线。
- 图片10MiB、视频50MiB的本地压缩已完成；COS上传、私有访问、对象复核尚未实现。
- 本地ZIP导出已实现，包含媒体和离线HTML；不是云端全量备份。
- 两次历史 GitHub Actions 均在真实 MySQL 集成测试 `npm run test:db` 失败，具体根因尚未取得日志确认；普通构建/测试通过不代表数据库验收通过。
- 用户明确选择：直接push不触发backend workflow，保留PR检查。此配置已提交并推送，勿擅自恢复push触发。
- AI成长分析仅讨论选型和方案，尚未实现、未配置模型API、未最终选定服务商。
- 本次整理前工作区干净，`main` 与本地跟踪的 `origin/main` 同为 `b7bca71`。本次仅更新本文，尚未提交或推送；上次“推送”授权对应已完成的CI修改，不视为后续所有改动自动推送授权。

## 1. 项目目标和当前需求

开发家庭私有的宝宝成长记录微信小程序“成长日记”：先选择家庭、再选择宝宝，记录照片、视频、文字、里程碑及身高/体重/头围，通过记录墙、趋势和导出功能管理成长资料。支持多家庭、多宝宝及成员邀请，家庭之间隔离数据。

已明确的需求：

- 家庭角色为OWNER、ADMIN、MEMBER；普通成员可发布及编辑自己的记录，管理员可管理家庭内容。SYSTEM_ADMIN为独立系统角色，不自动获得家庭内容访问权。
- 记录墙按记录发生日期倒序，年月合并为单行手风琴标题，最多展开一个月份；支持有记录年份/全部年份筛选及继续加载。
- 为控制COS用量，单张图片最多10MB、单个视频最多50MB，超限先在小程序本地压缩。代码按1MB=1024×1024字节实现。
- 素材可按宝宝及月/季度/年导出为本地ZIP，含媒体和可离线浏览的HTML记录墙；用户可自行备份到其他位置。
- 用户希望以后在“成长数据”增加中文健康方向AI分析，重视儿科/健康解释质量。现在仅讨论方案，不能将某模型已确认或已接入写成事实。
- 用户希望直接同步Git时不运行自动检查，保留Pull Request检查；已实施。

基础设施信息来自用户和既有会话，未在本次重新登录服务器核验：

- 腾讯云域名已购买，个人主体实名完成；实际域名、ICP及小程序备案完成状态尚未确认。
- 已购成都轻量应用服务器，用户称Ubuntu 26 LTS，2核/2GB内存/40GB SSD，200GB月流量/3Mbps，购买时为1个月。当前续费/有效期需重新确认。
- 既有交接记录称已安装Node.js 22、MySQL 8.4，建立业务库和分离的运行/迁移账号；这不是本次远程验证结果。
- 用户负责按脚本部署。本次未访问服务器、未部署、未执行生产迁移。

## 2. 已完成的修改

### 2.1 微信小程序与原型

- 原生TypeScript小程序，家庭/宝宝选择、档案管理、发布/编辑/详情、记录墙、成长指标、我的、邀请/成员维护及系统管理页面。
- 服务契约与页面解耦；Mock通过Storage持久化，按家庭成员关系过滤本地数据。存储键为`growth_diary_prototype_state_v3`。
- 底部四个Tab使用本地透明PNG图标及选中配色；家庭选择页自定义导航按状态栏、安全区及胶囊计算顶部留白。
- “成长墙”界面改名“记录墙”；年月标题与卡片左边缘对齐、箭头在右侧，记录日期在卡片顶部。默认最新月份展开，继续分页保留展开状态。
- 年份列表取当前家庭/宝宝的完整Mock记录，先按年过滤再分页；切换宝宝重置年份。
- `prototype/`为独立浏览器演示，仍有历史布局和模拟行为，不保证与小程序最近功能同步。`prototype/preview.html`已被Git跟踪，不再是未跟踪文件。

### 2.2 媒体限制与压缩

- 从文件系统读取实际字节数，不信任选择器或压缩接口返回的大小。
- 未超限文件直接通过；图片最多3轮，长边目标2560/1920/1280、质量80/65/50；非JPEG静态图必要时Canvas转JPEG并填白底，超限GIF拒绝以免丢失动画。
- 视频最多2轮，按时长估算约45MiB目标码率，第二轮进一步降低；限制帧率/分辨率，不主动裁剪，结果仍超限即拒绝。
- 串行处理、阶段提示、取消、预览及大小展示；处理时限制重复操作。取消需等待当前原生处理返回，仅清理本轮生成文件，不删除相册原文件。
- Mock保存入口再次复核文件大小；Asset可选保存sizeBytes。NestJS记录关联也校验资产表kind/size_bytes，但尚无COS实际对象HEAD复核。
- 不自动压缩或删除旧素材；后端保存含旧超限资产的记录时可能拒绝，需移除或重新选择。

### 2.3 本地真实导出

- 支持YYYY-MM、YYYY-Q1~Q4及YYYY，按当前家庭/宝宝/occurredAt筛选。
- 流式ZIP STORE打包，1MiB分块读媒体，不二次压缩；包含index.html和media目录，HTML文本转义、无外部依赖，年月/日期正序。
- 缺失或演示占位素材使导出失败，不制造成功任务；可取消并清理半成品，写入任务状态前再次检查权限/当前状态。
- 通过微信文件分享另存；清理本地ZIP需用户确认，原媒体不删除；保留人工备份确认。旧模拟导出记录无可下载文件。
- 当前不支持ZIP64、超过4GB的包或自动分卷；只包含本机可读取的素材版本。

### 2.4 NestJS后端模块1–8

| 模块 | 已实现内容 |
| --- | --- |
| 1 后端工程 | NestJS 11/TypeScript、环境配置校验、DTO校验、统一HTTP错误、进程及数据库健康检查 |
| 2 数据库 | TypeORM 0.3、MySQL 8.4、初始11业务表及独立迁移命令；后续会话迁移共12业务表，另有迁移历史表 |
| 3 登录鉴权 | 微信code交换、数据库会话、auth/me、退出、默认鉴权、限流、受控开发登录 |
| 4 家庭成员 | 创建/列表/详情、成员查询、一次性邀请/加入、角色调整、移除、事务审计 |
| 5 宝宝档案 | 家庭内读，OWNER/ADMIN写，生日等参数校验，不允许换归属 |
| 6 记录指标 | 记录分页/详情/创建/完整更新/永久删除、指标查询、素材关联范围和状态检查 |
| 7 系统管理 | 系统角色校验、统计及家庭/用户/成员分页、带理由的成员维护、审计查询 |
| 8 部署 | Linux构建脚本、版本目录/systemd部署、备份迁移、激活/代码回退/健康检查及说明 |

### 2.5 Git与CI

仓库：`git@github.com:daft00/WX-MP-JM.git`，分支`main`。

- `ce9d534`：后端模块1–8与部署工具，已推送。
- `f5bb725`：媒体限制、记录筛选、本地导出等前端成果，已推送。
- `b7bca71`：`ci: run backend checks on pull requests only`，已推送；仅删除backend.yml的push触发器。
- 当前workflow保留`pull_request`且仅匹配backend/**、scripts/**、.gitattributes及workflow自身路径。没有手动workflow_dispatch入口。
- 直接push main不会因push事件启动此workflow；若push更新了一个已打开的PR，仍可能通过pull_request的synchronize事件触发。这是保留PR检查的正常行为。
- workflow使用GitHub临时Ubuntu/MySQL环境执行检查，不部署到腾讯云。

## 3. 涉及的文件及关键代码位置

以下路径相对实际项目根目录；行号为本次读取时的位置，后续以函数名搜索为准。

| 文件/目录 | 关键位置和用途 |
| --- | --- |
| README.md | 当前能力、运行方式、压缩规则、ZIP使用与限制 |
| package.json | 前端typecheck/check/test/prototype；测试包含media、record-groups、export |
| project.config.json、miniprogram/app.json | 微信项目配置、页面及TabBar；核验AppID归属，不复制真实密钥 |
| miniprogram/services/index.ts:5 | 当前固定导出mockServices，真实HTTP替换入口 |
| miniprogram/services/contracts.ts:20 | EntryQuery.year；EntryService.listYears、上传及导出服务接口 |
| miniprogram/types/models.ts | Asset.sizeBytes、ExportJob及家庭/记录/权限模型 |
| miniprogram/services/mock-services.ts:386 | listYears、list按年份过滤后分页 |
| miniprogram/services/mock-services.ts:529 | saveLocalMedia大小二次检查和本地文件保存 |
| miniprogram/services/mock-services.ts:592 | MockExportService.create及后续读取/清理/确认方法 |
| miniprogram/services/media-policy.ts:3、:24 | MEDIA_LIMITS、prepareMedia压缩/取消/清理 |
| miniprogram/pages/publish/index.ts:157、:228 | chooseMedia、toJpeg；对应WXML隐藏Canvas、进度和预览 |
| miniprogram/utils/record-groups.ts:13 | groupRecords分组与排序 |
| miniprogram/pages/wall/index.ts:50、:98、:158 | 首次加载、续页、年份切换；WXML/WXSS负责年月手风琴 |
| miniprogram/pages/select-family/index.ts:49 | updateContentTop安全区留白 |
| miniprogram/assets/tabbar/ | 四个Tab的普通/选中图标 |
| miniprogram/services/local-archive.ts:10 | createLocalArchive与微信文件系统分块读取 |
| miniprogram/utils/export-archive.ts | 期间解析、离线HTML、UTF-8、CRC/ZIP STORE实现 |
| miniprogram/pages/export/index.ts:92、:113、:129 | 创建、分享、清理本地ZIP |
| miniprogram/pages/growth/ | 现有成长指标展示，未来AI入口候选位置 |
| backend/src/config.ts、setup-app.ts、http-exception.filter.ts | 配置、全局验证、统一错误处理 |
| backend/src/auth/ | 微信交换、会话、守卫、登录接口及用户实体 |
| backend/src/families/、children/、entries/、admin/ | 各业务控制器、DTO、服务与模块 |
| backend/src/entries/entries.service.ts:103 | 关联素材查询及10MiB/50MiB元数据限制 |
| backend/src/database/database.service.ts:25 | 运行连接池/事务与UTC会话设置 |
| backend/src/database/data-source.ts、migrate.ts | 独立迁移连接、锁和迁移CLI |
| backend/src/database/migrations/ | 1790985600000初始结构；1790985601000会话表，勿改写已使用的历史迁移 |
| backend/test/database.integration.test.ts:17 | 真实MySQL8.4迁移/约束总入口，后续调用各模块integration用例 |
| test/、backend/test/ | 前端Node测试；后端普通测试和真实库测试 |
| scripts/setup-ubuntu-26.sh、setup-database.sh、verify-database.sh | Ubuntu/数据库初始化与检查脚本 |
| scripts/build-backend.sh、deploy-backend.sh、scripts/deploy/ | 打包、发布操作、systemd/Nginx模板及部署工具检查 |
| backend/docs/ | database/auth/families/children/entries/admin/deployment专题说明 |
| .github/workflows/backend.yml:3、:46 | PR触发条件、真实数据库测试步骤 |

## 4. 已确定的架构和技术决策

- 同一Git仓库，前端在miniprogram/，后端在backend/，独立package.json/依赖/构建。跨端业务需求可能同时修改两边，纯界面变化通常只改前端。
- 前端采用微信原生TypeScript，页面经服务接口访问数据；生产需实现HTTP适配层，不能直接把Mock权限当作安全控制。
- Node.js目标22，后端engines允许>=22且<25；NestJS11、MySQL8.4、mysql2、TypeORM。运行连接池最多5个连接，适配小服务器；大型模型/媒体转码不在2GB服务器上部署。
- 会话采用可吊销的随机Bearer令牌，仅保存SHA-256摘要；不采用JWT。微信身份在服务端确认，不接受客户端传入OpenID、用户ID或系统角色作为凭据。
- 开发登录默认关闭且生产禁止；生产需要独立配置微信凭据和邀请密钥，真实值只在受保护配置中。
- 邀请码单次使用、24小时有效、存HMAC摘要；家庭行锁和条件更新保证入会/角色变更/审计事务一致性。SYSTEM_ADMIN不绕过家庭权限。
- 业务日期为YYYY-MM-DD并按上海“今天”校验；记录中的DATETIME保存UTC零点。指标由服务端决定单位，值最多3位小数。
- 禁止TypeORM自动同步及启动时自动迁移；运行账号与迁移账号分离，DDL迁移有并发锁、部分结构检测、非空库回滚保护。MySQL DDL可能部分提交，失败时先检查实际状态。
- 最终媒体采用私有COS，小程序直传；后端签发单对象、短时、最小权限授权，完成后复核实际对象并标为READY，读访问也需家庭鉴权。该流程是已确定方向，API/SDK接入尚未实现。
- 后端删除记录会清除关联/指标并将素材置DELETING；COS物理删除和孤立对象清理仍待实现。
- 部署使用/opt/growth-diary/releases及current/previous链接；API和迁移使用分离系统身份。配置位于受保护的/etc/growth-diary文件中，默认API监听127.0.0.1:3000。备份、迁移、激活按文档显式执行；代码回退不等于数据库回退。
- 用户已授权的CI策略为PR检查；不得用恢复push检查或删除数据库测试替代真实失败排查。

AI讨论中的建议，尚非最终实施决策：

- 曾建议DeepSeek Pro作为首轮评估候选，千问作为对照，专业医疗服务另行评估。会话曾引用当时官方模型名称，接入时必须重新核对模型列表、费用、可用地域及条款，不照抄过时型号。
- 云端模型通常需要相应API Key，由NestJS读取受保护配置并调用，不把Key放小程序/Git/聊天，不在轻量服务器本地跑大模型。
- 生长百分位/Z分数由适用标准数据和确定性代码计算，模型解释结果和生成科普，避免凭记忆编数字；性别、测量方式、早产等必要资料需评估，当前genderLabel只是称呼，不能当作医学计算所需性别字段。
- 候选范围是趋势、数据质量/复测提醒、来源明确的科普和就医咨询提示，非自动诊断/用药。上线前需专业审核、监护人知情及最少必要数据传输方案。

## 5. 尝试过但未采用的方案及原因

- 旧媒体限额30MB/500MB已替换为10MiB/50MiB；采用微信原生压缩及有限轮次，未引入服务端FFmpeg转码、无限重试或自动裁剪。
- 非JPEG超限图仅降低quality可能无效，因此增加缩放与Canvas JPEG回退；GIF超限直接提示，避免静默丢失动画。
- 记录墙曾采用年/月两层折叠，最终改为单行年月手风琴；不要恢复旧样式。
- 导出早期为模拟流程，现已用真实本地ZIP取代；尚未做ZIP64、分卷、云端导出、JSON/CSV清单或独立SHA-256清单，不要把早期规划写成现成功能。
- 未接夸克账号/Cookie/自动同步；用户自行保存ZIP并人工确认备份。
- 未采用服务器系统盘作为最终媒体库、公开COS桶、前端永久云密钥、系统管理员默认读取家庭照片。
- 未采用JWT、应用启动自动迁移或复用运行凭据执行迁移，以保留吊销能力和数据库权限边界。
- CI最初push和PR都运行，用户要求直接push不检查后只移除push触发；没有删除PR检查，没有修复数据库失败。
- 排查CI时本机gh命令不可用；改用公开网页和GitHub REST读取步骤状态。下载详细日志返回403并要求仓库管理员权限，未取得具体SQL/断言错误，不能推断为凭据、迁移或媒体逻辑导致。
- 既有离线HTML视觉验收曾被浏览器工具的file://访问限制阻止；记录的ZIP解压/哈希检查不代表视觉和真机体验已通过。

## 6. 当前未完成事项

1. 取得失败的test:db完整日志，确认第一处真实异常，在专用测试库复现并修复；未验收前不进行正式数据库上线。
2. 前端HTTP适配和真实微信登录联调，家庭/成员/宝宝/记录/指标切换；适配系统列表分页、维护理由输入、审计页面及指标游标分页。
3. 后端补齐记录年份列表及按年筛选契约；目前只在Mock实现listYears/EntryQuery.year。
4. COS上传授权、实际对象大小/类型/归属复核、私有访问、封面/缩略图、过期PENDING及DELETING/孤立对象清理、必要配额。
5. 生产素材导出需服务端家庭权限、COS读取与导出任务；现有本地包不能导出其他设备或仅在云端的素材。
6. iOS/Android真机验收压缩、竖屏/透明图/视频声音、弱网/切后台、取消、空间不足、分享ZIP和离线浏览。
7. 确认服务器状态/续费、测试库验收、按部署文档实际部署及备份恢复演练；域名、HTTPS、合法域名、备案/发布审核状态需用户确认。
8. AI模块待确认范围、标准数据、专业审核和模型供应商/预算/数据处理要求，再实施。无API密钥配置，无已完成AI功能。

## 7. 已知问题和风险

- CI真实数据库测试失败尚未解决。关闭push触发只改变运行时机，PR仍可能失败；不能称当前代码已完全具备上线条件。
- 2026-10-05查看CI时有actions/checkout@v4、setup-node@v4的Node20弃用警告及ubuntu-latest将迁移Ubuntu26的提示；其步骤已成功，不能当成已确认根因。依赖Action升级可另行处理。
- 小程序尚未联网，邀请码/权限/角色切换为本机演示；不能跨设备验证真实身份隔离。重置演示数据会清除本地记录/引用/导出状态。
- 小程序沙箱有配额和生命周期限制，保存失败时媒体可能仅当前会话有效；本地导出需要额外空间，4GB以内也未保证微信分享成功。
- 原生压缩结果受设备/编码/内存影响；无法保证所有超限素材可压到目标大小，达到失败边界应正常拒绝。
- 模型元数据大小校验不能替代COS实际对象校验；未来需抵御伪报大小/类型和越权对象访问。
- 后端与COS删除一致性、孤立素材清理尚未闭环；已有DELETING状态不代表云端已删除。
- 浏览器原型与小程序功能不同步；不要以浏览器原型效果替代小程序验收。
- 旧交接曾记录微信工具泛化Error未复现，目前没有足够日志认定该问题已解决。
- 备案/微信审核/云产品政策随时间变化，执行前查当前官方要求；服务器买1个月和个人域名实名不等于备案或产品上线已完成。
- AI健康能力不能仅凭宣传或通用考试分数判断，需场景评估；不发送家庭身份/照片等非必要信息，不把健康数据或密钥写入普通日志。

## 8. 测试、构建和验证结果

以下为已有实际执行/已记录结果，除Git与文件核对外，本次文档整理未重新运行测试或构建。

| 验证 | 已知结果及边界 |
| --- | --- |
| 媒体功能初次验证 | 前端6项媒体测试与类型检查通过；后端构建通过、50项普通测试通过、1项真实连接检查因未配置跳过 |
| 记录墙/导出后续验证 | 既有交接记录前端18项测试及类型检查通过，WXML/WXSS编译通过；Windows原生ZIP解压及图片哈希一致，本轮未重跑 |
| 部署工具本地历史验证 | Bash语法、两项配置/凭据测试、四条模拟切换/失败恢复分支通过；未等同真实Ubuntu部署验收 |
| GitHub Actions #1 | ce9d534，2026-10-03；npm ci、npm run check及部署脚本检查成功，npm run test:db失败 |
| GitHub Actions #2 | f5bb725，2026-10-04；同样在npm run test:db失败，前序步骤成功；2026-10-05通过REST核对 |
| CI触发配置修改 | 只删push两行，git diff --check通过，b7bca71已推送；没有通过另跑数据库测试证明修复 |
| 本次交接前Git | main，HEAD及本地origin/main为b7bca71，工作区干净；写本文后仅本文应有未提交修改 |
| 未完成验证 | 本地真实MySQL8.4全套验收、真实微信登录/COS联调、云端部署、iOS/Android完整验收、AI健康分析 |

历史失败记录：

- https://github.com/daft00/WX-MP-JM/actions/runs/37129268727
- https://github.com/daft00/WX-MP-JM/actions/runs/37213301355
- 第二次失败job：111468647497，失败步骤为Run npm run test:db。登录仓库后展开该步骤，读取首个SQL错误/断言及堆栈；当前只看到exit code 1，根因未知。

常用命令（在实际项目根目录执行）：

```powershell
git status -sb
git diff
npm ci
npm run check
npm --prefix backend ci
npm --prefix backend run check
```

真实库测试单独执行：

```powershell
npm --prefix backend run test:db
```

前提：在执行进程中安全设置`TEST_MIGRATION_DATABASE_URL`，只指向专用空的MySQL8.4测试库`growth_diary_test`或允许的测试后缀库。不得指向业务库，不要把真实连接串复制到文档或聊天。缺少变量会失败；失败可能保留部分DDL，先检查再重试。普通测试中的`TEST_MYSQL_URL`仅控制SELECT 1检查，与上述集成测试不是同一变量。

## 9. 下一步建议

1. 新对话先核对Git与本文，理解“前端Mock、后端已开发但真实库失败”的实际状态。使用简体中文、简洁同步进展，保留现有修改；不擅自部署、重置数据或推送新改动。
2. 优先解决test:db失败：取得日志后针对根因修复，不猜测、不跳过失败用例、不擅自恢复push触发。
3. 完成测试库迁移验收，按backend/docs/deployment.md让用户执行服务器部署与备份恢复验证。
4. 接入真实HTTP/微信登录并补齐年份查询契约，然后实现COS媒体闭环与真实导出。
5. 对已完成小程序功能执行真机验收，明确设备、基础库及测试结果。
6. AI需求可独立细化，但模型选型/儿童数据处理/生长标准与医疗审核未确定前，不应把模型自由生成结果作为可靠医疗结论上线。
7. 本次只有交接文档更新，若用户要求保存到Git，再单独提交并推送。
