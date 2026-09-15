# 以后台服务运行

简体中文 · [English](../SERVICE.md)

在 Agent 主机上，建议每个系统用户只运行**一个长期存活的 provider**，再让
兼容的 OpenAI/Anthropic 客户端、OpenCode、Zuno，以及 Codex/Claude Code
兼容性探针都连接这个本机端点。不要为每个
Agent 或每段会话分别启动 provider。单一常驻进程可以让带显式亲和键的请求
复用已持久化的账号/Kiro conversation 绑定，同时让所有请求复用进程内按账号
划分的 SDK 客户端与 transport 对象。没有显式键的请求首轮会创建新的 Kiro
conversation，后续完整历史可通过精确 assistant 输出 lineage 找回同一绑定。
Kiro 模型调用 socket 默认新建（`sdk_http_keep_alive: false`）；即使显式
开启 keep-alive，也只是尽可能优化传输，不代表一个会话独占一条物理 TCP
连接。默认 `enforce_single_instance: true` 还会阻止第二个服务进程拆分
进程内队列和池。

常驻部署建议使用固定版本的独立二进制，不要在每次启动时通过 `bunx` 临时
拉取。以下示例采用发布安装脚本的默认路径：

- Linux 二进制：`~/.local/bin/kiro-provider`；
- Windows 二进制：`%USERPROFILE%\.local\bin\kiro-provider.exe`；
- 配置文件：Linux 为 `~/.config/kiro-provider/config.json`，Windows 为
  `%APPDATA%\kiro-provider\config.json`；
- 服务/任务名称：`kiro-provider`。

一次性导入与常驻服务应由**同一个系统用户**执行，使服务读取同一份
`~/.config/kiro-provider/accounts.db`、配置、密钥环和实例锁。改成 `root`、
`LocalSystem` 或其他用户通常会选择另一套本地存储。服务定义中应使用绝对
路径；API Key 保存在受保护的配置文件中，不要写进服务参数。导入完成后不会
再次读取 OpenCode 数据库。

## Linux：systemd 用户服务

先检查二进制与配置文件：

```bash
test -x "$HOME/.local/bin/kiro-provider"
test -r "$HOME/.config/kiro-provider/config.json"
chmod 600 "$HOME/.config/kiro-provider/config.json"
```

安装一个 [systemd 用户服务](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)：

```bash
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 700 "$SERVICE_DIR"
cat > "$SERVICE_DIR/kiro-provider.service" <<'EOF'
[Unit]
Description=kiro-provider local Kiro gateway

[Service]
Type=exec
ExecStart=%h/.local/bin/kiro-provider serve --config %h/.config/kiro-provider/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 600 "$SERVICE_DIR/kiro-provider.service"

systemctl --user daemon-reload
systemctl --user enable --now kiro-provider.service
```

如果二进制或配置不在上述位置，请把 `ExecStart` 改为对应的绝对路径。使用
自定义 `XDG_CONFIG_HOME` 时，还应加入
`Environment=XDG_CONFIG_HOME=/absolute/path`。

日常操作与日志查看：

```bash
systemctl --user is-active kiro-provider.service
systemctl --user restart kiro-provider.service
journalctl --user -u kiro-provider.service -n 100 --no-pager
```

用户服务通常随该用户的 service manager 启动。如果要求系统启动时就运行，
并且用户退出登录后仍保持常驻，可让管理员在确认机器安全策略后执行
`loginctl enable-linger <user>`。

移除服务：

```bash
systemctl --user disable --now kiro-provider.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kiro-provider.service"
systemctl --user daemon-reload
```

## Windows：当前用户计划任务

`kiro-provider.exe` 是普通前台程序，并没有实现原生 Windows Service Control
Manager 接口，因此不要直接用 `sc.exe` 注册。无需第三方依赖的内置方案，是
创建一个[计划任务](https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask)：
当前用户登录时启动，进程失败后自动重启。

请使用拥有 provider 本地认证库与配置的同一用户打开 PowerShell，执行以下
命令。它会创建一个小型启动脚本，并把 stdout/stderr 保存在
`%LOCALAPPDATA%\kiro-provider`：

```powershell
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
$ServiceDir = Join-Path $env:APPDATA "kiro-provider"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Launcher = Join-Path $ServiceDir "service.ps1"

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
  throw "kiro-provider binary not found: $Binary"
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
  throw "kiro-provider config not found: $Config"
}

New-Item -ItemType Directory -Force -Path $ServiceDir, $LogDir | Out-Null
@'
$ErrorActionPreference = "Stop"
$Binary = Join-Path $HOME ".local\bin\kiro-provider.exe"
$Config = Join-Path $env:APPDATA "kiro-provider\config.json"
$LogDir = Join-Path $env:LOCALAPPDATA "kiro-provider"
$Log = Join-Path $LogDir "service.log"
$PreviousLog = Join-Path $LogDir "service.previous.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if ((Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 10MB)) {
  Move-Item -Force -LiteralPath $Log -Destination $PreviousLog
}

& $Binary serve --config $Config *>> $Log
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $Launcher -Encoding UTF8

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$PowerShell = (Get-Command powershell.exe).Source
$Action = New-ScheduledTaskAction `
  -Execute $PowerShell `
  -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $Launcher)
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Principal = New-ScheduledTaskPrincipal `
  -UserId $User `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Register-ScheduledTask `
  -TaskName "kiro-provider" `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Local AWS Kiro gateway for AI agents" `
  -Force | Out-Null
Start-ScheduledTask -TaskName "kiro-provider"
```

查看状态、重启和跟踪日志：

```powershell
Get-ScheduledTask -TaskName "kiro-provider" | Get-ScheduledTaskInfo
Stop-ScheduledTask -TaskName "kiro-provider"
Start-ScheduledTask -TaskName "kiro-provider"
Get-Content "$env:LOCALAPPDATA\kiro-provider\service.log" -Tail 100 -Wait
```

移除任务与启动脚本：

```powershell
Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "kiro-provider" -Confirm:$false
Remove-Item "$env:APPDATA\kiro-provider\service.ps1"
```

这个任务有意只在当前用户的交互式会话中运行，因此无需保存 Windows 密码，
并可直接使用该用户的网络权限、provider 数据库与密钥环。如果必须在用户
登录前运行，则需要 Windows 服务包装器和一个经过明确配置的用户账号；不要
让 `LocalSystem` 运行后仍假设它能读取原用户的 provider 文件。

## 升级服务二进制

在改动运行中的服务前，先确认已发布的版本：

```bash
kiro-provider --version --check
kiro-provider self-update --check
```

`self-update` 会先用对应 Release 的 `SHA256SUMS` 校验资产摘要，通过后才原地替换已安装的
二进制。摘要不匹配时不写入任何内容；替换会保留原有权限位，并把下载暂存在安装目录内，
使替换是同一文件系统上的 rename。它不会改动配置、账号库或单元文件，也不会重启任何服务。

由于运行中的进程持有自己已打开的镜像，重启之前服务仍在运行旧版本：

```bash
kiro-provider self-update --yes
systemctl --user restart kiro-provider.service
kiro-provider --version
```

Windows 计划任务：

```powershell
kiro-provider self-update --yes
Stop-ScheduledTask -TaskName "kiro-provider"
Start-ScheduledTask -TaskName "kiro-provider"
```

Windows 上如果旧镜像被占用，会先将其移到一旁，替换失败时回滚，因此尽量先停止任务。

固定版本的服务请传入与 `KIRO_PROVIDER_VERSION` 相同的版本
（`self-update --tag 3.3.1 --yes`），而不是跟随最新 Release。`--tag` 是明确指令而非建议：
指定更旧的版本即为回退。要重装当前版本请加 `--force`。

## 健康检查与自动化契约

安装任一服务后，都应同时检查进程存活状态和需鉴权的就绪状态：

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H 'Authorization: Bearer sk-your-private-key'
```

对应的 PowerShell 命令：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
$Headers = @{ Authorization = "Bearer sk-your-private-key" }
Invoke-RestMethod "http://127.0.0.1:8787/ready" -Headers $Headers
```

AI Agent 或安装器只有在以下条件全部满足后，才能认为配置成功：

1. 二进制和显式配置路径都存在；
2. 服务/任务由拥有凭证的用户运行；
3. `/health` 调用成功；
4. 带鉴权的 `/ready` 调用成功，证明认证源可读、至少有一个活跃账号、
   Provider 状态可写、reasoning 密钥环可用，且所有未过期回放记录引用的 key
   ID 都已覆盖。

固定使用上面的服务/任务名称，可以让重复配置保持幂等。配置或二进制更新后
应重启服务。不要让客户端负责启动一份私有 provider 进程；客户端只需要配置
稳定的 base URL 与网关 API Key。

## 相关文档

- [配置参考](CONFIGURATION.zh-CN.md)
- [排障手册](TROUBLESHOOTING.zh-CN.md)
- [仓库文档索引](../README.md)
