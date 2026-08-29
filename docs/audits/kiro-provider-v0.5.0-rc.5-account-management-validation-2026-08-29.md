# kiro-provider v0.5.0-rc.5 账号管理验收（2026-08-29）

## 范围

本轮将 provider 自有本地认证库补齐为可独立运维的账号事实源：

- 对齐显示账号健康、可用性和额度，并提供不含凭证的 details/JSON 输出；
- 支持全量或单账号立即刷新 Kiro 权威 usage；
- access token 只在临近到期或被上游判定 invalid bearer 时刷新；
- 支持保留内部账号 ID 的重新登录，写入前验证 Kiro usage 邮箱；
- 重复邮箱必须使用稳定账号 ID 消歧；
- 删除默认要求确认，并同步删除该账号的 affinity、output lineage 和
  reasoning replay 状态。

## 自动化验证

在仓库根目录执行：

```text
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
make fmt-check
make coverage-parity
make codex-smoke-security
make security
make coverage-gate
```

结果：

- lint：通过；
- typecheck：通过；
- tests：`882 pass / 0 fail`；
- Bun bundle：通过；
- Linux x64 编译二进制：通过。
- 格式与跨平台覆盖率清单：通过；
- Codex 安全烟测：通过；
- security gate：`7/7` 通过；
- coverage gate：`13597/14536 = 93.54%`，高于 `93%` 门槛。

沙箱内首次全量测试因禁止 loopback 临时端口而出现 `EADDRINUSE`；同一提交在
允许本机 loopback 的环境原样重跑后全部通过。账号管理定向测试另覆盖：

- fresh 与尚未到复查时间的 exhausted 账号仍会被手工 refresh；
- token renewed、usage updated、timeout、needs-relogin 的逐账号状态；
- refresh 结果不含 access token、refresh token 或 client secret；
- 生产 `AccountsDatabase`、`AccountManager`、`TokenRefresher` 与
  `QuotaRechecker` 的实际连线；
- 邮箱唯一匹配、重复邮箱拒绝、交互取消与 `--yes` 删除；
- relogin 身份不一致时零写入；
- relogin 成功时保留原 ID，并只清理完全相同的旧登录身份。

## 编译后二进制真实账号验证

验证对象为 provider 自有本地数据库，未读取或写入 OpenCode 运行时数据库。
命令使用本轮 `dist/kiro-provider` 编译产物。

### 列表

```text
./dist/kiro-provider accounts list --json
```

结果：

- 退出码 `0`；
- 读取到 `42` 个账号；
- 每条记录包含稳定 ID、邮箱、健康、可用性、usage、时间戳和 generation；
- 输出不包含 access token、refresh token、client secret；
- 验证前快照为 `34` 个 quota-exhausted、`8` 个 available。

### 全量权威 usage 刷新

```text
./dist/kiro-provider accounts refresh --all --json
```

脱敏结果：

```json
{
  "totalAccounts": 42,
  "tokenRenewed": 0,
  "usageUpdated": 42,
  "failed": 0,
  "timedOut": false,
  "durationMs": 3911,
  "quotaStatus": {
    "exhausted": 34,
    "available": 8
  }
}
```

所有账号均实际调用 Kiro `getUsageLimits`；其中一个 available 账号的权威用量
从 `9932/10000` 更新为 `9936/10000`，证明不是复述本地缓存。已耗尽账号保持
排除并将下一次后台复查时间推进；未发生模型调用，也未无意义轮换仍有效的
access token。

### 单账号定向刷新

使用稳定账号 ID 对编译后二进制执行：

```text
./dist/kiro-provider accounts refresh <redacted-account-id> --json
```

脱敏结果：

- 退出码 `0`；
- `1/1` 账号 usage 更新成功；
- `0` 失败、未超时；
- 用时 `988ms`；
- 有效 access token 未被无意义刷新。

## 安全边界

- 未对真实账号执行 remove 或 relogin；这两条有破坏性的路径使用临时数据库和
  mock Kiro 身份证据验证。
- JSON 与结构化日志不记录 token、secret、提示词、reasoning 或签名。
- `auth_source: "opencode-shared"` 会拒绝 provider 自有 refresh/relogin，
  防止恢复双进程凭证所有权。
- 邮箱重复时不会任意选择第一条记录；错误会列出可用于消歧的账号 ID。

## 证据边界

本文档记录标签产生前可固化在源码中的门禁和真实账号验证。GitHub tag、Release
资产、校验和、本机二进制替换、systemd 重启及健康检查属于发布后的外部状态，
必须在发布交付记录中独立核验，不能由源码内文档预先宣称完成。
