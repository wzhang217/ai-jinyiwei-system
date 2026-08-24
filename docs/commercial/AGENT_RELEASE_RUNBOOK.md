# AI锦衣卫 Agent MSI 发布、升级、回滚与卸载手册

本文用于客户交付和售后，不替代 Windows 管理员的变更审批。正式版本必须使用签名 MSI；分支构建只用于测试，不得直接交付客户。

## 1. 发布前检查

1. 在 `agent/package.json`、`agent/package-lock.json`、`agent/src-tauri/Cargo.toml`、`agent/src-tauri/tauri.conf.json` 和 `agent/src-tauri/src/main.rs` 中保持同一个版本号。
2. 创建版本提交和标签，例如 `v0.1.15`。GitHub Actions 会拒绝标签版本与 Agent 版本不一致的构建。
3. 正式标签构建必须配置 `WINDOWS_SIGNING_PFX_BASE64` 和 `WINDOWS_SIGNING_PFX_PASSWORD`。工作流会验证 MSI 的 Authenticode 签名，并上传 `release-manifest.json`。
4. 从 Release 同时下载 MSI 和 manifest；不要只下载没有 SHA-256 记录的安装包。

## 2. 在 Windows 上验证交付包

在 PowerShell 中执行，替换文件名：

```powershell
$msi = .\ai-jinyiwei-agent_0.1.15_x64_en-US.msi
$manifest = Get-Content .\release-manifest.json | ConvertFrom-Json
Get-FileHash $msi -Algorithm SHA256
(Get-AuthenticodeSignature $msi).Status
```

结果必须满足：SHA-256 与 manifest 中对应文件一致，签名状态为 `Valid`。签名无效或 manifest 不匹配时停止交付。

## 3. 首次安装

```powershell
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @('/i', $msi, '/norestart')
```

安装后启动 Agent，输入服务地址和管理员生成的一次性注册码。验收以下项目：

- Agent 出现在托盘，版本号与交付版本一致；
- 注册成功后心跳进入在线状态；
- 员工确认隐私策略后才开始产生事件；
- 切换两个应用后，服务端能看到持续时间和 checkpoint 更新；
- 关闭服务端时进入离线队列，恢复后队列归零且事件不重复。

## 4. 升级

升级前保留当前 MSI、manifest 和当前版本的诊断记录。直接安装新 MSI，不要删除 `agent.sqlite` 或 Windows 凭据存储中的设备密钥：

```powershell
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @('/i', .\ai-jinyiwei-agent_0.1.15_x64_en-US.msi, '/norestart')
```

升级后检查 Agent 版本、设备 Token、离线队列、最近心跳和开机启动项。正常升级应保留注册信息和未上传队列。

## 5. 回滚

回滚只使用上一份已签名且 manifest 校验通过的 MSI。先记录当前版本和诊断信息，再停止 Agent，安装上一版本并启动：

```powershell
Stop-Process -Name 'ai-jinyiwei-agent' -Force -ErrorAction SilentlyContinue
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @('/i', .\ai-jinyiwei-agent_0.1.13_x64_en-US.msi, '/norestart')
```

回滚后确认注册状态、队列和心跳。若新版本改变了本地数据库结构，必须使用该版本明确支持的迁移路径；不要手工复制或删除 SQLite 文件。

### 可执行升级脚本

管理员可以在 PowerShell 中使用仓库内的 `agent/scripts/Upgrade-Agent.ps1`。脚本要求 MSI 具有有效 Authenticode 签名；指定 manifest 中的 SHA-256 可在安装前阻止文件被替换：

```powershell
.\Upgrade-Agent.ps1 `
  -MsiPath .\ai-jinyiwei-agent_0.1.15_x64_en-US.msi `
  -ExpectedSha256 "<manifest 中的 SHA-256>" `
  -RollbackMsiPath .\ai-jinyiwei-agent_0.1.14_x64_en-US.msi
```

只校验而不安装时加 `-VerifyOnly`。脚本不负责从互联网下载 MSI；企业软件分发系统应负责下载、审批和投放已签名产物。

## 6. 员工离职、设备转交与卸载

卸载不是删除服务端历史的替代操作，按以下顺序执行：

1. 老板或高管在后台停用设备/账号，必要时轮换 JWT 密钥并停用未使用注册码。
2. 员工在 Agent 中打开“解除绑定并清除本机数据”，确认离线队列为 0，并确认状态回到“未注册”。该操作删除本机 SQLite 队列、设备 Token、注册信息和本地加密队列密钥，但不删除服务端历史。
3. 在 Windows“应用和功能”中卸载，或由管理员执行：

```powershell
$entry = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object DisplayName -eq 'AI锦衣卫 Agent' | Select-Object -First 1
if (-not $entry) { throw '未找到 AI锦衣卫 Agent 的 MSI 安装项' }
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @('/x', $entry.PSChildName, '/norestart')
```

4. 重新登录该 Windows 用户，确认 Agent 不再出现在启动项；若客户要求彻底清理，保留卸载日志和清理确认记录，不要在未审批时删除服务端历史或备份。

## 7. 目前的发布边界

- 当前发布方式是 GitHub Release + 签名 MSI；`release-manifest.json` 还会提供正式 tag 的下载地址，可交给企业软件分发系统作为升级目录。Agent **尚未启用静默自动更新**，客户环境需要通过企业软件分发或管理员手动执行升级。
- MSI 卸载默认不主动删除活动数据，避免误删未上传队列；清理动作必须先由 Agent 界面显式确认。
- 生产交付前必须在干净 Windows 10/11 完成首次安装、升级、回滚、卸载和断网恢复，并把结果附在 `RELEASE_ACCEPTANCE_CHECKLIST.md` 中。
