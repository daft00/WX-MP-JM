# 模块 3：登录与身份验证

本模块提供微信 code 登录、当前用户查询、退出登录及受控开发登录。小程序现有 Mock 服务尚未切换；家庭与成员权限现已由 [模块 4](families.md) 提供。

## 登录流程

1. 小程序调用 `wx.login()` 获取临时 `code`，立即提交给后端。
2. 后端使用自己的 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 调用微信 `code2Session`，只信任微信返回的 OpenID。
3. 按 `(wechat_app_id, wechat_openid)` 查找/创建用户；唯一索引处理并发首次登录，已有用户的昵称与系统角色不会被登录覆盖。
4. 后端生成 32 字节密码学随机令牌，仅在此次登录响应返回明文，数据库存储 SHA-256 摘要。
5. 后续请求在 `Authorization: Bearer <accessToken>` 中提交令牌。后端检查会话是否存在、是否过期，并读取用户当前系统角色。

接口已根据 [微信官方登录凭证校验文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html) 核对。微信 `session_key`、OpenID、UnionID 和 AppSecret 不返回给客户端；目前不需要微信数据解密，因而不持久化 `session_key`。

使用数据库会话，不使用 JWT：退出时删除摘要即可吊销当前令牌，角色变化也不需要等待令牌过期。令牌默认有效 7 天，不自动滑动续期；过期后重新执行 `wx.login`。无刷新令牌、密码登录或默认管理员。

## 配置与启动

在 `backend/.env` 中配置（模板见 `.env.example`）：

| 配置 | 规则 |
| --- | --- |
| `MYSQL_URL` | 运行账号 `growth_app`，不使用迁移账号 |
| `WECHAT_APP_ID` | 必须与小程序 AppID 一致 |
| `WECHAT_APP_SECRET` | 服务端专用，与 AppID 成对配置 |
| `AUTH_SESSION_TTL_SECONDS` | 60–604800 秒，默认 604800 |
| `ENABLE_DEV_LOGIN` | 默认 `false`，生产环境禁止开启 |
| `DEV_LOGIN_KEY` | 开发登录开启时必填，随机 32 字节的 64 位 hex 字符串 |
| `INVITE_CODE_SECRET` | 模块 4 邀请码专用密钥，独立随机 64 位 hex，生产必填 |

`NODE_ENV=production` 时微信凭据必填；非生产允许留空，此时微信登录返回 503，不能自动降级为开发身份。任何环境都不接受只配置 AppID 或只配置 AppSecret。

先配置独立 `.env.migration`，在目标库执行模块 2 的初始迁移和本模块追加的 `AuthSessions1790985601000`：

```bash
npm ci
npm run build
npm run migration:show
npm run migration:run
npm run start:dev
```

已执行过初始迁移的数据库只会追加 `auth_sessions`；全新数据库依次执行两项迁移。应用不会自动建表或读取迁移凭据。数据库故障时存活检查仍可用，登录/鉴权不会回退为匿名或 Mock 身份。

运行数据库连接采用最多 5 个连接的小型连接池，每个业务事务设置 UTC；新增 `User`、`AuthSession` 两个实体，关闭结构自动同步。其他业务表仍以模块 2 的迁移定义为准。

## API

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/auth/wechat/login` | `{"code":"wx.login返回的临时代码"}` | 200，令牌和用户 |
| `GET /api/v1/auth/me` | Bearer 令牌 | 200，`{"user":{...}}` |
| `POST /api/v1/auth/logout` | Bearer 令牌 | 204，无响应体；吊销当前会话 |
| `POST /api/v1/auth/dev/login` | 开发开关、密钥头及固定身份，见下文 | 200，开发会话 |

登录成功响应：

```json
{
  "accessToken": "<43字符随机令牌>",
  "tokenType": "Bearer",
  "expiresAt": "2026-10-10T00:00:00.000Z",
  "user": { "id": "<UUID>", "nickname": "微信用户", "avatarText": "我" }
}
```

新用户统一以普通身份创建，昵称后续通过资料接口修改；客户端不能通过登录请求指定 `userId`、`openid`、昵称或 `systemRole`。传入额外字段返回 400。只有数据库中的真实系统管理员才会得到 `systemRole: "SYSTEM_ADMIN"`，此角色本身不授予任何家庭媒体访问权。

已有前端 `Session` 类型包含家庭及成员，新登录用户可能没有家庭，因此此处仅返回用户与令牌；后续 HTTP 适配层应在选择/创建家庭后组成家庭会话，不能伪造一个默认家庭。

所有新路由默认需要身份验证。只有显式标记 `@Public()` 的登录及健康检查公开，业务控制器通过请求上的 `auth.user` 取得身份。不能把“已登录”当作“可访问任意家庭”，家庭接口进一步按当前成员关系鉴权。

错误沿用统一结构：

- 400：参数缺失、格式错误或包含未声明字段。
- 401：无效/过期/已吊销令牌、无效微信 code、开发密钥不正确。
- 403：微信返回风险用户拦截。
- 404：开发登录未开启或当前为生产环境。
- 429：登录限流或微信上游限流。
- 503：微信凭据未配置、微信超时/不可用，或数据库初始连接失败；其他数据库异常使用通用 500，不暴露 SQL。

微信请求总超时 5 秒，禁止重定向，不自动重试一次性 code，不透传上游 `errmsg`。成功的认证响应禁止缓存；401 响应带 `WWW-Authenticate: Bearer`。只从 Authorization 头读取令牌，不接受查询参数、Cookie 或自报用户 ID。

## 开发联调

开发登录仅用于自己的开发数据库。用以下命令生成密钥，将结果只填入本机 `.env` 的 `DEV_LOGIN_KEY`，并设置 `ENABLE_DEV_LOGIN=true` 后重启：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

请求示例（占位符需替换）：

```http
POST /api/v1/auth/dev/login
Content-Type: application/json
X-Dev-Login-Key: <本机DEV_LOGIN_KEY>

{"identity":"developer"}
```

仅允许 `developer`、`member`、`outsider` 三种固定测试身份，彼此为独立用户，均不自动成为家庭成员或管理员。身份存储在独立的 `dev-local` AppID 命名空间，会话标为 `DEV`，最长 1 小时。关闭开发开关或切到生产环境后，既有开发令牌也会被拒绝，不能通过复制会话表绕过生产限制。

开发接口本身无需 Bearer，但始终要求开发开关和独立密钥；密钥不要写进小程序包、公共环境或 Git。服务仅默认监听回环地址，正式环境始终使用 HTTPS 入口。

## 限流与会话维护

两个登录接口分别按来源 IP 限制每分钟 10 次，使用 NestJS 官方 throttler。当前是单进程内存计数，进程重启会重置；多实例部署时再切换共享存储。Express 默认不信任 `X-Forwarded-For`，不可自行信任任意代理头；接入 Nginx 后应在部署阶段明确受信任的代理范围，否则所有经代理登录的用户会共用代理 IP 的限额。

过期会话在查询及鉴权层拒绝，退出会立即删除当前会话，不影响同用户其他设备。过期行尚未自动物理清理；维护时可在确认目标数据库后分批清理（不由应用启动自动执行）：

```sql
DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP(3) LIMIT 1000;
```

会话迁移回滚仅允许空 `auth_sessions`，即使全部会话过期也不会自动删除。不要在常驻 API 环境中配置迁移账号。

## 验证边界

`npm run check` 覆盖真实 HTTP 路由、默认鉴权、参数拒绝、令牌摘要、过期及退出、角色更新读取、开发开关及生产隔离、限流和微信错误映射。自动化测试使用微信响应/数据库存储替身，不向微信发送真实 code。

`npm run test:db` 已扩展：在专用空 MySQL 8.4 测试库验证两次迁移、运行时 ORM、并发首次登录去重、会话过期/吊销、非空会话表回滚保护和逆序回滚。配置方法见 [数据库文档](database.md)。

本轮未配置真实微信 AppSecret 或本地 MySQL，没有完成真实微信登录及真实数据库集成验收，也未部署服务器或切换前端服务。上线前须完成上述验收及后续业务模块验收。
