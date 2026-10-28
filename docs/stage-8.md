# 阶段8：运维工具与发布验收

更新：2026-10-26。代码已实现，尚未部署或正式发布。阶段7的剩余界面与真实环境验收仍待完成。用户已明确不做内容审核、申诉和注销账号；记录删除与解散家庭执行代码已补齐，见阶段7说明，不能将代码完成当成实际部署。

## 本次代码

| 工具 | 行为 |
| --- | --- |
| `scripts/ops/backup.py backup` | MySQL一致性快照 → gzip → GPG公钥加密 → SSH传到异机；流水线任一环节失败即失败，不落地明文SQL |
| `backup.py receive` | 异机接收、核对SHA256、原子替换、返回回执；双方保留最近7个有备份的日和4个ISO周各一份，重合的文件复用 |
| `backup.py restore` | 仅接受指定前缀的空隔离库；账号只能有该库权限；解密导入并检查家庭、宝宝、记录、媒体引用的关系及数量 |
| `scripts/ops/monitor.py` | 磁盘、备份时效、服务、live/ready、MySQL连接、worker状态/近期错误、失败任务、TLS证书、最近5分钟5xx；输出脱敏JSON |
| `scripts/release-readiness.cjs` | 域名校验、干净工作区、版本绑定、近期验收证据及一周体验验证；不满足返回退出码1，不执行上传或发布 |

备份和监控各有独立systemd timer，不随API停止而停止。备份与现有部署脚本共用迁移锁；同一时间手工执行DDL或绕过部署脚本的迁移仍会破坏一致性，维护时禁止这样操作。

`project.config.json` 已开启 `urlCheck`。SSH隧道联调如需关闭，只在开发者工具的本地私有配置临时设置；发布检查会拒绝本地覆盖的关闭状态。未改变线上配置。

## 1. 先准备配置，不立即启用定时任务

以下操作由维护者在Ubuntu环境逐项确认执行，不是本次已经执行的记录。

- 需要Python3、MySQL8.4客户端、GnuPG、gzip、OpenSSH、curl及systemd。先确认现有命令版本；脚本不自动安装或升级系统软件。
- 异机必须是与生产服务器不同的可信机器，并有足够空间。建议使用已有电脑/NAS/备份机；本代码没有购买任何服务。
- 生产机只存GPG**公钥**；私钥及其口令放在受保护的离线/恢复机器，另留可恢复副本。丢失私钥会使备份无法恢复。
- 在恢复机用 `gpg --full-generate-key` 创建具有加密子密钥的密钥，核对完整fingerprint；通过可信途径导出并传递公钥。不要把私钥传到生产机或Git。
- SSH使用专用账号/密钥和 `growth-backup` alias，人工核对并固定远端host key。不要关闭host key校验；默认不使用交互密码。备份账号仅能访问专用备份目录和接收脚本。
- SSH方式不是不可变备份：生产机或备份账号被攻破仍可能损坏备份。要抵御该风险，另设不可变存储或离线副本。

生产机安装代码（先核实目录不存在旧版本，避免覆盖正在使用的配置）：

```bash
sudo install -d -m 0755 /opt/growth-diary-ops
sudo install -m 0644 scripts/ops/backup.py scripts/ops/monitor.py /opt/growth-diary-ops/
sudo install -d -m 0700 /opt/growth-diary/encrypted-backups /var/lib/growth-diary-ops
sudo install -d -m 0700 /etc/growth-diary/backup-public-keyring
```

将 `backup.example.json`、`monitor.example.json` 手工复制为 `/etc/growth-diary/backup.json`、`monitor.json`（root:root、0600）；不要覆盖已有配置。填实际远端路径、已核实公钥fingerprint等。

导入**公钥**：

```bash
sudo gpg --homedir /etc/growth-diary/backup-public-keyring --import /absolute/path/backup-public.asc
sudo gpg --homedir /etc/growth-diary/backup-public-keyring --fingerprint
```

本部署已使用MySQL本机root socket认证，可将 `/etc/growth-diary/backup.cnf` 配置为以下内容（root所有、0600）。不复制运行账号的密码到命令行：

```ini
[client]
user=root
protocol=SOCKET
```

此账号仅由root备份进程使用，不赋予Web运行账号备份权限。工具拒绝非InnoDB表、视图、trigger、routine和event；当前项目没有这些对象，后续若新增必须先扩展备份与恢复验证。

监控另用仅SELECT权限的专用MySQL账号，写入 `/etc/growth-diary/monitor.cnf`，权限0600。其内容类似现有app.cnf，但使用专用账号；数据库为 `growth_diary`。不需要赋予写入、FILE或管理权限。真实MySQL权限需现场验证。

远端安装同版本 `backup.py` 到 `remote_script` 指定位置（目录/脚本由管理员管理），为专用备份账号创建 `remote_dir`，归该账号、0700。远端不需要MySQL、GPG私钥或生产密码。接收端执行Python3，通过标准输入读取密文。

## 2. 首次备份、保留策略及恢复演练

先手动运行：

```bash
sudo python3 /opt/growth-diary-ops/backup.py backup --config /etc/growth-diary/backup.json
sudo cat /opt/growth-diary/encrypted-backups/last-success.json
```

只有远端SHA256校验回执匹配才更新 `last-success.json` 并清理本地旧备份。失败保留旧备份和旧成功记录；已完成的本地密文保留供排查。不要把失败产生的文件误认为已异机备份。

“7日+4周”按UTC文件时间保留；每天同一天多次运行通常保留最后一份，不是保留任意最近7个文件。日期相同且秒级碰撞时可能临时多留一份。积累不足4周时不会凭空生成历史周备份。传输/进程被强制终止可能遗留 `.partial`；确认无备份运行后人工清理，脚本不通配删除未知文件。远端空间也需纳入远端主机监控。

恢复演练应在**独立测试MySQL实例**进行；不要将恢复库接入正式API/worker，以免恢复后的任务处理生产COS对象。

1. 从**远端**取回密文，比对回执的SHA256。在恢复机验证私钥可解锁，必要时通过gpg-agent交互解锁，不在命令行传口令。
2. DBA创建全新空库，例如 `growth_diary_restore_20261026_aabbccdd`，创建全新专用账号，**仅**授予该精确数据库的权限。禁止全局权限、角色、其他库权限、GRANT OPTION及使用root执行导入。账号不存在时才创建，不修改既有生产账号。
3. 私有 `restore.cnf` 指定测试实例和该账号，0600、归执行者所有。默认数据库也应为测试库。
4. 运行：

```bash
python3 /opt/growth-diary-ops/backup.py restore \
  --archive /absolute/path/from-offsite.sql.gz.gpg \
  --mysql-defaults /absolute/path/restore.cnf \
  --gpg-home /absolute/path/private-keyring \
  --database growth_diary_restore_20261026_aabbccdd
```

5. 保存脱敏结果与耗时，确认家庭/宝宝/记录/媒体数量与已知业务相符、迁移历史与备份版本对应。脚本检查主要关系和非空对象键，但不是对所有业务规则的完整证明。
6. 通过受控只读方式抽检实际COS对象与预览文件可读取；**SQL备份不含照片/视频二进制文件**，需另外确认COS灾难恢复策略。不要给测试API生产写权限。
7. 记录备份时间、恢复时间及缺失范围。目标RPO≤24小时、争取RTO≤4小时，演练之前不得宣称达标。完成后由DBA核对隔离库及账号再清理；工具不自动DROP。

失败可能已写入部分测试表，保留现场。修复原因后重新创建全新空库，不能重试覆盖非空库。旧部署脚本产生的 `--databases` 明文压缩备份不属于本工具的安全恢复格式；不要直接送入此恢复命令。

首次备份、异机读取和恢复演练都通过后再启用：

```bash
sudo install -m 0644 scripts/ops/growth-diary-backup.service scripts/ops/growth-diary-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now growth-diary-backup.timer
sudo systemctl list-timers growth-diary-backup.timer
```

每天北京时间03:00执行，停机漏跑后补跑。24小时未收到成功异机回执会告警；备份延迟或失败可能使实际RPO超标。

## 3. 巡检、日志与通知

Nginx只新增脱敏运维日志，参考 `scripts/ops/nginx-ops-http.conf.example`：在http块定义format，在现有HTTPS server启用相应access_log，不覆盖现有反代或证书配置。先 `sudo nginx -t`，成功再reload。日志仅含时间、状态码、耗时，不含IP、URI、请求体、Cookie或token。

确认Ubuntu现有 `/etc/logrotate.d/nginx` 的通配规则覆盖 `growth-diary-ops.log`，设置容量/日轮转与保留期限并验证，不重复创建竞争的轮转规则。巡检读取当前文件及 `.1` 的尾部，单文件最多1MiB；超过窗口采样上限会报错，不伪造低错误率。若平台轮转立即压缩 `.1`，需使用delaycompress以保留轮转交界窗口。没有业务流量不算接口故障，live/ready会独立请求验证。

默认阈值：磁盘80%或剩余不足2GiB、连接数80%、5分钟5次5xx、证书剩余不足30天、备份24小时、媒体worker5分钟未触发、导出worker40分钟未触发、删除worker25分钟未触发。失败媒体/导出近24小时、待删除对象超过24小时、删除申请处理超过24小时或清理错误会提示复核，不自动删除/重跑业务。

`monitor.json` 的 `alert_command` 必须填写可信通知程序的绝对路径（执行者所有、其他人不可写、非符号链接），接收标准输入JSON。可使用已有告警系统；`notify.example.sh` 是接受该JSON格式的HTTPS接收端模板，真实URL和认证仅写root所有0600的 `/etc/growth-diary/alert-curl.conf`。它不是适配所有微信/邮件厂商的通用格式；选好渠道后按其接口适配。

通知在状态变化或恢复时发送，持续异常每小时重报。未配置、非零退出或超时均记为失败并下轮重试。要实际收到一次测试告警和一次恢复通知，不能仅凭脚本exit 0认定送达。主机整体宕机时本机脚本不能发通知，须在异机/云控制台配置主机不可用告警或外部心跳监控。

云费用不从家庭配额估算。到腾讯云控制台对CVM/轻量服务器、COS存储/请求/外网流量及CI处理设置预算与余额告警、实际接收人并测试。脚本不创建付费服务，也未调用账单API。确认后在 `/etc/growth-diary/billing-review.json`（0600）记录真实时间：

```json
{"budget_alerts_verified":true,"checked_at":"实际检查时刻的ISO8601时间，含时区"}
```

超过7天提示重新检查；这只表示人工核验时效，**不表示实时云账单未超预算**。

手工检查并确认通知成功后再安装monitor service/timer：

```bash
sudo python3 /opt/growth-diary-ops/monitor.py --config /etc/growth-diary/monitor.json
sudo install -m 0644 scripts/ops/growth-diary-monitor.service scripts/ops/growth-diary-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now growth-diary-monitor.timer
sudo journalctl -u growth-diary-monitor.service -n 20 --no-pager
sudo cat /var/lib/growth-diary-ops/monitor.json
```

每5分钟检查。证书检查使用127.0.0.1连接、正确SNI及系统信任验证，适用于当前仅本机HTTPS状态；**不验证公网连通性，也不会自动续期**。手动DNS证书仍须按阶段2转换自动续期、dry-run及reload验收。

## 4. 体验版与发布门槛

先完成阶段7和各阶段真实环境验收。两个家庭、三个真实账号、至少iOS/Android各一台；验证登录/邀请/越权、跨设备发布/读取、上传取消重试/配额、导出所有分包、离线浏览、权限撤销、退出与数据申请等。

邀请少量亲友体验至少一周，记录日期、版本、脱敏问题和修复结果。核实微信后台主体/类目/备案/隐私/合法域名，准备真实审核截图和受控邀请流程。不得为审核打开开发登录或公开提升权限。

复制 `docs/release-evidence.example.json` 为不入Git的 `release-evidence.local.json`，逐项填写真实验收时间和报告位置。`release_commit` 对应待发布提交；最终源码应干净，阶段验收证据及体验结束时间不超过14天。源码变更后重新确认受影响验收，禁止为了过检查直接填true。

```bash
npm run check
npm --prefix backend run check
python3 -m unittest discover -s scripts/ops -p 'test_*.py'
npm run release:check -- release-evidence.local.json
```

目前用模板运行**应当被阻断**。检查只是本地配置+人工证据门槛，既不自动验证政府/微信后台状态，也不替代人工审核，不上传/提交/发布。审核通过后小范围发布，观察错误和费用后逐步扩大。

每月及发布前检查系统/Node.js/依赖安全更新；`npm audit` 必须在前后端分别运行并评估，不能无审阅执行自动升级。CI仍只在PR触发，不恢复push触发。

## 验证边界

本地自动化覆盖保留策略、损坏备份、传输失败、流水线上游失败、恢复权限/非空拒绝、备份时效、5xx窗口、通知重试/恢复、发布阻断。未在本机执行真实MySQL恢复、GPG密钥加解密、SSH异机传输或Ubuntu systemd。未配置通知/云预算、未验证公网或真机、未部署或Git提交。
