# 模块 8：Ubuntu 部署、升级与回退

适用于现有单机：Ubuntu 26.04、Node.js 22（`/usr/bin/node`）、MySQL 8.4，2 核/2GB。复用已有 `/etc/growth-diary/database.env` 及 growth_app / growth_migrator 数据库账号。脚本不会重装数据库、重置密码、开放防火墙、配置域名或自动发布小程序。

当前优先通过 SSH 隧道验收。媒体上传/私有访问、导出仍未实现，小程序仍使用 Mock；部署成功不代表全部产品已上线。

## 文件与执行身份

| 文件 | 用途 | 执行身份 |
| --- | --- | --- |
| `scripts/build-backend.sh` | 在新目录安装依赖、构建、测试、裁剪开发依赖 | ubuntu，不加 sudo |
| `scripts/deploy-backend.sh` | 初始化、导入版本、备份、迁移、切换及验证 | sudo |
| `scripts/deploy/growth-diary.service` | systemd API 服务模板 | API 以 growth-api 系统账号运行 |
| `scripts/deploy/release-tools.cjs` | 配置生成及数据库/迁移检查 | 部署脚本内部使用 |
| `scripts/deploy/nginx.conf.example` | 可选 HTTPS 反向代理模板 | 人工核对后安装 |

固定目录：

```text
/etc/growth-diary/database.env  # 原有数据库凭据，root:root 600
/etc/growth-diary/app.env       # 运行账号 + API 配置，root:root 600
/etc/growth-diary/migration.env # 仅迁移连接串，root:root 600
/opt/growth-diary/releases/版本号/
/opt/growth-diary/current      # 当前版本软链接
/opt/growth-diary/previous     # 上次成功切换前的版本软链接
/opt/growth-diary/backups/     # root-only SQL 备份，不自动清理
```

systemd 由系统管理器读取环境文件，再以无登录权限的 growth-api 启动 API。迁移使用独立 growth-migrate 系统账号和 growth_migrator 数据库账号。发布目录归 root 所有，API 只读；npm 构建不以 root 运行。仅导入自己核对过的可信源码构建，不接收他人提供的任意发布目录。

## 1. 把当前代码传到服务器

模块 1–8 当前仍有未提交文件，直接 `git pull` 不会获取它们。本轮没有代你提交或推送。可先采用以下白名单源码包，不包含 `.env`、密钥或 Windows node_modules。

本地 PowerShell，进入项目根目录：

```powershell
Set-Location 'C:\Users\Daft Jiang\Desktop\WX MP JM\manman WX program'
$bundle = Join-Path $env:TEMP 'growth-diary-source.tgz'
tar.exe -czf $bundle scripts backend/src backend/test backend/docs backend/README.md backend/package.json backend/package-lock.json backend/nest-cli.json backend/tsconfig.json backend/tsconfig.test.json
if ($LASTEXITCODE -ne 0) { throw '源码打包失败' }
scp -i '替换为ubuntu.pem的本地完整路径' $bundle ubuntu@1.14.100.191:~/growth-diary-source.tgz
ssh -i '替换为ubuntu.pem的本地完整路径' ubuntu@1.14.100.191
```

服务器 Ubuntu Bash：

```bash
# 每次使用新目录，避免覆盖之前的源码或构建。
SOURCE="$HOME/growth-diary-src-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$SOURCE"
tar -xzf "$HOME/growth-diary-source.tgz" -C "$SOURCE"
cd "$SOURCE"
# 如通过其他工具上传后变为 CRLF，先转换 Bash 文件。
find scripts -type f -name '*.sh' -exec sed -i 's/\r$//' {} +
node --version
npm --version
mysql --version
free -h
df -h / /tmp
sudo systemctl is-active mysql
sudo stat -c '%U %a %n' /etc/growth-diary/database.env
```

应为 Node 22、MySQL 8.4，凭据文件 root 600。`init` 依赖已有数据库准备结果；如果凭据不存在，不要手工覆盖数据库，先核对 [数据库文档](database.md) 及原来的 `scripts/setup-database.sh`。缺少 curl 等系统命令时安装系统包 `curl util-linux`；脚本会在修改服务前检查主要命令。

## 2. 初始化服务和配置（首次执行）

```bash
sudo bash scripts/deploy-backend.sh init
sudoedit /etc/growth-diary/app.env
```

首次从原有 database.env 生成分开的 app.env / migration.env，并生成一次随机 INVITE_CODE_SECRET。重复 init 不覆盖已有配置或更换密钥；如果已有 systemd unit 与模板不同，会停止并要求人工比对。

初始配置使用 `NODE_ENV=development`、`ENABLE_DEV_LOGIN=false`，只监听 `127.0.0.1:3000`。无需真实微信凭据也可验证进程和数据库；业务联调可按 [身份验证文档](auth.md) 配置受控开发登录，但只能通过 SSH 隧道使用。生成开发密钥可用 `openssl rand -hex 32`，保存在服务器配置中，不写入源码。

正式环境应改为 `NODE_ENV=production`，填写自己的 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`，保持 `ENABLE_DEV_LOGIN=false`；INVITE_CODE_SECRET 不要随发布重置。HOST/PORT 保持固定值。配置使用一行一个 `KEY=value`，不要使用 shell 命令、export 或多行值。账号密码特殊字符按 URL 编码。修改数据库密码后需同步相应环境文件，init 不会替你覆盖它们。

服务读取 root-only 环境文件，不需要把 `/etc/growth-diary` 变为可公开读取。不要 `cat` 凭据后把完整输出发到聊天或提交 Git。

## 3. 构建并导入版本

```bash
RELEASE="r$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HOME/growth-diary-builds"
bash scripts/build-backend.sh "$HOME/growth-diary-builds/$RELEASE"
sudo bash scripts/deploy-backend.sh import "$RELEASE" "$HOME/growth-diary-builds/$RELEASE"
```

构建包含 `npm ci`、`npm run check`、`npm prune --omit=dev`；依赖版本取 package-lock.json。构建目录不复制后端 `.env`。请用干净的 ubuntu 登录终端，不要在该终端 export 生产密码。build 脚本拒绝 root、非 Linux 以及覆盖已有目录。构建峰值与常驻内存不同：2GB 主机只同时运行一个构建；失败时先检查 `free -h`、磁盘和日志，必要时在相同架构的 Linux 构建机生成发布目录，不要上传 Windows node_modules。

导入仅复制构建产物、生产依赖与包清单，不复制凭据。ID 必须是新的简单字母/数字版本名；导入失败保留目录供检查，不覆盖同 ID，不自动删除旧版本。只有导入检查成功才生成 IMPORTED 标记。

## 4. 备份并迁移（会停止 API）

```bash
sudo bash scripts/deploy-backend.sh migrate "$RELEASE"
```

操作顺序：校验配置 → 停止并禁用 API 自动启动 → 以本机 root socket 导出数据库并 gzip 校验 → 以独立迁移身份运行 TypeORM → 使用 growth_app 检查业务表和迁移记录。

默认 root socket 认证与此前数据库脚本一致；如果你的 MySQL root 认证已变更，备份会失败并中止迁移，不会把密码放在命令行。不要为跳过报错而删除备份步骤。

迁移结束也不自动启动服务，必须继续 activate。备份或迁移失败，服务保持停止且禁用开机启动。MySQL DDL 可能部分提交，先检查数据库状态，不能把重复运行或执行 migration:revert 当成万能修复。当前两项迁移只支持空表回滚；有业务数据时应前向修复或经核对恢复备份。

## 5. 切换并验收

```bash
sudo bash scripts/deploy-backend.sh activate "$RELEASE"
sudo bash scripts/deploy-backend.sh verify
sudo systemctl status growth-diary --no-pager
sudo journalctl -u growth-diary -n 80 --no-pager
curl --fail http://127.0.0.1:3000/api/v1/health/live
curl --fail http://127.0.0.1:3000/api/v1/health/ready
```

activate 检查目标版本的迁移记录与数据库一致后停止旧进程，原子切换软链接，启动并轮询健康接口。通过后保存 previous 并启用开机启动。单进程会有短暂中断，不是零停机发布。

失败会尝试恢复旧代码；旧版本检查失败时停止并禁用服务，不回滚数据库或配置。只有 live/ready 成功还不够：verify 还检查 MySQL 版本、应用账号对业务表的 SELECT 权限及迁移名称；这些仍不能替代真实业务集成、微信登录、账号写权限和备份恢复验收。

本地另开 PowerShell 窗口建立隧道：

```powershell
ssh -i '替换为ubuntu.pem的本地完整路径' -N -L 13000:127.0.0.1:3000 ubuntu@1.14.100.191
```

保持此窗口开启，再在另一个本地窗口执行：

```powershell
curl.exe --fail http://127.0.0.1:13000/api/v1/health/ready
```

随后按 auth/families/children/entries/admin 文档联调，把 API 地址换为 `http://127.0.0.1:13000/api/v1`。不要开放公网 3000 或 3306，也无需把 HOST 改成 0.0.0.0。

## 6. 后续升级和代码回退

每次把新源码放到新目录，使用新的 RELEASE 重复步骤 3–5。没有表结构变化时，migrate 仍会备份并检查待迁移项，没有待执行迁移就直接结束。

查看版本并回退到明确的旧 ID：

```bash
readlink -f /opt/growth-diary/current
readlink -f /opt/growth-diary/previous
ls -1 /opt/growth-diary/releases
sudo bash scripts/deploy-backend.sh rollback 替换为旧版本ID
sudo bash scripts/deploy-backend.sh verify
```

rollback 与 activate 共用健康检查，只切换代码，使用当前 app.env；不会恢复旧配置、恢复数据库或删除新版本。迁移历史与旧代码不一致时拒绝回退，需先设计兼容性修复。相同迁移名称也不能自动证明未来所有代码行为兼容，发布者仍需检查变更。

所有部署动作使用 flock，避免两个脚本同时操作。旧版本、构建目录及备份不自动清理；40GB 系统盘应定期查看容量，在确认 current/previous 及异机备份后人工处理确切目录。

## 7. 数据备份、恢复和故障定位

独立备份：

```bash
sudo bash scripts/deploy-backend.sh backup
sudo ls -lh /opt/growth-diary/backups
sudo gzip -t /opt/growth-diary/backups/替换为备份文件.sql.gz
```

备份是 growth_diary 数据库逻辑备份，不包含 MySQL 账号、环境配置或未来 COS 对象。gzip 完整性通过不代表 SQL 可恢复；应将备份和受保护的配置另存到异机，并在隔离 MySQL 8.4 实例恢复演练。备份包含用户数据，不得提交 Git。导出使用 `--databases growth_diary`，SQL 带库名，恢复测试必须隔离，不能简单把数据库参数改为 test 就认为安全。生产恢复会覆盖数据，应单独确认恢复点、停写及备份后新增数据的处理方案，本模块不提供自动覆盖生产库的命令。

常用只读排查：

```bash
sudo journalctl -u growth-diary -n 100 --no-pager
sudo systemctl status mysql growth-diary --no-pager
sudo ss -lntp
free -h
df -h / /tmp
sudo du -sh /opt/growth-diary/releases /opt/growth-diary/backups
```

启动限频后，修正问题再 `sudo systemctl reset-failed growth-diary` 并重新 activate。配置错误优先用 sudoedit 检查，不要输出完整环境；数据库检查失败核对账号、MySQL 版本、迁移记录。单独改配置后建议重新 activate 当前 ID，以执行验证和重启；脚本不会保存/回退配置历史，请自行保管旧配置。

## 8. 可选 HTTPS 入口

完成域名、有效证书及公网接入准备后，可复制 `scripts/deploy/nginx.conf.example`，替换域名与证书路径，手动执行 `sudo nginx -t` 后再启用并 reload。不要覆盖现有站点。脚本不申请证书、不设置自动续期，也不更改腾讯云防火墙；这些需要按实际域名另行配置。

模板保留 `/api/v1` 路径并覆盖来自客户端的转发头。当前 Express 不信任代理头，因此登录限流会按 Nginx 的本机 IP 共用额度；公网多用户启用前需完善可信代理配置并验证限流，不能直接改成信任任意代理。模板不支持媒体大文件上传，后续媒体按规划直传 COS。

参考：[systemd-run 官方说明](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml)、[systemd 执行环境](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)、[Nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

## 验证边界

本轮本地执行 Bash 语法检查、两项配置/凭据测试，以及模拟激活成功、失败恢复旧版本、旧版本不兼容、首次启动失败的四条恢复分支。CI 已增加这些检查，不会自动部署服务器。真实 Ubuntu systemd、MySQL 备份/迁移和 Nginx/TLS 未在本机执行；应先完成专用测试库 `npm run test:db`，再按本说明逐项部署验收。
