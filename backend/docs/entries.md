# 模块 6：成长记录与指标

复用 `entries`、`metrics`、`entry_assets`、`assets`、`audit_logs`，不新增迁移、环境变量或依赖。运行前需完成模块 2–3 的两项迁移。当前小程序仍使用 Mock，本模块提供后端接口及验证用例。

## 接口

共同前缀：`/api/v1/families/:familyId`。全部需要 Bearer 登录，ID 为 UUID v4，成功响应禁用缓存。

| 方法 | 路径 | 用途与返回 |
| --- | --- | --- |
| GET | `/entries?childId=...&pageSize=20&cursor=...` | 200，成长墙分页；childId 可省略以查看整个家庭 |
| GET | `/entries/:entryId` | 200，单条记录，包含指标及有序素材 ID |
| POST | `/entries` | 201，创建记录 |
| PUT | `/entries/:entryId` | 200，完整表单更新 |
| DELETE | `/entries/:entryId` | 204，永久删除记录及关联指标 |
| GET | `/metrics?childId=...&type=HEIGHT&pageSize=20&cursor=...` | 200，指定宝宝、指定指标的分页序列 |

家庭成员可查看、发布，MEMBER 只能编辑自己的记录；OWNER / ADMIN 可编辑家庭内任意记录并永久删除。即使是作者，普通成员也不能删除。SYSTEM_ADMIN 不绕过成员关系。每次请求在事务内按家庭行锁、当前成员关系、业务数据的顺序执行。被移除后，旧登录会话也无法继续访问该家庭。

记录与宝宝 ID 都限定在路径家庭内。未登录 401、非法参数 400、无写入权限 403、无权访问的家庭或不存在的记录/宝宝 404、素材已被其他记录绑定 409。未知数据库错误沿用统一错误响应。

## 完整表单与响应

```json
{
  "childId": "替换为宝宝UUID",
  "kind": "MILESTONE",
  "title": "记录今天的身高",
  "body": "宝宝又长高了",
  "occurredAt": "2026-10-01",
  "assetIds": [],
  "customEvent": "身高记录",
  "metricType": "HEIGHT",
  "metricValue": 80.125
}
```

- `childId`、`kind`、`title`、`occurredAt` 必填。`kind` 为 `DIARY` 或 `MILESTONE`；标题去除首尾空白后 1–60 字符，正文最多 2000 字符，默认空字符串。
- `occurredAt` 为真实 `YYYY-MM-DD` 日期，不能晚于上海时区今天，年份至少 1000。不接收时间戳，允许补录生日之前的家庭记录。现有 DATETIME 字段以 UTC 零点存储这个日历日期，响应恢复为同一个日期字符串，前端无需时区转换。
- `customEvent` 最多 100 字符；仅里程碑允许非空自定义事件及指标。
- `metricType` 与 `metricValue` 必须同时提供或同时省略。类型为 `HEIGHT` / `WEIGHT` / `HEAD`，分别表示身高、体重、头围；单位由服务端生成：体重 kg，其余 cm。数值为 JSON number，范围 0.001–9999999.999，最多三位小数。这是数据库存储边界，不是医学正常范围；接口不提供医学判断。
- 每条记录最多一个指标，测量日期来自记录日期。编辑替换指标（指标 ID 会变化）；省略两项指标字段会清除旧指标，转为日记时应同时移除指标和自定义事件。
- `assetIds` 默认空数组，最多 9 个不重复 UUID，顺序作为展示顺序保存。PUT 省略它会移除原素材关联。
- PUT 允许把记录调整到同一家庭的其他宝宝；现有素材不能跨宝宝搬迁，必须移除不属于目标宝宝的关联。创建者、所属家庭、创建时间不变。
- 不接受 `null`、额外字段、客户端指定创建者/所属家庭/单位/ID。表单 ID 放在 URL。

返回字段匹配前端 `Entry`：`id`、`familyId`、`childId`、`creatorId`、`kind`、`title`、`body`、`occurredAt`、`createdAt`、`updatedAt`、`assetIds`，以及存在时的 `customEvent`、`metric`。指标返回 `MetricValue` 字段，数据库 DECIMAL 转为 JSON number。

## 分页

列表统一返回 `{ "items": [...], "nextCursor": "..." }`，没有下一页时省略 `nextCursor`。每页默认 20、最多 200；客户端必须持续使用返回的游标，不应只取首屏作为完整成长曲线。

成长墙按发生日期、ID 倒序；指标按测量日期、ID 正序。同一天的多个记录不会因排序相同而漏页。游标包含时间和 ID，绑定家庭、宝宝筛选及指标类型；切换筛选时清空游标。无效或不匹配游标返回 400。它只是分页位置，不是访问凭据。

分页不是固定快照：用户在翻页期间编辑日期或迁移宝宝时，列表可能变化，应刷新列表。当前按家庭串行化业务操作适合初期小规模使用；未来媒体模块也必须遵守相同锁顺序。

## 素材与删除边界

关联素材必须位于同家庭、同宝宝，状态为 READY；新增关联必须是当前操作者上传的素材。管理员编辑他人记录时可保留原有素材。一个素材只能关联一条记录，不能使用本地路径或任意 COS 对象地址冒充素材 ID。

编辑移除的素材仅解绑，暂时保留素材行和对象，供原上传者再次关联；后续媒体模块需补充未关联素材清理策略。永久删除记录时，关联指标、关联表由外键级联删除，已关联素材标记 DELETING；COS 对象物理删除尚未实现。未来媒体读取接口必须拒绝非 READY 素材，清理任务负责实际删对象后处理素材行。

创建、编辑、删除分别写入 `ENTRY_CREATE`、`ENTRY_UPDATE`、`ENTRY_DELETE` 审计，业务、指标、素材状态和审计在同一事务中，任一步失败全部回滚。前端调用永久删除前应保留现有二次确认。当前开发未连接或删除任何服务器数据。

## Ubuntu 本地联调示例

启动后端并按 [登录文档](auth.md)、[家庭文档](families.md)、[宝宝档案文档](children.md) 准备测试身份和家庭。以下 Bash 命令会新增、编辑测试记录：

```bash
API=http://127.0.0.1:3000/api/v1
read -rsp 'Bearer token: ' TOKEN; echo
read -rp 'Family UUID: ' FAMILY_ID
read -rp 'Child UUID: ' CHILD_ID

curl --fail-with-body "$API/families/$FAMILY_ID/entries" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"childId\":\"$CHILD_ID\",\"kind\":\"MILESTONE\",\"title\":\"身高记录\",\"body\":\"\",\"occurredAt\":\"2024-02-29\",\"assetIds\":[],\"metricType\":\"HEIGHT\",\"metricValue\":80.125}"

curl --fail-with-body "$API/families/$FAMILY_ID/entries?childId=$CHILD_ID&pageSize=20" -H "Authorization: Bearer $TOKEN"
curl --fail-with-body "$API/families/$FAMILY_ID/metrics?childId=$CHILD_ID&type=HEIGHT&pageSize=20" -H "Authorization: Bearer $TOKEN"
read -rp 'Entry UUID from response: ' ENTRY_ID
curl --fail-with-body "$API/families/$FAMILY_ID/entries/$ENTRY_ID" -H "Authorization: Bearer $TOKEN"

# 完整表单编辑，省略指标字段即移除旧指标。
curl --fail-with-body -X PUT "$API/families/$FAMILY_ID/entries/$ENTRY_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"childId\":\"$CHILD_ID\",\"kind\":\"DIARY\",\"title\":\"今天的成长\",\"body\":\"修改正文\",\"occurredAt\":\"2024-02-29\",\"assetIds\":[]}"
unset TOKEN
```

## 验证

`npm run check` 验证构建及单元/HTTP 测试，包括默认鉴权、角色矩阵、伪造身份、家庭与宝宝范围、日期/精度/数组校验、指标单位、素材状态/复用、分页和审计错误传播。

`npm run test:db` 增加实际 MySQL 的 DECIMAL/日期往返、同日记录和指标分页、指标替换/清除、调整宝宝、素材关联、删除级联及审计失败回滚用例。必须指向专用空测试库，配置见 [数据库文档](database.md)。本机没有可用 MySQL，真实库用例仅编译，未执行；后续部署前需在测试库或 CI 完成验收。
