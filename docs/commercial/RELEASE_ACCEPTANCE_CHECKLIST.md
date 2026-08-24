# AI锦衣卫商业发布验收清单

## 服务端

- [ ] 新客户通过 `npm run provision:organization` 创建独立组织和老板账号。
- [ ] `NODE_ENV=production`、强 `ADMIN_PASSWORD`、强 `AGENT_SESSION_SECRET`、明确 `AGENT_CORS_ORIGIN`。
- [ ] `npm run preflight:production` 通过，且数据库和备份目录位于持久化绝对路径。
- [ ] `AGENT_ALLOW_BOOTSTRAP_TOKEN=false`，生产请求只使用账号会话。
- [ ] HTTPS、DNS、防火墙、反向代理和只开放 443 已验收。
- [ ] `npm run backup:rotate` 成功，`npm run restore-check` 成功，恢复演练有记录。
- [ ] `/health/live`、`/health/ready`、诊断脚本和监控告警已接入。
- [ ] 员工告知、DPA、留存期限和事件联系人已签字确认。

## Agent/MSI

- [ ] `agent/package.json`、`package-lock.json`、`src-tauri/Cargo.toml` 和 `tauri.conf.json` 版本一致。
- [ ] `vX.Y.Z` tag 与 Agent 版本一致，Windows MSI 构建成功并使用代码签名证书。
- [ ] Release 中的 `release-manifest.json` 与 MSI SHA-256 一致，签名状态为 `Valid`。
- [ ] 在干净 Windows 10/11 安装、注册、开机启动、卸载和升级成功。
- [ ] 升级保留设备凭据和未上传队列；回滚使用上一份签名 MSI，且未手工删除 SQLite。
- [ ] 卸载前通过 Agent 的“清除本机数据”完成显式清理，清理结果和服务端设备停用均有记录。
- [ ] 断网缓存、恢复补传、重复事件幂等、磁盘不可写和队列上限有结果记录。
- [ ] 请求中没有键盘、剪贴板、截图、正文、原始窗口标题或完整 URL。
- [ ] Windows 防火墙、代理、杀毒软件和企业软件分发策略已验收。

## 权限与数据

- [ ] 老板、高管、员工账号均使用真实登录，前端不能切换身份。
- [ ] 高管只能看到直属团队，员工只能看到本人，跨组织访问返回 403/404。
- [ ] MFA、账号停用、会话撤销、注册码一次性使用已验证。
- [ ] 审计导出、哈希链校验、隐私导出/删除和留存删除有审计记录。
- [ ] AI 预算、调用量、失败告警和人工摘要质量抽检已配置。
