# 账号

本页介绍如何添加 Kiro 账号、如何读懂账号状态，以及 kiro-provider 会自动替你做哪些事。

kiro-provider 把账号保存在配置目录的 `accounts.db` 中，也是唯一使用其中令牌的程序。运行时它不需要 Kiro CLI、Kiro IDE 或 OpenCode。

## 添加账号

```sh
kiro-provider login
```

这是 AWS Builder ID 的设备码登录：`login` 打印一个链接，你在浏览器中完成登录，命令随后保存账号。使用 IAM Identity Center 时，传入组织的起始 URL 以及其身份中心所在的区域：

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1
```

登录后，kiro-provider 会向 Kiro 查询该身份可用的 profile，并保存找到的那一个。如果有多个 profile、且起始 URL 无法唯一匹配，它会在写入任何内容之前停止；请指定要使用的 profile 重新运行：

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1 \
  --profile-arn arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE_ID
```

你传入的区域是身份登录所在的区域，请求发往的区域则由 profile 决定，两者可能不同；kiro-provider 会分别保存。

每个账号运行一次 `login`。同一个人用同样的起始 URL 和 profile 再次登录时，会更新已有的账号，而不是新增一个。

### 从 OpenCode 导入

如果你已经通过 OpenCode 的 `opencode-kiro-auth` 登录过，可以把这些账号复制过来一次：

```sh
kiro-provider accounts import
kiro-provider accounts import --from /path/to/kiro.db
```

导入是复制，不是关联。之后由 kiro-provider 续期它那份副本的令牌，因此请停止在 OpenCode 中使用同样的账号：两个程序同时续期同一个刷新令牌会相互冲突。如果本地副本比来源更新，该账号会被跳过，除非加上 `--force`。

## 查看账号

```sh
kiro-provider accounts list
kiro-provider accounts list --details
kiro-provider accounts list --json
```

默认表格每个账号一行，显示邮箱、区域、健康状态、可用状态和用量。`--details` 还会显示内部 ID、登录方式、超额次数、上次同步用量的时间、令牌过期时间，以及暂停中的账号下次复查的时间；`--json` 以 JSON 输出同样的字段，便于脚本处理。任何输出模式都不会显示令牌或客户端密钥。

用 `--sort` 排序，用 `--order desc` 反转顺序，例如 `--sort usage --order desc`。可用的字段有 `email`（默认）、`id`、`auth`、`region`、`health`、`availability`、`usage`、`overage`、`last-sync`、`last-used`、`token-expires` 和 `generation`。

可用状态一列说明账号是否在接收请求：

| 可用状态          | 含义                                                            | 处理方式                                                                                  |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `available`       | 正在接收请求。                                                  | 无需处理。                                                                                |
| `rate-limited`    | Kiro 要求它等待。`--details` 中的 `RECHECK_AT` 是等待截止时间。 | 等待。                                                                                    |
| `quota-exhausted` | Kiro 报告其额度已用完。用量查询确认进入新的额度周期后会恢复。   | 等待重置，或添加账号。                                                                    |
| `overage-blocked` | 已进入付费超额，而 `stop_on_overage` 不允许使用这类账号。       | 决定是否允许超额，见下文。                                                                |
| `needs-relogin`   | Kiro 拒绝了它的刷新令牌。                                       | `kiro-provider accounts relogin <ID 或邮箱>`。                                            |
| `unhealthy`       | 其他故障使它退出了轮换。                                        | 查看日志；[排障手册](../../../readme/TROUBLESHOOTING.zh-CN.md#账号与额度)列出了相关信号。 |

## kiro-provider 自动做的事

网关运行期间，它会：

- 在访问令牌过期前不久续期，并在使用前保存；
- 在后台刷新每个账号的用量；
- 把额度用完的账号移出轮换，到复查时间再检查；
- 不再尝试刷新令牌被 Kiro 拒绝的账号，并把它标为 `needs-relogin`。

对每个请求，它选择最空闲、且能使用该模型的账号；空闲程度相同时，默认的 `lowest-usage` 策略优先选择剩余额度最多的账号。每个账号最多同时处理 10 个请求（`account_inference_concurrency`）。带有会话标识的对话在原账号有空闲时会继续留在该账号上，详见[会话亲和](../../../readme/CONFIGURATION.zh-CN.md#会话亲和与连接复用)。

## 刷新、重新登录与删除

```sh
kiro-provider accounts refresh --all
kiro-provider accounts refresh you@example.com --json
```

`refresh` 立即向 Kiro 查询每个账号当前的用量，只在令牌接近过期时才续期。只要有一个账号失败，命令就以非零状态退出，并逐个报告结果，因此 `--json` 适合用于监控。

```sh
kiro-provider accounts relogin you@example.com
```

`relogin` 让一个账号重新登录，并保留它的内部 ID，绑定在该账号上的对话因此可以继续。它不能把账号换到另一个 Kiro profile 上；另一个 profile 请用新的 `login` 添加。

```sh
kiro-provider accounts remove you@example.com
```

`remove` 会先请求确认，`--yes` 跳过确认。它会删除账号，以及该账号的会话绑定和保存的推理内容。如果一个邮箱对应多个账号，请使用 `accounts list --details` 中的 ID。

## 付费超额

默认情况下，进入付费超额的账号不会被使用（`stop_on_overage: true`，`overage_threshold: 0`）。如果确实要使用超额，把 `stop_on_overage` 设为 `false`，或把 `overage_threshold` 调高到你能接受的超额请求次数。所有账号的额度都用完时，请求以 `402 quota_exhausted` 失败；所有账号都只是因为这条规则被排除时，以 `402 paid_overage_blocked` 失败。
