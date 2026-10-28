# 阶段6：云端导出 API

全部接口以 `/api/v1` 为前缀。小程序使用 Bearer 会话，家庭 OWNER/ADMIN 才能创建、读取、下载、取消和确认导出。SYSTEM_ADMIN 不自动获得家庭内容权限。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET `/families/:familyId/exports` | 最近30项任务，含状态、已完成包数 progress、partCount、parts、error、expiresAt、confirmedAt |
| POST `/families/:familyId/exports` | `{requestId, childId, period}`；两个ID为UUID v4；period 如 `2026-10`、`2026-Q4`、`2026`。返回任务，不同步生成ZIP |
| DELETE `/families/:familyId/exports/:id` | 标记 CANCELLED，后台删除导出分包；原媒体与记录不变 |
| POST `/families/:familyId/exports/:id/parts/:part/download` | 当前管理员及任务创建者仍有管理权限、READY且未过期时，返回 `{url, sizeBytes}`；地址有效5分钟 |
| POST `/families/:familyId/exports/:id/confirm` | 记录 confirmedAt，表示人工确认全部分包已备份，不能证明网盘上传成功 |

状态：PENDING → PROCESSING → READY；异常进入 FAILED，取消进入 CANCELLED，READY保留24小时后 EXPIRED。所有分包成功、最终快照和创建者权限复核通过才 READY。已签发链接无法即时撤销，已下载文件无法远程删除。

请求ID按家庭与创建者唯一，相同参数重试返回原任务，不同参数409。一个家庭最多一个尚未清理的导出，READY结果也占该名额；取消/过期后等待实际清理才能重建，防止无限累计临时包。清理失败不虚报成功。任务墓碑保留用于幂等和状态查询。

## 快照与分包

保存宝宝信息、记录正文/时间/指标、素材顺序、对象键、真实大小与格式。生成前、每包开始和最终发布时核对当前数据库内容；MySQL JSON键排序不影响比较。内容变化报 SNAPSHOT_CHANGED，需要清理旧任务后重新创建，不静默漏图。任务重试使用原快照。

每包精确计入 ZIP头、目录和HTML，最多100MiB，STORE不二次压缩。每包包含 index.html，记录正文与指标完整；该包仅包含分配给它的素材，跨包记录有明确提示。流式读取私有COS并写回 exports 前缀，原文件通过HEAD大小、ETag条件GET和读取长度校验；无完整ZIP落盘。ZIP与HTML复用小程序纯逻辑的后端副本，本地测试核对内容一致；修改原工具时须同步 `src/exports/shared/archive.ts`（替换类型导入为 `./models`）。

单次范围上限：2000条记录、10000个素材、10GiB原媒体、4MiB快照JSON、200包。超出返回 EXPORT_TOO_LARGE，选择更短时间范围。导出包不占媒体永久配额，受上述任务限制及24小时保留限制；不能视为云账单封顶。

## worker

`npm run exports:work` 单次处理一项任务，使用MySQL连接级 GET_LOCK 保证同一MySQL实例全局一个导出worker；锁值按数字转换，兼容返回字符串。事务只在快照、权限和状态写入时短暂锁家庭，云流不占家庭锁。单独连接持有全局锁，异常退出由数据库释放。

启动时清理 CANCELLED/FAILED/EXPIRED 包，恢复 PENDING/PROCESSING。重新处理先删除原分包，最多3次处理尝试；网络失败 PROCESSING_RETRY，次数用完失败。崩溃后不会把半成品标为READY。取消可能等待当前分包的网络请求完成，但停止发布；下次worker清理。清理只删除持久清单中的 exports 键，不删除 media 原件。

持续处理失败、任务长期PROCESSING、清理持续失败须运维检查；本次不包含告警服务。历史 export_jobs 表保留不动；新任务由 export_tasks 承载，避免修改已有月度约束或把演示任务当作云端包。

## 电脑配对

- 页面：GET `/export-browser`，只提供配对和导出下载，不提供浏览/编辑家庭记录。
- POST `/export-browser/pair` 创建5分钟二维码；二维码含配对ID及独立确认随机数，浏览器秘密仅通过 Secure/HttpOnly/SameSite=Strict Cookie 写入。数据库只存秘密哈希，不含小程序令牌。
- 小程序扫描后显示家庭和配对码并明确确认，通过 Bearer POST `/export-browser/confirm`，正文 `{id, familyId, secret}`；一次消费，授权15分钟。
- 浏览器 POST `/export-browser/jobs` 读取任务；POST `/export-browser/jobs/:id/:part` 签发下载地址；POST `/export-browser/logout` 注销。
- 浏览器操作必须是HTTPS且Origin严格匹配 EXPORT_PUBLIC_ORIGIN；每次检查Cookie、期限和当前成员角色。没有有效会话时401；权限撤销后拒绝。Cookie Path限定 `/api/v1/export-browser`。
- 页面CSP禁止第三方脚本/连接，脚本带nonce，禁止被iframe嵌入；无令牌URL、localStorage或HTML注入。pair接口限流并限制未过期配对行数。

部署与验收见 [阶段6说明](../../docs/stage-6.md)。
