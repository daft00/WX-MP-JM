# 模块 2：数据库表结构与迁移

目标数据库为 **MySQL 8.4 LTS**，与现有 Ubuntu 服务器一致。使用 TypeORM 0.3 管理迁移历史，继续复用 `mysql2` 驱动。应用启动不执行迁移，`synchronize` 和 `migrationsRun` 均关闭。

## 表结构

初始迁移文件是字段、类型、外键和索引的唯一来源：
[1790985600000-initial-schema.ts](../src/database/migrations/1790985600000-initial-schema.ts)。

| 表 | 主要字段 / 作用 | 关键约束及索引 |
| --- | --- | --- |
| `users` | 微信用户、昵称、头像文字、系统角色 | `(wechat_app_id, wechat_openid)` 唯一；OpenID 大小写敏感 |
| `families` | 家庭名称、创建者 | `owner_id` 引用用户 |
| `family_members` | 用户所属家庭及 OWNER/ADMIN/MEMBER 角色 | `(family_id,user_id)` 唯一；OWNER 必须与家庭创建者一致；按用户查询家庭索引 |
| `children` | 宝宝姓名、生日、显示性别、头像颜色、创建者 | 家庭外键；按家庭查询宝宝索引 |
| `entries` | DIARY/MILESTONE、标题、正文、自定义事件、成长时间 | `(child_id,family_id)` 复合外键；成长墙 `(family_id,child_id,occurred_at,id)` 索引 |
| `assets` | IMAGE/VIDEO、上传状态、COS 对象键、文件名、MIME、字节数 | 对象键唯一；宝宝/家庭复合外键；待处理素材清理索引 |
| `entry_assets` | 记录关联素材及展示顺序 | 同时引用记录和素材的家庭/宝宝范围；单素材只关联一条记录；顺序 0–8 且同记录不重复 |
| `metrics` | HEIGHT/WEIGHT/HEAD、数值、单位、测量时间 | 一条记录至多一个指标；值必须大于 0；体重 kg、身高/头围 cm；趋势查询索引 |
| `invites` | 邀请码摘要、创建者、过期和使用信息 | 摘要唯一；有效期晚于创建时间；使用时间与使用者同时为空或同时存在 |
| `export_jobs` | 导出月份、状态、分卷数、过期/确认时间 | 宝宝/家庭复合外键；家庭列表和任务队列索引 |
| `audit_logs` | 操作者、家庭、动作、目标标识、操作理由 | 操作者/家庭外键；按家庭及操作者查询时间线 |

此外 TypeORM 自动维护 `schema_migrations`，它不属于业务表。没有默认管理员、演示用户或真实家庭种子数据。

模块 3 追加迁移 `AuthSessions1790985601000`，新增第 12 张表 `auth_sessions`：令牌摘要主键、用户外键、WECHAT/DEV 来源、创建/过期时间，以及用户和过期时间索引。用户删除级联删除其会话。初始迁移文件未改写，微信登录和受控开发登录会按需创建普通用户。详细身份流程见 [模块 3 文档](auth.md)。

通用约定：

- 业务 ID 由后端生成 UUID，存为 `CHAR(36)` ASCII 二进制排序；不使用前端 Mock ID。
- 文字使用 `utf8mb4_0900_ai_ci`，支持中文及 emoji。OpenID、对象键、摘要等标识大小写敏感。
- 生日是 `DATE`；业务时间是 `DATETIME(3)`，统一按 UTC 写入。迁移连接显式设置 UTC；后续业务连接也必须设置会话 UTC，不能仅依赖驱动的日期转换选项。
- 字节数使用无符号 `BIGINT`，驱动按字符串返回，避免超过 JavaScript 安全整数；指标使用 `DECIMAL(10,3)`，同样按字符串读取并由 API 显式转换。
- 保留 `creator_id` 对用户的引用，不绑定当前成员表：成员退出家庭后，历史记录仍保留作者。
- 默认禁止级联删除家庭、宝宝、用户和素材。删除一条记录只级联清理 `entry_assets` 和 `metrics`，保留素材数据库行，供后续 COS 删除补偿流程处理。

## 与前端模型的对应

数据库使用 snake_case，API 将转换为现有 camelCase 服务模型，不修改前端接口。`entry.assetIds` 来自 `entry_assets` 按 `position` 排序；`entry.metric` 来自 `metrics`；`asset.name` 对应 `original_name`。`localPath`、`volatile` 和签名 URL 不入库，素材按私有 COS 对象键保存。

`Invite.code` 只在后续创建邀请时返回；数据库只保存 64 位十六进制摘要。短邀请码应使用服务端密钥做 HMAC-SHA256，不能仅对低熵短码做无密钥哈希。系统普通用户存为 `USER`，API 可省略 `systemRole`；导出额外支持 `FAILED` 和 `EXPIRED`，接入该 API 时再扩展前端状态显示。

## 仍由业务事务保证的约束

复合外键可防止跨家庭/跨宝宝关联，但不能替代接口鉴权。业务层职责如下（家庭相关部分已由模块 4 实现，内容/媒体部分待后续模块）：

- 创建家庭和 OWNER 成员在同一事务中完成。数据库限制 OWNER 身份及至多一个 OWNER，但不能保证每个家庭始终至少存在一条 OWNER 成员记录。
- 对每次读写验证当前用户的成员关系与角色；校验指标作者和记录作者、素材上传者及资源归属。
- 邀请消费使用行锁或条件更新，把未过期/未使用检查、设置使用者和加入家庭放入同一事务，防止重放。
- 只有已核验的 READY 素材可关联记录；限制类型、大小、数量，删除 COS 对象使用可重试补偿，不只删除数据库行。
- 审计写入与管理员操作同事务；审计不是不可篡改存储，不记录密码、邀请码明文、签名 URL 或媒体内容。
- 微信登录与会话由模块 3 提供；邀请码 HMAC、家庭成员鉴权及管理操作审计由模块 4 提供。内容状态流转、COS、导出执行和相关数据访问随对应业务模块实现。

## 执行迁移

以下命令均在 `backend/` 中执行。先确认数据库是预期目标，已有数据需先备份；迁移是单独维护步骤，不能放进 API 启动命令。

1. 安装依赖并构建：

   ```bash
   npm ci
   npm run build
   ```

2. 准备迁移配置。Windows PowerShell：

   ```powershell
   if (!(Test-Path .env.migration)) { Copy-Item migration.env.example .env.migration }
   notepad .env.migration
   ```

   Ubuntu：

   ```bash
   test -f .env.migration || (umask 077; cp migration.env.example .env.migration)
   chmod 600 .env.migration
   nano .env.migration
   ```

   将 `MIGRATION_DATABASE_URL` 设置为 **growth_migrator** 的连接串。服务器初始化脚本已生成这个变量，保存在受保护的 `/etc/growth-diary/database.env` 中；由服务器管理员安全配置，不提交或发送密码。进程环境变量优先于 `.env.migration`。

3. 查看并执行：

   ```bash
   npm run migration:show
   npm run migration:run
   npm run migration:show
   ```

   空库首次依次应用 `InitialSchema1790985600000`、`AuthSessions1790985601000`；已有初始结构的库只追加会话迁移。再次执行不重复建表，显示 `No pending migrations`。`show` 首次会创建迁移历史表，因此也需要迁移账号，不能当作完全只读命令。

运行账号 `MYSQL_URL` 仍只放在 `.env` 或常驻服务环境中；迁移工具只读取 `MIGRATION_DATABASE_URL`，绝不回退到运行账号。迁移账号具备已有脚本授予的 SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/INDEX/REFERENCES 权限，不需全局管理权限。

工具在同一数据库连接上持有 MySQL 命名锁并执行迁移，防止本工具的多个实例同时修改结构；失败时释放锁并关闭连接。不支持直接绕过本工具并发运行 TypeORM CLI 或手工 DDL。

## 回滚和中途失败

**MySQL DDL 会隐式提交，不能承诺整个迁移原子回滚。** 初始迁移会先检查所有目标表是否不存在；任何同名表都会拒绝继续，不会用 `IF NOT EXISTS` 掩盖结构漂移。

若断电、权限不足等导致只创建了一部分表，停止重试；对照迁移文件及 `schema_migrations` 检查实际状态。优先恢复经过核验的备份；对于确认无数据的开发库，由维护者审核后清理或改用新的空库再执行。工具不会自动删除部分结果，也不应手工伪造迁移历史。

仅对已停服务、无并发写入的空开发库，可执行：

```bash
npm run migration:revert
```

每次只回滚最后一项：先回滚会话表，再次执行才回滚初始业务结构。会话迁移拒绝删除非空会话表；初始迁移在任何 DROP 前检查其全部业务表，一旦发现数据即拒绝回滚。这个检查不能隔离其他应用的并发写入，所以必须先停服务。已有数据的环境使用新的前向迁移；不要为了回滚清空业务表。回滚保留 TypeORM 历史表供后续再次升级。

## 验证

```bash
npm run check
```

包括模块 1 回归，以及迁移凭据隔离、部分表检测、非空库回滚保护测试。真实 SQL 验证单独执行：

1. 在测试 MySQL 8.4 中创建**专用空库** `growth_diary_test`（或 `growth_diary_test_` 加小写字母/数字后缀），授权一个仅访问该库的迁移账号。
2. 在当前终端安全设置 `TEST_MIGRATION_DATABASE_URL`，不要使用生产连接串。
3. 执行 `npm run test:db`。

集成测试拒绝其他库名和非空库；测试升级、重复执行、唯一约束、OWNER 关系、跨家庭/跨宝宝外键、CHECK 约束、删除策略、空库回滚和重新升级。测试中的数据处于事务内并回滚；正常完成后删除本测试创建的表。结构操作异常时可能保留表供排查，不会清空已有数据库。未提供配置时该命令失败，不会跳过后报告成功。

仓库已增加 `.github/workflows/backend.yml`，推送/PR 后可在隔离的 MySQL 8.4 服务上执行同一套验收；临时账号只用于 CI 服务。本地若没有 MySQL，普通测试通过不代表真实迁移已通过，应以 `test:db` 或 CI 实际结果为准。
