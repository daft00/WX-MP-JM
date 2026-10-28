# 阶段6：云端自动分包导出

2026-10-24：代码完成，本地验证通过；未部署或创建云资源。依赖阶段5私有COS配置，仍待用户提供并验收。

## 本次交付

- OWNER/ADMIN按宝宝、月/季度/年创建导出；100MiB自动分包，每包独立离线HTML。
- 任务快照、进度、幂等创建、当前权限复核、有限重试、取消与24小时过期清理。
- 独立systemd worker/timer，MySQL全局锁，不引入Redis。流式读写COS，不把ZIP整体加载内存或写入系统盘。
- 小程序记录墙新增导出入口，支持后台任务、刷新进度、逐包下载分享、空间不足提示、取消与人工备份确认。
- 电脑下载页：5分钟二维码、小程序明确授权、15分钟Cookie会话、当前权限校验和短时COS下载地址。

接口、限制及安全边界见 [exports.md](../backend/docs/exports.md)。

## 后续部署步骤（本次未执行）

1. 先完成阶段5测试桶配置和联调。在专用空MySQL8.4测试库安全设置 TEST_MIGRATION_DATABASE_URL，执行 `npm --prefix backend run test:db`。现在共有6项迁移；新增 export_tasks、export_pairings。测试不能指向业务库。
2. 用更新后的 CAM 模板给后端账号增加 `exports/*` 的 GetObject、HeadObject、PutObject、DeleteObject；不扩大客户端上传权限。继续使用私有桶且关闭版本控制。可另设仅 `exports/` 前缀2天生命周期作为遗留对象兜底，不要覆盖 media 原件。
3. 在 `/etc/growth-diary/app.env` 增加 `EXPORT_PUBLIC_ORIGIN=https://api.daftjiang.cn`（无末尾斜线）。留空会禁用电脑配对。不要放密钥到小程序、Git或聊天。
4. 备份并验证恢复，停止媒体和导出timer/service，然后按现有流程构建、导入、迁移、激活；不可跳过此前尚未部署的第三至第五项迁移。
5. 从服务器源码目录安装新任务：

```bash
sudo install -m 644 scripts/deploy/growth-diary-export.service /etc/systemd/system/
sudo install -m 644 scripts/deploy/growth-diary-export.timer /etc/systemd/system/
sudo systemctl daemon-reload
# 主服务激活、健康检查正常后：
sudo systemctl enable --now growth-diary-media.timer growth-diary-export.timer
sudo systemctl status growth-diary-export.timer --no-pager
sudo journalctl -u growth-diary-export.service -n 50 --no-pager
```

两个后台任务随主API停止，后续部署激活后也须显式检查/启动timer。导出任务35分钟超时，单个网络流请求限制5分钟；极慢链路或大年度范围可能需缩小范围。worker故障重试最多3次，不应无限重启失败任务。

6. 保持现有HTTPS/Nginx转发规则。电脑页路径为 `https://api.daftjiang.cn/api/v1/export-browser`；备案仍审核时不要因此开放公网。Cookie要求HTTPS，本机普通HTTP不能完成配对验收。微信downloadFile合法域名需包含COS桶域名。
7. 先用测试家庭验收再更新正式小程序。电脑先打开下载页生成二维码，小程序导出页扫码核对配对码和家庭，确认后电脑点击“刷新导出任务”。无需将小程序accessToken复制给电脑。

## 本地验证与未验证项

本次结果：后端84项（83通过、1项真实MySQL连接检查跳过），前端44项全部通过；发布工具2项通过；导出/记录墙WXML编译与git diff --check通过。新增依赖审计发现body-parser拒绝服务漏洞，已更新兼容版本2.4.0，复查0项漏洞。

已验证：后端构建、分包精确大小及HTML转义、快照规范化比较、流式生成、权限撤销/取消/过期、全局锁与重试、配对一次性/期限/Origin检查；前端创建重试、下载大小/域名/家庭切换检查及已有功能回归。COS SDK和流式读取使用真实本机HTTP替身运行，未使用真实凭据。Postman CLI当前不可调用，沿用阶段5 Node HTTP替身和模拟配置，不声称经过Postman编排运行。

真实MySQL集成测试已编译但未执行；其中增加并发幂等、一家庭一任务、MySQL JSON快照、worker生成及取消清理用例。Ubuntu systemd、真实COS、真实微信扫码/分享和桌面浏览器完整配对尚未验收。

人工验收至少包含：

1. 文字、指标、照片、视频混合跨月数据，足够产生多包；下载全部包，解压并离线查看，确认总素材数量一致且无重复遗漏。
2. 生成期间编辑/删除记录，应失败要求重建；断开COS、重启worker，不能发布不完整包，最多3次尝试。
3. 创建者降级/移出家庭，停止生成和新下载签发；普通成员不能导出。浏览器授权过期、配对重复确认、错误Origin均拒绝。
4. 取消或24小时过期后实际对象删除，原媒体保留；COS删除失败保持待清理状态。
5. iOS/Android逐包分享、空间不足与电脑下载；Cookie Secure/HttpOnly/SameSite、5分钟二维码和15分钟浏览器会话按预期过期。

已签发5分钟下载地址和已下载文件无法即时撤回；人工备份确认不能证明第三方网盘保存成功。当前任务上限见接口文档，超出应缩短时间范围。
