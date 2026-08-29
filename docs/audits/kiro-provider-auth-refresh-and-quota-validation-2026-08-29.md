# Kiro Provider access-token 刷新与额度排除验证（2026-08-29）

> 后续状态：本文记录的是第一阶段“共享认证副本 + 请求路径修复”证据。
> v0.5.0-rc.4 已将生产默认切换为 provider 自有本地认证库，并增加空闲期
> token/usage/额度恢复维护；最终发布与部署证据见
> `kiro-provider-v0.5.0-rc.4-local-auth-maintenance-validation-2026-08-29.md`。

## 1. 范围与结论

本次修复只修改 `kiro-provider`，没有修改 Zuno，也没有重启当前用户级
`kiro-provider.service`。

结论：

- access token 变化后不再复用绑定旧 bearer 的 AWS SDK client；
- 只重建 SDK client，继续复用同账号、区域、端点与 keep-alive 配置对应的
  HTTP transport；
- 已知达到额度的账号在 token 刷新与 SDK 创建前直接排除；
- 上游 HTTP 402 立即持久化为额度耗尽并从当前请求排除，不进入同账号重试；
- HTTP 401 或 invalid-bearer 403 每账号最多强制刷新一次，刷新后仍失败则在
  当前请求内排除；
- 认证链最终失败时保留 HTTP 401/403，额度链最终失败时返回 HTTP 402，不再
  用 `max_request_iterations` HTTP 500 掩盖根因。

本次没有修改任何提示词、消息、工具声明或协议投影逻辑。

## 2. 根因

旧实现按账号、区域、端点和 effort 缓存 `CodeWhispererStreamingClient`。
SDK 配置虽然使用了可变 token provider，但 AWS bearer 鉴权中间件会在已创建的
client 内缓存身份。共享认证刷新并发布新 access token 后，下一轮仍可能从缓存
取得旧 client，因此真实 HTTP 请求继续携带旧 bearer。

持续 invalid-bearer 会触发“强制刷新一次、切换账号”的循环；账号可被再次选中，
最终命中 `max_request_iterations`，把认证问题变成 HTTP 500。

## 3. 实现

### 3.1 Token 感知的 SDK 缓存

SDK client 缓存项保存 access token 的域分离 SHA-256 哈希。创建 client 时：

1. token 哈希未变化：复用 SDK client；
2. token 哈希变化：删除旧 SDK client 并使用新 token 创建 client；
3. 两种情况都复用相同的账号级 `NodeHttpHandler` transport。

结构化日志 `sdk_connection_pool_selected` 只记录账号哈希和命中状态，并增加
`sdk_client_rebuilt_for_token_change`；不记录 token。

### 3.2 请求级账号排除

单次请求维护不可回选的账号集合：

- 401 或 invalid-bearer 403：每账号只允许一次强制刷新；再次失败后排除；
- 402：立即排除并持久化额度耗尽；
- 其他要求切换账号的上游结果：切换后不在同一请求内回选原账号。

达到迭代上限时，如果已记录认证或额度根因，会返回最后的 401/403 或 402，而
不是通用 500。

### 3.3 额度耗尽过滤

满足任一条件即视为额度耗尽：

- `overage_count > 0`；
- `limit_count > 0` 且 `used_count >= limit_count`。

过滤发生在 token 刷新、模型 SDK client 创建和上游调用之前。共享认证模式下，
上游 402 会把 `used_count` 至少推进到已知 `limit_count`，并把
`rate_limit_reset` 至少推进到 60 秒后的复查时间。后续 OpenCode/Kiro 用量同步
仍是额度恢复的事实来源，可以在真实重置后重新发布可用状态。

## 4. 自动测试

新增或更新的回归覆盖：

- 两次真实本地 HTTP 请求分别携带旧 token 与刷新后的新 token；
- token 变化时 SDK client 不同、transport 对象相同；
- 401 和 invalid-bearer 403 每账号只强制刷新一次；
- 两账号持续拒绝刷新后 bearer 时各自只执行“原请求 + 刷新后请求”，最终返回
  403；
- 402 立即切换账号，不重试耗尽账号；
- 本地耗尽账号在 refresher 和 client factory 前被过滤；
- 全部账号耗尽时在上游前返回
  `{"code":"quota_exhausted"}` 与 HTTP 402；
- OpenCode 共享数据库和本地账号库均不再选择额度耗尽账号。

最终完整测试结果：

```text
781 pass
0 fail
3427 expect() calls
70 files
```

覆盖率门禁：

```text
12125 / 12951 lines
93.62% >= 93%
```

## 5. 编译后二进制真实端到端验证

验证使用最终 `dist/kiro-provider`、隔离的 XDG/config/锁文件和临时共享认证
数据库副本；没有触碰运行中的常驻服务。

临时数据库保留一个具备有效 refresh 凭据且未耗尽的账号，将其 access token
替换为仅用于测试的无效值；其余 41 个账号在副本中标记为已达到额度。这样第一
次真实 Kiro 模型请求必然触发 invalid-bearer，Provider 必须刷新 token 并重建
SDK client 才能成功。

服务监听隔离端口 `127.0.0.1:18789`。官方 OpenAI JavaScript SDK 7.5.0 只配置
标准 base URL、API key 与模型，通过 Responses 非流式请求得到精确结果：

```text
AUTH_QUOTA_REFRESH_E2E_OK
```

脱敏结构化日志证明：

```text
quota_exhausted_accounts_excluded account_count=41

首次请求:
transport_pool_hit=false
sdk_client_pool_hit=false
sdk_client_rebuilt_for_token_change=false

刷新后:
transport_pool_hit=true
sdk_client_pool_hit=false
sdk_client_rebuilt_for_token_change=true
```

刷新前后账号哈希与 Kiro conversation 哈希保持一致，说明同一请求没有发生
响应或工具会话串线；只有凭据绑定的 SDK client 被替换，transport 和
conversation 连续性得到保留。

验证完成后隔离服务已停止，临时数据库、配置和密钥目录已删除。

## 6. 门禁

以下门禁均通过：

```text
bun run lint
bun run typecheck
bun test
bun run build
bun run build:binary
make fmt-check
make coverage-gate
make coverage-parity
make security
make codex-smoke-security
git diff --check
```

编译后二进制：

```text
dist/kiro-provider
size: 95250560 bytes
sha256: 30da1ba3c3f44556203fd9dbe283ec9b713d877f4558a11496a78be084a4d0d4
```

## 7. 部署边界

工作区内的二进制已经包含修复，但当前 systemd 用户服务没有在本次验证中重启。
部署时需要先把新二进制放到服务实际使用的位置，再执行：

```bash
systemctl --user restart kiro-provider.service
```

仅重启旧二进制只能临时清空旧 SDK client 缓存，不能获得本次永久修复。
