# Running as a background service

[简体中文](readme/SERVICE.zh-CN.md) · English

For an agent host, run **one long-lived provider per OS user** and point
compatible OpenAI/Anthropic clients, OpenCode, Zuno, and compatibility probes
for Codex or Claude Code at that local endpoint.
Do not start a new provider for every agent or conversation. Keeping one
process alive lets requests with an explicit affinity key reuse their
persisted account/Kiro-conversation binding, while all requests can reuse
process-local, account-scoped SDK clients and transport objects. A request
without an explicit key starts a fresh Kiro conversation on its first turn,
then can recover the same binding from exact assistant-output history on later
turns. Kiro model-call HTTP sockets are fresh by default
(`sdk_http_keep_alive: false`); enabling it is a best-effort transport
optimization, never a promise that one session owns one physical TCP
connection. The default `enforce_single_instance: true` also prevents a second
service process from splitting the in-memory queues and pools.

Use a pinned standalone binary for a service rather than fetching through
`bunx` on every start. The examples below assume the release installers'
defaults:

- binary: `~/.local/bin/kiro-provider` on Linux,
  `%USERPROFILE%\.local\bin\kiro-provider.exe` on Windows;
- config: `~/.config/kiro-provider/config.json` on Linux,
  `%APPDATA%\kiro-provider\config.json` on Windows;
- service/task name: `kiro-provider`.

Run the one-time import and the service as the **same OS user** so the service
owns the same `~/.config/kiro-provider/accounts.db`, config, keyring, and
instance lock. Running as `root`, `LocalSystem`, or another user normally
selects a different local store. Use absolute paths and keep the API key in
the protected config file rather than service arguments. The OpenCode
database is not read again after the import.

## Linux: systemd user service

Verify the installed binary and config first:

```bash
test -x "$HOME/.local/bin/kiro-provider"
test -r "$HOME/.config/kiro-provider/config.json"
chmod 600 "$HOME/.config/kiro-provider/config.json"
```

Install a [systemd user service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html):

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

If the binary or config is elsewhere, replace `ExecStart` with those absolute
paths. For a custom `XDG_CONFIG_HOME`, also add an explicit
`Environment=XDG_CONFIG_HOME=/absolute/path` line.

Operate and inspect the service:

```bash
systemctl --user is-active kiro-provider.service
systemctl --user restart kiro-provider.service
journalctl --user -u kiro-provider.service -n 100 --no-pager
```

User services normally start with that user's service manager. If the
provider must start at boot and remain after logout, an administrator may
enable lingering with `loginctl enable-linger <user>` after reviewing the
machine's security policy.

To remove the unit:

```bash
systemctl --user disable --now kiro-provider.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kiro-provider.service"
systemctl --user daemon-reload
```

## Windows: per-user scheduled task

`kiro-provider.exe` is a normal foreground executable, not a native Windows
Service Control Manager executable. Do not register it directly with
`sc.exe`. The built-in, dependency-free option is a
[Scheduled Task](https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask)
that starts at sign-in, runs as the current user, and restarts after failure.

Run the following in PowerShell as the same user that owns the provider's
local authentication database and config. It creates a small launcher so
stdout/stderr are retained under `%LOCALAPPDATA%\kiro-provider`:

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

Inspect, restart, and follow logs:

```powershell
Get-ScheduledTask -TaskName "kiro-provider" | Get-ScheduledTaskInfo
Stop-ScheduledTask -TaskName "kiro-provider"
Start-ScheduledTask -TaskName "kiro-provider"
Get-Content "$env:LOCALAPPDATA\kiro-provider\service.log" -Tail 100 -Wait
```

To remove the task and launcher:

```powershell
Stop-ScheduledTask -TaskName "kiro-provider" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "kiro-provider" -Confirm:$false
Remove-Item "$env:APPDATA\kiro-provider\service.ps1"
```

This task intentionally runs only in the current user's interactive session,
so it can use that user's network access, provider database, and keyring
without storing a Windows password. A true pre-login Windows service requires
a service wrapper and a deliberately configured user account; do not run it
as `LocalSystem` and expect the same provider-owned files.

## Health checks and automation contract

After either installation, verify both process liveness and authenticated
readiness:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready \
  -H 'Authorization: Bearer sk-your-private-key'
```

PowerShell equivalent:

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health"
$Headers = @{ Authorization = "Bearer sk-your-private-key" }
Invoke-RestMethod "http://127.0.0.1:8787/ready" -Headers $Headers
```

For an AI agent or installer, treat setup as successful only when:

1. the binary and explicit config path exist;
2. the service/task runs as the credential-owning user;
3. `/health` succeeds;
4. authenticated `/ready` succeeds, proving a readable auth source, at least
   one active account, writable provider state, an available reasoning keyring,
   and coverage for every key ID referenced by an unexpired replay record.

Use the fixed service/task name above so repeated setup is idempotent. Restart
it after changing the config or replacing the binary. Do not make the client
responsible for starting a private provider process; configure clients only
with the stable base URL and gateway API key.

## Related documentation

- [Configuration reference](CONFIGURATION.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Repository documentation index](README.md)
