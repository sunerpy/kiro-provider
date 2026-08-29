# kiro-provider v0.5.0-rc.4 本地认证维护验收（2026-08-29）

## 1. 结论

`v0.5.0-rc.4` 将生产默认认证源切换为 Provider 自有本地账号库。已有
OpenCode + `opencode-kiro-auth` 凭证只需导入一次；导入后 access token、
usage、额度恢复和账号健康均由 kiro-provider 独立维护，不再实时读取或锁定
OpenCode 数据库。

本次没有修改 Zuno，也没有新增提示词拼接、消息改写或私有客户端 Header。
OpenCode 的 developer instructions 仍因 Kiro 缺少经验证的保真通道而需要
显式 `legacy-user-prefix`；这与认证库是否独立无关。

该版本适合作为预发布版，不是稳定版。RC.3 中 Codex
`reasoning.summary`、Claude Code `context_management` 和 OpenCode Chat
`cache_control` 的协议阻塞仍然存在。

## 2. 本地认证生命周期

生产默认配置为：

```json
{
  "auth_source": "local",
  "account_maintenance_enabled": true,
  "account_maintenance_interval_ms": 60000,
  "account_maintenance_timeout_ms": 120000,
  "account_maintenance_concurrency": 4,
  "usage_refresh_interval_ms": 900000
}
```

一次性导入：

```bash
kiro-provider accounts import
```

导入完成后：

- 本地 `accounts.db` 是唯一认证权威；
- 后台维护会主动刷新临近过期的 access token；
- 普通账号的 usage 快照过期后调用 Kiro `getUsageLimits`；
- 已耗尽账号在重置窗口前不参与模型请求，到期后独立探测并自动恢复；
- invalid bearer 每个账号只强制刷新一次，继续失败则从当前请求排除；
- token 变化时只重建绑定 bearer 的 SDK client，账号级 HTTP transport 继续
  复用；
- 默认单进程锁保护进程内账号队列、会话亲和、SDK client 与连接池。

`auth_source: "opencode-shared"` 仅保留为显式兼容模式，不是生产默认值。

## 3. 自动测试与质量门禁

完整测试结果：

```text
863 pass
0 fail
3583 expect() calls
73 files
```

覆盖率：

```text
12901 / 13821 lines
93.34% >= 93%
```

已通过：

```text
bun run typecheck
bun run lint
bun test
bun run build
bun run build:binary
bun run build:npm
make fmt-check
make coverage-gate
make coverage-parity
make security
make codex-smoke-security
git diff --check
```

安全门禁验证空 API key 失败关闭、默认仅绑定 loopback、日志无 secrets、
SQLite 与 sidecar 为 owner-only、请求体上限、请求超时和空闲流错误终止。
Codex smoke 自检验证临时回环进程完整清理、固定 origin/path、最小 Header、
API key 不进入 argv、capture 不含 Header 且临时文件仅 owner 可读写。

最终本机编译产物：

```text
dist/kiro-provider
size: 95266944 bytes
sha256: c26bf1d5c2890be35ccd5bd736f82fcedf97b8d2d809011b5cdf0a4df93798d5
```

## 4. 编译后二进制真实 E2E

验证脚本为 `scripts/validate-local-auth-e2e.ts`，使用最终编译的
`dist/kiro-provider` 和隔离的临时 HOME/XDG 目录。

步骤：

1. 从本机真实 OpenCode Kiro 数据库一次性导入一个可用账号；
2. 把导入后的 access token 改为过期值，并把 usage 标记为陈旧；
3. 将运行配置中的 OpenCode 数据库路径设为不存在的路径；
4. 启动 `auth_source: "local"` 的编译后二进制；
5. 等待 Provider 自主刷新 token 与 usage；
6. 使用官方 OpenAI JavaScript SDK 7.5.0 完成两轮标准 Responses；
7. 使用 OpenCode 1.18.18 完成真实 bash/write/read 工具循环。

最终结果：

```json
{
  "result": "LOCAL_AUTH_MAINTENANCE_E2E_OK",
  "imported_account_count": 1,
  "token_refreshed": true,
  "usage_refreshed": true,
  "official_openai_sdk": "7.5.0",
  "responses_turns": 2,
  "opencode_tool_loop": true,
  "protocol_projection_mode": "legacy-user-prefix",
  "missing_shared_db_runtime_succeeded": true
}
```

客户端只配置标准 base URL、API key 和模型；没有私有 Header、请求补丁或
客户端提示词补偿。临时服务和数据库在验证后已清理。

## 5. 发布与部署门禁

发布目标为预发布标签 `v0.5.0-rc.4`。发布工作流必须重新执行 CI、安全、
覆盖率与五平台编译，生成 `SHA256SUMS`，发布 npm `rc` 渠道，并在全部阶段
成功后才把 draft 转为公开 prerelease。

本机迁移必须先备份现有配置、账号库和二进制，然后使用发布的 Linux x64
资产执行一次性导入，将 `auth_source` 改为 `local` 并重启 systemd 用户服务。
验收要求包括：

- 发布资产与 `SHA256SUMS` 一致；
- 服务进程实际执行文件与发布资产哈希一致；
- 本地账号数量与导入结果一致；
- `/health` 和带鉴权的 `/ready` 均返回 200；
- journal 出现 `account_maintenance_started`，且没有认证库 schema 或
  invalid-bearer 循环错误。
