# 模块 5：宝宝档案

复用 `children` 与 `audit_logs` 表，无新增依赖、迁移或环境变量。先按数据库文档执行模块 2–3 的两项迁移。所有接口需要 `Authorization: Bearer <token>`，响应禁用缓存。

## 接口与权限

路径前缀：`/api/v1/families/:familyId/children`。家庭和宝宝 ID 均须为 UUID v4。

| 方法 | 相对路径 | 返回 | 权限 |
| --- | --- | --- | --- |
| GET | 空 | 200，宝宝数组，按创建时间、ID 排序 | 当前家庭成员 |
| GET | `/:childId` | 200，宝宝详情 | 当前家庭成员 |
| POST | 空 | 201，新宝宝档案 | OWNER / ADMIN |
| PUT | `/:childId` | 200，更新后的档案 | OWNER / ADMIN |

POST / PUT 请求示例：

```json
{
  "name": "乐乐",
  "birthday": "2024-02-29",
  "genderLabel": "宝宝",
  "avatarColor": "#F0A58A"
}
```

- `name` 必填，去除首尾空白后 1–12 字符。
- `birthday` 必填，必须是真实的 `YYYY-MM-DD` 日期，年份 1000–9999，不能晚于上海时区的今天。数据库 DATE 原样返回字符串，不进行时区换算。
- `genderLabel` 为家庭称呼，最多 8 字符；省略或空白时使用“宝宝”。
- `avatarColor` 为六位十六进制颜色；省略时使用 `#F0A58A`。
- PUT 为完整表单更新：名称、生日仍必填，省略称呼或颜色会恢复默认值。字段显式传 `null`、未知字段、客户端传入 `id` / `familyId` / `creatorId` 均返回 400。

返回字段与小程序 `Child` 一致：`id`、`familyId`、`creatorId`、`name`、`birthday`、`genderLabel`、`avatarColor`、`createdAt`。创建者从当前会话取值；编辑保留创建者、所属家庭和创建时间。

未登录返回 401；非家庭成员或家庭不存在返回 404；普通成员写入返回 403；宝宝不属于路径家庭或不存在返回 404。SYSTEM_ADMIN 不绕过成员关系。每次操作在同一事务内先锁家庭、检查当前成员关系，再读写档案，沿用成员管理的锁顺序。新增与编辑分别记录 `CHILD_CREATE`、`CHILD_UPDATE`，审计失败则整笔事务回滚。

本模块不提供删除宝宝或转移家庭接口，避免意外处理已有成长记录和素材。小程序仍用 Mock；切换真实服务时，`ChildService.list/get/save` 分别映射上述接口，`draft.id` 只放 URL，不放请求体。选择宝宝可使用详情接口校验其家庭归属，选择状态本身留在客户端。

## 本地联调

启动后端，按 [登录文档](auth.md) 获取令牌、按 [家庭文档](families.md) 创建家庭或加入家庭。以下命令在 Ubuntu Bash 执行，读取已有令牌，避免把明文令牌直接写进历史记录：

```bash
API=http://127.0.0.1:3000/api/v1
read -rsp 'Bearer token: ' TOKEN; echo
read -rp 'Family UUID: ' FAMILY_ID

curl --fail-with-body "$API/families/$FAMILY_ID/children" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"乐乐","birthday":"2024-02-29","genderLabel":"宝宝","avatarColor":"#F0A58A"}'

curl --fail-with-body "$API/families/$FAMILY_ID/children" -H "Authorization: Bearer $TOKEN"
read -rp 'Child UUID from response: ' CHILD_ID
curl --fail-with-body "$API/families/$FAMILY_ID/children/$CHILD_ID" -H "Authorization: Bearer $TOKEN"
curl --fail-with-body -X PUT "$API/families/$FAMILY_ID/children/$CHILD_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"乐乐","birthday":"2024-02-29","genderLabel":"姐姐","avatarColor":"#D991A2"}'
unset TOKEN
```

以上命令会新增、编辑一份档案，适用于测试家庭；不是服务器部署脚本。

## 验证

`npm run check` 包含日期边界、角色矩阵、跨家庭查询/更新、身份字段伪造、真实 HTTP 参数校验、全局鉴权和既有模块回归测试。业务 SQL 使用替身。

`npm run test:db` 已加入实际数据库的 DATE 往返、创建者保留、角色降级/移除、跨家庭拒绝、审计与事务回滚用例；运行方式及专用空测试库要求见 [数据库文档](database.md)。本机无可用 MySQL，本轮仅编译这些用例，没有执行真实数据库验收或服务器部署。
