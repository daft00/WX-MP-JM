# 成长日记后端 · 模块 1–8

独立的 NestJS 11 + TypeScript 工程，使用 Node.js 22 LTS。依赖和构建产物与小程序分开，不影响现有 Mock 原型。

当前实现环境配置校验、全局 DTO 参数校验、统一错误响应、进程/数据库健康检查、12 张表的 TypeORM 迁移、微信登录与会话鉴权，以及家庭、成员、一次性邀请、宝宝档案、成长记录、指标、系统管理和审计 API。数据库为现有 Ubuntu 服务器使用的 MySQL 8.4；迁移须单独执行，应用启动不会自动建表，媒体上传 API 尚未实现。

**表结构、迁移操作、回滚边界及真实数据库验收见 [模块 2 文档](docs/database.md)。**

微信配置、登录接口、开发身份与会话机制见 [模块 3 文档](docs/auth.md)。

家庭接口、权限矩阵、邀请码配置与联调步骤见 [模块 4 文档](docs/families.md)。

宝宝档案接口、校验规则与联调命令见 [模块 5 文档](docs/children.md)。

成长记录与指标接口、分页、编辑/删除权限及素材关联见 [模块 6 文档](docs/entries.md)。

系统管理、数据隐私边界、操作理由、审计及首位管理员配置见 [模块 7 文档](docs/admin.md)。

Ubuntu 构建、systemd 部署、备份/迁移、升级回退及 SSH 隧道联调见 [模块 8 文档](docs/deployment.md)。

## 本地启动

在本目录执行以下命令（Windows PowerShell）：

```powershell
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm run start:dev
```

Ubuntu 对应步骤：

```bash
npm ci
test -f .env || cp .env.example .env
nano .env
npm run start:dev
```

将 `.env` 中的 `MYSQL_URL` 改为本地 MySQL 的运行账号连接串。现有服务器数据库脚本使用同名变量，运行账号为 `growth_app`；不要使用 `root` 或 `growth_migrator`。密码中的 `@`、`:`、`#` 等字符需要进行 URL 编码。`.env` 被 Git 忽略，不能提交真实密码。

配置格式有效时，即使暂时没有 MySQL，也能启动并验证进程接口；数据库接口此时返回 503。只有实际执行 `SELECT 1` 成功才报告数据库可用。

| 变量 | 默认值 / 要求 |
| --- | --- |
| `NODE_ENV` | `development`；仅允许 `development`、`test`、`production` |
| `HOST` | `127.0.0.1`；必须是 IPv4/IPv6 地址 |
| `PORT` | `3000`；整数 1–65535 |
| `MYSQL_URL` | 必填，`mysql://用户名:密码@地址:端口/数据库`；端口默认 3306，不允许查询参数或片段 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 成对配置，生产环境必填 |
| `AUTH_SESSION_TTL_SECONDS` | 默认 604800，范围 60–604800 |
| `ENABLE_DEV_LOGIN` / `DEV_LOGIN_KEY` | 默认关闭；开启需随机 64 位 hex 密钥，禁止生产开启 |
| `INVITE_CODE_SECRET` | 独立随机 64 位 hex 邀请码密钥，生产必填；非生产缺失时邀请功能返回 503 |

进程环境变量优先于本目录 `.env`。配置缺失或格式错误时启动失败，错误信息不包含连接串。默认只监听本机；后续部署可由 Nginx 反向代理，不需要开放 MySQL 公网端口。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run start:dev` | 编译、启动并监听源码变化 |
| `npm run build` | 构建至 `dist/` |
| `npm start` | 运行已构建的 `dist/main.js`，需要先构建 |
| `npm run typecheck` | 检查源码 TypeScript 类型 |
| `npm test` | 编译并执行 Node.js 原生测试，无需真实数据库 |
| `npm run check` | 构建 + 测试 |
| `npm run migration:show` | 查看待执行迁移（需先构建和配置迁移账号） |
| `npm run migration:run` | 执行待应用迁移 |
| `npm run migration:revert` | 回滚最后一次迁移；初始结构只允许空库回滚 |
| `npm run test:db` | 在显式指定的 MySQL 8.4 专用空库验收迁移及约束 |

从仓库根目录也可执行 `npm --prefix backend run check`。前端原有 `npm run check` 保持独立。

## 健康检查

```bash
curl -i http://127.0.0.1:3000/api/v1/health/live
curl -i http://127.0.0.1:3000/api/v1/health/ready
```

Windows PowerShell 使用 `curl.exe`。

| 接口 | 结果 |
| --- | --- |
| `GET /api/v1/health/live` | HTTP 200，`{"status":"ok"}`；不依赖数据库 |
| `GET /api/v1/health/ready` | 数据库可用时 HTTP 200，`{"status":"ok","database":"up"}`；不可用时 HTTP 503 |

数据库检查对配置中的数据库执行只读 `SELECT 1`，每次创建短连接，最多等待 3 秒，完成或失败后销毁连接。它检查连接和查询能力，不代表业务表、迁移或应用账号的全部权限已就绪。健康接口无需登录、不返回数据库地址或版本，并禁用响应缓存。

## 参数与错误约定

所有路由使用 `/api/v1` 前缀。后续请求 DTO 应使用类和 `class-validator` 装饰器；全局管道转换为 DTO 实例，拒绝未声明字段、缺失必填项和错误类型，不自动把字符串转换成数字。模块 1 的健康接口没有业务参数，DTO 校验通过仅在测试中注册的控制器验证。

错误统一保留 HTTP 状态码，示例：

```json
{
  "statusCode": 503,
  "code": "SERVICE_UNAVAILABLE",
  "message": "Service unavailable",
  "path": "/api/v1/health/ready",
  "timestamp": "2026-10-03T00:00:00.000Z"
}
```

DTO 校验失败为 400，`message` 为错误数组。404、403、JSON 解析错误也使用此结构。未知异常为 500，不向客户端暴露堆栈、SQL 或原始异常；5xx 日志只记录状态码，不记录连接串、请求参数或原始异常。成功响应直接返回资源，不额外包装。

## 验证与边界

测试覆盖配置校验、无效配置启动退出、真实 HTTP 请求、DTO 转换及拒绝额外字段、400/403/404/500/503 响应、异常脱敏，以及真实 TCP 握手超时和连接释放。HTTP 中的数据库成功/失败分支使用替身验证，不代表已连通真实 MySQL。

如需执行真实 MySQL 检查，在测试进程环境中设置 `TEST_MYSQL_URL` 后运行 `npm test`；未设置时该项明确跳过。应使用专用测试数据库的运行账号，测试只执行 `SELECT 1`。

模块 2–3 迁移使用单独的 `.env.migration` / `MIGRATION_DATABASE_URL`；API 不读取此文件。模块 4–7 复用已有表，不增加迁移。运行账号 `.env` / `MYSQL_URL` 保持不变。本次未执行服务器部署、小程序服务切换或真实微信登录；后续接入媒体上传与私有访问。
