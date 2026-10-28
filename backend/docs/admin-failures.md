# 管理中心异常任务

需完成现有八项数据库迁移。本次不增加迁移，不更改worker或存储权限。
所有接口要求登录且数据库当前角色为SYSTEM_ADMIN，响应Cache-Control: no-store。

## 列表

GET /api/v1/admin/failed-tasks?kind=MEDIA&page=1&pageSize=20

kind为MEDIA（默认）、EXPORT、DELETION；page为1–10000，pageSize为1–100（默认20）。
响应为items、page、pageSize、hasMore。按状态更新时间、ID倒序，offset分页，不提供跨页快照。
items只包含id、kind、familyId、status、error、updatedAt、attempts、nextAttemptAt、canRetry、cleaned。
时间为UTC；媒体updatedAt是资产状态更新时间，不是最后一次云调用失败时间。没有可用次数/调度时间/清理标志时为null。
错误码使用白名单，未知值替换为UNKNOWN_ERROR；没有错误码的超时或待清理项为STALLED_OR_PENDING_CLEANUP。
不返回对象键、签名URL、导出快照、申请正文或登录身份凭据。

- MEDIA：仍有资产且未完成删除的上传账本中，存在错误或PENDING/DELETING/FAILED超过24小时未更新；READY临时文件已清理的旧错误不再展示。已删除账本不展示。
- EXPORT：FAILED；有错误或超过24小时未更新的PENDING/PROCESSING；尚未清理的CANCELLED/EXPIRED。FAILED清理后仍保留可诊断的失败历史。
- DELETION：PROCESSING超过24小时，或CLEANUP_RETRY、STORAGE_UNAVAILABLE、LEGACY_MEDIA_REQUIRES_REVIEW、MEDIA_LEDGER_REQUIRES_REVIEW。正常等待上传凭证过期不会立即当作故障展示。

## 媒体重新排队

PUT /api/v1/admin/failed-tasks/media/:id/retry

JSON：{"reason":"存储配置已核对，重新安排处理"}；id为UUID v4，reason去首尾空白后1–400字，禁止额外字段。
成功返回{"id":"任务UUID","scheduled":true}，不代表云操作已成功，也不会启动或安装worker。

服务端在同一事务中锁定当前系统角色、家庭和任务，重新核验：
- 未删除且错误为PROCESSING_RETRY；
- PENDING已请求复核且上传尚未过期；或DELETING/FAILED清理、READY临时清理已过上传截止时间加60秒保护期。

仅将next_attempt_at设为当前时间，审计SYSTEM_MEDIA_RETRY记录操作者、家庭、任务和原因；审计失败整体回滚。不改状态、不清空错误、不改变预留或已用配额。
未知任务404；状态已变化或不允许重新排队409；权限不足403；参数无效400。
失败或网络中断时先刷新核实，避免反复提交。重新排队可安排删除阶段的清理，不能恢复被删除的数据。

## 其他处理

无效媒体由原流程清理并请上传者重传；不提供将其改为READY的接口。
导出失败由家庭管理员在原导出入口重新创建，继续遵守权限与内容快照复核。
删除任务由现有worker自动重试；历史对象路径或账本异常需要人工核查，不提供强制完成或提前释放配额。
检查Ubuntu对应media/export/deletion timer是否启用；存储配置未就绪时重新排队也不会恢复处理。

## 验证

本地测试覆盖HTTP鉴权/参数/no-store、元数据投影及错误脱敏、排队锁与审计、前端切换/迟到响应/确认原因。
MySQL集成用例新增真实查询、重排不改变配额/状态、审计失败回滚、无效媒体及保护期拒绝；已编译，尚未连接测试库执行。
不以本地测试替代真实COS、微信真机和Ubuntu worker验收。
