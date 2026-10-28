# 阶段5：私有COS、上传复核与配额

2026-10-24：代码和本地检查完成，未部署，未创建付费资源。COS信息由用户后续提供。阶段6云端导出不包含在本次改动内。

已接入小程序上传进度、失败继续/取消、私有图片和视频读取、家庭配额显示；后端实现短时单对象表单、异步复核、派生图、配额预留结算、删除重试和24小时未关联素材回收。接口见 [media.md](../backend/docs/media.md)。

## 配置准备

1. 创建与服务器同地域的私有 COS 桶，测试桶与生产桶独立。记录完整桶名（含 APPID 后缀）和地域代码。不启用公有读写、静态网站或公开 CDN。
2. 当前计费占用模型要求桶关闭版本控制；开启版本控制时 DeleteObject 可能仅创建删除标记，不能据此认为实际空间释放。不要让其他应用写入本项目 `tmp/`、`media/` 前缀。
3. 配置生命周期中“终止未完成分块上传”，例如1天。当前客户端只允许单次 POST，不签发分块权限，也不产生分块上传；生命周期负责历史/外部残留分片。不要为已关联 `media/` 原件设置自动过期删除规则。
4. 开通该桶的数据万象图片处理、媒体处理能力，用于 imageInfo、videoinfo、缩略图和视频截图。开通与处理可能产生费用，先确认控制台当前计费与地域支持。服务器不做视频转码。
5. 创建专用 CAM 子账号 API 密钥，参考 [权限模板](../scripts/deploy/cos-policy.example.json)，替换所有占位符后核对。后端需要指定桶对象读写删除以及对应数据万象操作；临时会话策略再缩小为单个 tmp 对象的 PostObject。不要授予主账号密钥或 COS 全管理权限。
6. 将真实值仅填入服务器 `/etc/growth-diary/app.env`；不要发到聊天或提交 Git。增加 `MEDIA_ENABLED=true`、`COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY`。默认 false 可先部署文字功能。API 和媒体worker使用同一份受保护配置。
7. 微信后台配置 API request 合法域名及桶 HTTPS 的 uploadFile、downloadFile 合法域名；图片/视频域名也需按微信当前规则检查。保持备案期间现有监听限制，公网开放另行确认。

## 部署顺序（后续确认实施）

1. 在专用空 MySQL 8.4 测试库安全设置 `TEST_MIGRATION_DATABASE_URL`，运行 `npm --prefix backend run test:db`。应覆盖全部5项迁移以及真实并发配额/幂等/回收测试；不得指向业务库。
2. 使用现有构建、导入、备份、迁移、激活流程；第五项迁移新增 family_storage、media_uploads。若生产仍在早期版本，也会执行尚未应用的第三、第四项迁移。先备份并完成恢复演练。
3. 迁移/切换前停止媒体timer及service，避免旧worker跨发布运行。安装新模板后执行 daemon-reload；主服务激活成功后显式启动timer。PartOf 会使它们随主服务停止；后续激活后也要检查并重新启动timer。

以下在服务器源码根目录执行，仅安装已审阅的任务模板：

```bash
sudo systemctl stop growth-diary-media.timer growth-diary-media.service
# 首次安装尚无上述unit时会提示不存在；确认是首次安装后继续。
sudo install -m 644 scripts/deploy/growth-diary-media.service /etc/systemd/system/
sudo install -m 644 scripts/deploy/growth-diary-media.timer /etc/systemd/system/
sudo systemctl daemon-reload
# 完成已有流程的迁移、激活和健康检查后：
sudo systemctl enable --now growth-diary-media.timer
sudo systemctl status growth-diary-media.timer --no-pager
sudo journalctl -u growth-diary-media.service -n 50 --no-pager
```

4. 先用测试桶与测试家庭验收：图片/视频上传→READY→发布→记录墙/详情；双账号读访问、成员移除；断网恢复、大小/类型拒绝、配额不足、取消/删除重试、超过1小时临时清理与24小时未关联清理。验证无签名链接不能读取对象。
5. 验证真实对象删除后再观察配额释放；故障期间占用保留是预期。私有链接过期后在详情刷新。完成微信 iOS/Android 真机测试后再发布。

## 本地验证结果与复现

- 后端构建及75项测试：74通过，1项未配置真实 MySQL 连接而跳过。含真实 Nest HTTP 边界、真实 COS/STS SDK 发往本机替身的 HTTP 测试。
- 前端类型检查及41项测试通过；上传重试、局部成功草稿、身份切换与目标域名校验已覆盖。
- 发布工具2项测试通过；发布、记录墙、详情 WXML 编译通过。依赖审计0项漏洞（检查时结果）。
- 真实 MySQL 集成测试源已编译，未实际执行；未做真实 COS/STS/数据万象、Ubuntu timer 或微信真机验收。

本机两个独立终端从仓库根目录启动替身：

```powershell
$env:PORT='14901'; node postman/mocks/cos/default.js
# 另一个终端：
$env:PORT='14902'; node postman/mocks/growth-read/default.js
```

测试终端：

```powershell
$env:COS_SIM_URL='http://127.0.0.1:14901/cos'
npm --prefix backend run check
$env:GROWTH_SIM_URL='http://127.0.0.1:14902/api/v1'
npm run check
```

当前环境无可调用 Postman CLI，直接运行同一 mock 的 Node HTTP 服务；未声称通过 Postman 编排器验证。模拟环境不使用真实密钥；不配置模拟URL时相应用例会跳过。发布构建脚本清除模拟变量。

参考：[POST Object](https://cloud.tencent.com/document/api/436/14690)、[临时密钥](https://cloud.tencent.com/document/product/436/14048)、[图片信息](https://cloud.tencent.com/document/product/436/113308)、[视频截图](https://cloud.tencent.com/document/product/460/49283)。
