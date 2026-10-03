# 模块 7：系统管理与审计

系统管理员用于数量统计和家庭成员维护，不因此获得家庭内容访问权。复用 `users.system_role`、家庭/成员和 `audit_logs` 表；无新增迁移、依赖或配置。

## 权限边界

所有接口需要 Bearer 登录，并在业务事务内以 `SELECT ... FOR SHARE` 读取当前 `SYSTEM_ADMIN` 角色。会话中的旧角色、请求体或请求头里的角色标签都不能替代数据库授权。普通用户即使是家庭 OWNER/ADMIN，也无权调用系统管理接口。撤销系统角色后，后续请求立即失效；已经持有角色共享锁的事务会先完成，再允许撤权更新提交。

管理接口仅提供家庭名称、用户昵称/头像文字、成员关系、数量统计和审计元数据。不提供宝宝姓名/生日、记录标题/正文、指标值、素材列表、COS 对象键、签名 URL、微信标识、邀请码摘要或会话信息。系统管理员访问普通家庭业务 API 时仍须是该家庭成员。

只允许调整既有非 OWNER 成员的 ADMIN/MEMBER 角色或移除成员；不提供添加成员、转让 OWNER、设置系统角色、删除用户/家庭/宝宝接口。系统管理接口禁止修改操作者自己的家庭成员身份，避免通过此入口给自己升级家庭权限。合法家庭 OWNER 仍可按普通家庭接口管理成员。

## API

共同前缀 `/api/v1/admin`，成功响应为 `Cache-Control: no-store`。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/dashboard` | 全局 familyCount、userCount、childCount、entryCount、assetCount |
| GET | `/families` | 家庭概要、创建者昵称及宝宝/记录/素材数量 |
| GET | `/users` | 公开用户字段、所属家庭数量、发布记录数量 |
| GET | `/families/:familyId/members` | 指定家庭成员列表 |
| PATCH | `/families/:familyId/members/:memberId` | 调整角色，200 返回成员信息 |
| DELETE | `/families/:familyId/members/:memberId` | 移除成员，成功 204；JSON body 必须包含 reason |
| GET | `/audit-logs` | 审计查询，可按 familyId、actorId、action 精确筛选 |

列表统一接收 `page`（1–10000，默认 1）、`pageSize`（1–100，默认 20），返回 `{items, page, pageSize, hasMore}`。家庭/用户按创建时间、ID 倒序，成员按加入时间、ID 正序，审计按创建时间、ID 倒序。使用有上限的 offset 分页，翻页期间数据新增/删除可能改变结果，应刷新；初期直接做准确 COUNT，数据规模增长后再优化聚合统计。

家庭和用户列表分别返回前端 `SystemFamilyOverview`（不含 members）和 `SystemUserOverview` 对应字段；成员需单独分页加载。仪表盘不再一次返回全量 families/users。小程序仍使用 Mock，真实服务切换时需调整现有 `getDashboard` 组装方式，并新增操作理由输入与审计页面。

PATCH 示例：

```json
{"role":"MEMBER","reason":"根据家庭创建者申请取消管理员权限"}
```

DELETE 示例：

```json
{"reason":"根据本人申请移除家庭成员关系"}
```

理由去除首尾空白后 1–400 字符，拒绝 null、空白或缺失值。成员及家庭 ID 须 UUID v4。`action` 为最长 80 字符的大写字母/数字/下划线，首字符须字母。未知字段、伪造 actorId/角色、非法分页等返回 400。未登录 401、无系统权限/修改 OWNER 或自己 403、不存在的家庭或家庭内成员 404。

## 审计与事务

系统角色调整记录 `SYSTEM_MEMBER_ROLE`，移除记录 `SYSTEM_MEMBER_REMOVE`。保存服务端会话中的操作者 ID、家庭 ID、目标 membership ID、原角色/新角色（或 REMOVED）、填写的理由及时间；移除时额外把目标 user ID 保存在理由元数据中，便于成员行删除后追查。

操作先锁定当前系统角色，再沿用家庭行锁和目标成员行锁；角色降为 MEMBER 或成员移除时，删除该用户在此家庭中所有未使用邀请。业务变更、邀请失效与审计在同一事务中，审计失败整体回滚。成员移除不删除其账号、其他家庭关系或历史内容。

查询返回 `id`、`actorId`、`familyId`、`action`、`targetType`、`targetId`、`reason`、`createdAt`。也能查询模块 4–6 已记录的家庭、宝宝、记录管理操作。已有操作保留原 action 作为 reason，不追补不存在的历史理由。

审计记录成功的业务写入，不记录每次只读查询或被拒绝的请求；不把正文、指标值、媒体地址和令牌自动写入审计。理由应填写维护依据，不要填写密钥或家庭私密内容。API 不提供审计编辑/删除，但这不等于数据库级不可篡改存储；具备直接数据库写权限的人仍可修改数据。

## 首位管理员

应用不自动创建、提升管理员，开发登录也仍然是普通用户。首位管理员由有授权的数据库维护者在核实目标账号后配置，不提供公开提权 API。本次开发没有修改任何真实账号权限。

在专用测试库中，可先登录创建测试用户，使用 `/auth/me` 返回的用户 UUID。以下是供维护者核对后执行的 SQL 模板，**会提升系统权限**；不得仅凭昵称挑选用户，生产授权应单独审核。审计中以被授权用户作为初始化技术操作者，并明确记录人工初始化原因：

```sql
SET @system_admin_user_id = '替换为已经核实的用户UUID';
START TRANSACTION;
SELECT id, nickname, system_role FROM users WHERE id = @system_admin_user_id FOR UPDATE;
UPDATE users SET system_role = 'SYSTEM_ADMIN'
WHERE id = @system_admin_user_id AND system_role = 'USER';
SET @system_admin_changed = ROW_COUNT();
INSERT INTO audit_logs (id, actor_id, family_id, action, target_type, target_id, reason)
SELECT UUID(), id, NULL, 'SYSTEM_ADMIN_BOOTSTRAP', 'user', id,
       'Authorized manual bootstrap by database maintainer; subject used as bootstrap actor'
FROM users WHERE id = @system_admin_user_id AND @system_admin_changed = 1;
COMMIT;
```

任一语句报错时立即执行 `ROLLBACK`，不要继续执行 `COMMIT`。没有匹配用户或用户已是管理员时，不重复写授权记录。维护者应另行记录实际审批人与执行人。后续撤权也应由授权维护者变更并留痕，应用下次请求会重新读取角色。

## Ubuntu 联调

使用已授权测试账号的会话和测试家庭，以下 Bash 示例包含实际角色修改：

```bash
API=http://127.0.0.1:3000/api/v1
read -rsp 'System admin Bearer token: ' TOKEN; echo
curl --fail-with-body "$API/admin/dashboard" -H "Authorization: Bearer $TOKEN"
curl --fail-with-body "$API/admin/families?page=1&pageSize=20" -H "Authorization: Bearer $TOKEN"
curl --fail-with-body "$API/admin/users?page=1&pageSize=20" -H "Authorization: Bearer $TOKEN"
read -rp 'Test family UUID: ' FAMILY_ID
curl --fail-with-body "$API/admin/families/$FAMILY_ID/members" -H "Authorization: Bearer $TOKEN"
read -rp 'Non-owner member UUID (not user UUID): ' MEMBER_ID
curl --fail-with-body -X PATCH "$API/admin/families/$FAMILY_ID/members/$MEMBER_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"MEMBER","reason":"测试家庭成员管理流程"}'
curl --fail-with-body "$API/admin/audit-logs?familyId=$FAMILY_ID&action=SYSTEM_MEMBER_ROLE" -H "Authorization: Bearer $TOKEN"
unset TOKEN
```

## 验证

`npm run check` 包含当前系统角色检查、普通用户拒绝、OWNER/自己保护、跨家庭成员拒绝、邀请失效、操作理由和审计、数据投影隐私边界、HTTP 参数/身份伪造测试，以及模块 1–6 回归。

`npm run test:db` 新增真实 MySQL 的统计/分页/查询、系统管理员仍无法读取宝宝、角色撤销、降级/移除后的邀请失效、审计失败时角色/成员/邀请回滚测试。配置方法见 [数据库文档](database.md)。本机未运行真实 MySQL 验收，只编译这些用例；后续部署前需要在专用测试库或 CI 执行。
