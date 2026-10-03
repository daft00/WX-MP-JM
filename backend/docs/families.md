# 模块 4：家庭、成员和邀请

复用既有 `families`、`family_members`、`invites`、`audit_logs` 表，不新增迁移或依赖。业务 SQL 通过 TypeORM 的事务管理器执行，所有请求值使用参数绑定；认证和家庭模块共享同一个最多 5 连接的运行账号连接池。

## 配置

新增 `INVITE_CODE_SECRET`，用于邀请码 HMAC-SHA256。生成独立随机密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

仅将输出配置到后端 `.env` / 服务器环境变量，不提交 Git、写入前端或与 `DEV_LOGIN_KEY` 共用。格式为 64 位 hex；生产环境缺失时启动失败。非生产允许留空，但创建/消费邀请返回 503，其他家庭接口可用。

密钥需要持久保存，重启不应更换；更换后已有未使用邀请码全部失效。多个 API 实例必须使用同一密钥。运行前先完成模块 2–3 的两项迁移，模块 4 不改变已有结构。

## API

全部接口要求 `Authorization: Bearer <accessToken>`，用户 ID 来自服务端会话，不能由请求体指定。路径 ID 必须为 UUID v4。

| 接口 | 请求体 | 响应 |
| --- | --- | --- |
| `GET /api/v1/families` | 无 | 200，本人的家庭数组 |
| `POST /api/v1/families` | `{"name":"我的家庭"}` | 201，创建的家庭 |
| `GET /api/v1/families/:familyId` | 无 | 200，家庭详情 |
| `GET /api/v1/families/:familyId/members` | 无 | 200，成员及公开用户资料数组 |
| `POST /api/v1/families/:familyId/invites` | 无 | 201，一次性邀请码 |
| `POST /api/v1/families/join` | `{"code":"16位邀请码"}` | 200，加入的家庭 |
| `PATCH /api/v1/families/:familyId/members/:memberId` | `{"role":"ADMIN"}` 或 `{"role":"MEMBER"}` | 200，更新后的成员 |
| `DELETE /api/v1/families/:familyId/members/:memberId` | 无 | 204，无响应体 |

家庭名去除首尾空白后为 2–20 字符，与现有原型一致。家庭响应：`{id,name,ownerId,createdAt}`。成员响应：`{id,familyId,userId,role,joinedAt,user:{id,nickname,avatarText}}`，不包含 OpenID、令牌或用户的全局系统角色。

创建邀请返回 `{id,familyId,creatorId,code,expiresAt}`；仅此响应包含邀请码明文，不提供邀请码列表/找回接口。家庭、成员、邀请等数据响应禁止缓存。

## 权限

| 操作 | OWNER | ADMIN | MEMBER |
| --- | --- | --- | --- |
| 查看本家庭及成员 | 允许 | 允许 | 允许 |
| 生成邀请码 | 允许 | 允许 | 禁止 |
| 调整他人的 ADMIN/MEMBER 角色 | 允许 | 禁止 | 禁止 |
| 移除其他 ADMIN | 允许 | 禁止 | 禁止 |
| 移除其他 MEMBER | 允许 | 允许 | 禁止 |
| 修改/移除 OWNER | 禁止 | 禁止 | 禁止 |
| 通过移除接口移除自己 | 禁止 | 禁止 | 禁止 |

所有登录用户都可创建家庭；创建家庭、创建 OWNER 成员和写入审计在同一事务中完成。加入家庭固定获得 MEMBER，不能通过邀请码指定 ADMIN。

未加入的家庭和不存在的家庭统一返回 404；成员 ID 必须属于路径中的家庭，不能将别的家庭成员 ID 用于修改/移除。SYSTEM_ADMIN 身份不绕过这些规则，本模块没有全局管理接口。

每次请求读取当前成员关系，不在登录令牌中缓存家庭权限。成员被移除后，后续请求立即失去该家庭访问权限；保留其历史宝宝/记录、用户账号和登录会话。其他家庭的身份不受影响。

## 邀请与事务

- 邀请码使用 8 字节随机数，呈现为 16 位大写十六进制；接受小写和首尾空白，数据库只存 HMAC 摘要。
- 有效期固定 24 小时，过期检查使用数据库 UTC 时间。无效、已使用、过期及已失效的邀请统一返回 400。
- 邀请者必须仍是当前家庭的 OWNER/ADMIN。管理员降级为 MEMBER 或被移除时，同事务删除其未使用邀请；已使用邀请保留。
- 已经是成员的用户尝试使用有效邀请返回 409，不消耗该邀请。
- 操作先锁家庭行，再锁邀请/成员并重查权限。消费使用条件更新，将使用时间、使用者、新成员和审计同事务提交。相同邀请码并发使用只能成功一次；同一用户用不同邀请码并发加入也只能产生一条成员关系。
- 小规模实现按家庭串行处理，以避免权限检查与成员变更之间的竞态。锁仅覆盖数据库操作，没有微信网络请求；高并发时再考虑更细粒度的锁。
- 创建家庭、创建邀请、加入家庭、角色变更和移除成员均写审计。审计失败导致业务事务回滚；审计只保存动作、操作者和目标 ID，不保存邀请码、请求正文或密钥。审计理由当前使用固定动作标识，不是全局管理员的人工排障授权流程。

创建家庭、创建邀请和加入家庭分别按来源 IP 限制每分钟 10 次，复用模块 3 的单进程限流；反向代理配置与多实例限制见 [身份验证文档](auth.md)。

## 与前端服务的对应

| 现有方法 | 后端 / 客户端处理 |
| --- | --- |
| `listAccessibleFamilies` | `GET /families` |
| `createFamily` | `POST /families` |
| `getCurrentFamily` / `selectFamily` | 使用客户端选择的 ID 调用 `GET /families/:familyId`，成功后再更新本地选择 |
| `listMembers` | `GET /families/:familyId/members` |
| `createInvite` / `joinFamily` | 上表邀请/加入接口 |
| `updateMemberRole` / `removeMember` | 上表成员变更接口 |
| `getSelection` / `clearSelection` | 客户端状态，不写入服务端会话 |
| `selectChild` | 使用 [宝宝详情接口](children.md) 校验家庭归属，选择状态保留在客户端 |

本次未切换前端 Mock。现有 Mock 邀请码仅在本机有效，不能提交给真实后端；真实接口的邀请码长度为 16 位。

本模块不增加家庭删除、OWNER 转让、自助退出、全局系统管理或宝宝/记录接口。这些功能需独立定义权限和数据处理规则。

## 本地联调顺序

1. 配置运行账号、迁移账号和 `INVITE_CODE_SECRET`，执行 `npm run build`、`npm run migration:run`。
2. 按 [模块 3 文档](auth.md) 获取两个不同普通用户的 Bearer 令牌；开发身份不会自动成为家庭成员。
3. 用户 A 创建家庭并获取家庭 ID，然后生成邀请码。
4. 用户 B 使用邀请码加入，以两人的令牌分别查看家庭及成员。
5. 用户 A 将 B 提升为 ADMIN，验证 B 可以邀请但不能调整成员角色。
6. 用户 A 移除 B，验证 B 的家庭查询返回 404，B 生成但未使用的邀请返回 400。

## 测试与限制

`npm run check` 包含权限矩阵、非成员不可访问、成员 ID 范围、邀请码摘要、邀请状态重查、HTTP 参数校验、登录身份绑定和限流测试。此处数据库查询使用受控替身，不能证明真实 SQL 和数据库锁已通过验收。

`npm run test:db` 已添加真实 MySQL 8.4 用例：家庭隔离、SYSTEM_ADMIN 不越权、角色限制、两个并发邀请消费、重复入会、过期邀请、降级/移除后的邀请失效、历史内容保留，以及审计故障时家庭/加入事务回滚。入口仍强制专用空测试库，配置方式见 [数据库文档](database.md)；CI 会执行同一测试。

本机没有可用 MySQL，本轮真实数据库并发测试尚未执行，也未部署云服务器。应在测试库或 CI 完成验收后再部署。
