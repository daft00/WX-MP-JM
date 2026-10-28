# 媒体接口与存储约束

阶段5代码完成，真实 COS、MySQL 8.4 和微信真机验收待完成。部署与云配置见 [阶段5](../../docs/stage-5.md)。全部接口位于 `/api/v1`，要求 Bearer 会话；响应禁止缓存。

| 方法与路径 | 请求与行为 |
| --- | --- |
| GET `/families/:familyId/storage` | 返回 enabled、quotaBytes、usedBytes、reservedBytes；当前成员可读 |
| POST `/families/:familyId/assets` | `{requestId, childId, kind, name, sizeBytes}`；UUID v4，kind 为 IMAGE/VIDEO；返回 asset 与 upload 表单 |
| POST `/families/:familyId/assets/:assetId/authorize` | 上传者重新申请短时表单；已提交复核时仅返回 asset |
| POST `/families/:familyId/assets/:assetId/complete` | 幂等提交复核，不代表已 READY；随后轮询 GET |
| GET `/families/:familyId/assets/:assetId` | 返回状态；READY 返回 localPath、posterPath、expiresAt。未关联素材仅上传者可读 |
| DELETE `/families/:familyId/assets/:assetId` | 上传者取消未关联素材，204；后台实际删除后释放配额。已关联返回409 |
| PUT `/admin/families/:familyId/storage` | `{quotaBytes, reason}`；仅 SYSTEM_ADMIN，可设1字节至1TiB，不得低于已用加预留；审计留痕 |

申请请求ID按家庭、上传者隔离；相同ID与参数返回原任务，不同参数或已删除任务返回409。名称最长255字符；图片最多10MiB，视频最多50MiB。真实格式通过 COS 数据万象检测：JPEG/PNG/GIF/WebP，MOV/MP4。扩展名和客户端 MIME 不作为复核证据。HEIC 等其他格式目前不支持。

`upload.url` 和 `upload.formData` 用于 `wx.uploadFile`，文件字段名为 `file`。表单固定临时对象键、精确字节数和私有权限，最长5分钟；不返回 TmpSecretKey。上传成功后再 complete。临时任务1小时后过期；不能用同一请求ID重新创建已删除素材。

## 一致性与权限

- 家庭行锁串行化配额预留、成员变更、记录关联和后台结算。申请预留 `2 × 原文件大小 + 1MiB`，覆盖临时对象、最终对象和派生图；占用高于单个文件是预期行为。
- 后台按临时对象 ETag 条件复制到客户端不可写的最终路径，再复核最终对象大小与格式，生成不超过1MiB的 JPEG 缩略图/视频封面；全部成功才 READY。
- 临时对象在上传期限结束后额外等待60秒再清理，防止仍有效的上传表单重新写入；实际删除后释放临时预留。
- 复核瞬时失败保留预留并重试；不支持格式进入 DELETING。删除任何对象失败均保留占用，继续重试，不能提前记为空闲。
- 未关联 READY 素材保留24小时；编辑解除关联时重新计时。草稿保存的是素材ID，不会延长云端保留时间。
- 私有读链接最长5分钟，每次签发复核当前成员身份；成员移除不能撤回已签发链接和已下载文件。详情页提供刷新地址入口。
- `media_uploads` 墓碑保留请求幂等性；不要手工清空。第五项迁移回滚在新表非空时拒绝执行。
- 历史无上传账本的 assets 只计入原文件用量，不自动读取或删除未知对象。若测试/历史库存在此类行，上线前单独核对，不直接删除。

## 工作任务与错误

`npm run media:work` 单次处理最多20项；timer 在任务结束15秒后再运行。云处理失败记录安全错误码 `PROCESSING_RETRY`，无效媒体记录 `INVALID_MEDIA`，60秒后重试；不记录密钥和签名URL。运维需监控长期未完成任务及日志，当前没有告警推送系统。

初期单worker在家庭事务内执行有超时的云调用；同一家庭操作可能等待。规模扩大时再改为持久租约与分阶段事务。不要并行手工启动多个worker。

未配置媒体时 enabled=false，申请上传503；400表示参数错误，401会话失效，404包括非成员/不可见素材，409包括配额不足、请求冲突或素材已关联。客户端保留上传队列和请求ID，允许继续、取消；退出或切换家庭清除本机队列，云端残留由后台清理。

## 系统管理员配额读取与界面（2026-10-28）

GET /api/v1/admin/families/:familyId/storage 新增管理员读取接口，当前数据库SYSTEM_ADMIN方可访问，无需家庭成员身份。UUID v4参数，返回no-store；家庭不存在404，解散中409。事务内锁定系统角色与家庭，复用上传占用统计，返回enabled、quotaBytes、usedBytes、reservedBytes；默认10GiB，已用量包含无上传账本的历史资产。只返回配额数据，不返回私有内容。

PUT同路径原接口继续使用，quotaBytes为1至1TiB的整数字节数，reason去首尾空白后1–470字。服务端在家庭锁内重新核验已用+预留，低于占用409，成功写入STORAGE_QUOTA_UPDATE审计并返回最新用量。不删除媒体、不改变占用、不启用未配置的COS。

小程序家庭列表“管理配额”支持整数MiB（1–1048576），1024MiB=1GiB；显示两位小数MiB及精确字节数。新值不自动取整现有配额，需用户明确输入，提交前展示家庭ID及前后字节值。原因和确认均需完成；冲突或网络结果不确定时刷新后再操作。预留包括处理中与临时对象，真实清理后才释放；配额不包含所有云服务费用，不是账单封顶。

部署先更新后端GET接口再更新小程序，无新增迁移。验收管理员无成员身份读取、普通用户拒绝、媒体未启用、占用边界、并发上传后降额冲突、失败重试、审计记录及切换页面迟到响应。真实MySQL/COS/真机尚未联调。
