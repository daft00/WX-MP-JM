# 阶段3.1：真实会话与家庭、宝宝读取

2026-10-23：代码和本地自动化验证完成，等待微信开发者工具连接真实服务器验收。无需后端部署或数据库迁移。

## 本次范围

- `services/index.ts` 固定使用 HTTP 服务，无 Mock 回退。
- `IdentitySession` 仅含用户身份；旧 `Session` 表示有家庭及成员关系的上下文。登录不再要求已有家庭。
- 显式点击微信登录，使用 `wx.login` code 请求现有 `/auth/wechat/login`。并发登录共享同一请求，失败重试取得新的 code。
- 令牌和有效期保存在按 API 地址隔离的 Storage 键中；不存 AppSecret、不记录令牌。重新编译后用 `/auth/me` 恢复身份；家庭/宝宝选择仅保存在内存，重新进入时重新选择。
- 家庭列表/详情、宝宝列表/详情均读取现有接口。没有家庭、没有宝宝、加载、网络错误及重试均有界面。
- 401 清空令牌和选择，等待用户重新登录；不自动重发任何请求。403/404 清除当前家庭选择，重新读取可访问家庭。切换家庭时丢弃旧请求结果。
- 退出先清本地状态，再调用后端吊销当前令牌；网络失败会明确提示服务器吊销未确认。
- 当前应用仅注册选择页，并在同页显示宝宝详情。旧页面源文件保留，但不开放路由/Tab；未接入服务一律拒绝，不能写入演示数据。
- 本次未改后端、数据库、服务器或已有本地演示资料；不能将此中间版本作为正式版发布。

## 当前先做：电脑 SSH 隧道验收

备案仍在审核，保持服务器现有监听状态。以下命令在电脑 PowerShell 执行，使用原有 SSH 登录方式；如需私钥，使用已配置的 SSH 别名或自行添加 `-i`，不要复制私钥内容。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:13000:127.0.0.1:3000 ubuntu@139.155.137.143
```

保持这个窗口运行。在另一个 PowerShell 窗口验证隧道：

```powershell
curl.exe --noproxy "*" --fail http://127.0.0.1:13000/api/v1/health/ready
```

预期 `{"status":"ok","database":"up"}`。本地 HTTP 仅走电脑回环及加密 SSH 隧道，不能把3000端口开放到公网；此检查不覆盖 Nginx HTTPS。

1. 微信开发者工具打开本仓库 `manman WX program`，确认 AppID 与服务器 `WECHAT_APP_ID` 一致。
2. 仅在开发者工具本地联调时关闭合法域名校验。打开调试器 Console 执行：

   ```javascript
   wx.setStorageSync("growth_diary_dev_api_url", "http://127.0.0.1:13000/api/v1")
   ```

3. 点击“编译”（切换 API 地址必须重新编译）。页面应显示“开发者工具 · SSH隧道联调”。
4. 点击“微信登录”。已有账号应显示服务器中的昵称、家庭列表；选择已有家庭及宝宝，核对姓名、生日、称呼。不要为验收重复创建家庭。
5. 返回家庭选择再进入，确认宝宝选择已清除；点击退出后，不再显示家庭和宝宝。重新登录仍可读取原有资料。
6. 断开隧道后刷新，应显示网络错误而不是演示资料或空列表成功；恢复隧道后可重试。

登录可能首次创建微信用户及会话，这是后端既有登录行为；本版本没有家庭、宝宝、记录的写入入口。开发者工具中的微信账号必须与之前联调账号一致，才能看到同一用户的家庭。测试新账号出现“尚未加入家庭”是合法状态。

不要将真实 code、accessToken、Storage 全量内容或 AppSecret 贴到聊天/截图中。只需反馈成功/错误提示及家庭、宝宝信息是否正确。

## 恢复默认 HTTPS 地址

```javascript
wx.removeStorageSync("growth_diary_dev_api_url")
```

重新编译后使用 `https://api.daftjiang.cn/api/v1`。覆盖项仅在 `envVersion=develop` 且设备平台为 `devtools` 时读取；体验版、正式版和真机均忽略覆盖项。公网 HTTPS、备案及微信合法域名完成前，不进行真机网络验收。生产地址没有本机默认值或开发登录回退。

## 自动化验证

在仓库根目录执行 `npm run check`，覆盖既有媒体/导出/记录分组回归和新增会话测试。普通测试跳过一项需要本地 Postman 服务的网络用例。

本地网络模拟来自仓库内后端接口文档，不使用真实用户资料，也未查找或发布外部团队的 Mock。启动：

```powershell
postman simulation run postman/simulations/growth-read.sim.yaml --port 14900 --no-history --output ndjson
```

另开 PowerShell：

```powershell
$env:GROWTH_SIM_URL = 'http://127.0.0.1:14900/growth/api/v1'
node --test test/http-services.test.cjs
Remove-Item Env:GROWTH_SIM_URL
```

该用例运行实际 HTTP 适配层，通过 Node fetch 提供 wx.request 的网络桥接；wx.login 使用测试 code。验证登录、已有家庭/宝宝、无家庭、无宝宝、401失效和退出，Postman 请求日志可核对路径及状态。它不等于微信原生运行时、真实微信 code 交换或服务器数据库验收。结束后关闭启动服务的终端进程。

后续仍需：微信开发者工具实际登录及显示验收、真机测试。阶段3.2写入、COS和记录等模块另行确认实施。
