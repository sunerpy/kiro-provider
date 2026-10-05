# 命令行

本页列出 3.8.0 版 `kiro-provider` 的所有命令和选项。

```text
Usage: kiro-provider <command> [options]

Commands:
  serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]
  login [--config <path>] [--start-url <url>] [--region <region>] [--profile-arn <arn>]
  accounts list [--details | --json] [--sort <field>] [--order asc|desc]
  accounts refresh (--all | <id|email>) [--config <path>] [--json]
  accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>] [--profile-arn <arn>]
  accounts import [--from <path>] [--force]
  accounts remove <id|email> [--yes]
  self-update [--check] [--tag <version>] [--yes] [--json] [--proxy <url>] [--force]

Options:
  -h, --help     Show this help.
  -V, --version  Show the installed version. Add --check to look up the latest
                 release, and --json for machine-readable output.
```

所有命令成功时以状态 0 退出；出错、确认被拒绝，或 `accounts refresh` 中有任一账号失败时以状态 1 退出。错误信息写到标准错误。

## 配置文件

`serve`、`login`、`accounts refresh` 和 `accounts relogin` 会读取 `config.json`。不加 `--config` 时，它们在 Linux 和 macOS 上查找 `$XDG_CONFIG_HOME/kiro-provider/config.json` 或 `~/.config/kiro-provider/config.json`，在 Windows 上查找 `%APPDATA%\kiro-provider\config.json`。字段也可以来自对应的环境变量，`serve` 还以选项形式提供其中三个（`--host`、`--port`、`--proxy`）；优先级是选项高于环境变量，环境变量高于文件。未知字段和非法值会让命令停止，错误中写明对应的字段。所有字段见[配置参考](../../../readme/CONFIGURATION.zh-CN.md)。

`accounts list`、`accounts import` 和 `accounts remove` 操作同一目录下的 `accounts.db`，不读取配置。`--version` 和 `self-update` 两者都不读取。

## serve

启动网关，开始接收请求后打印 `Listening on http://127.0.0.1:8787`。

| 选项              | 含义                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `--config <path>` | 读取这个配置文件，而不是默认文件。                                 |
| `--host <host>`   | 监听的地址，默认 `127.0.0.1`。设为其他地址会把网关暴露给你的网络。 |
| `--port <port>`   | 监听的端口，默认 `8787`。                                          |
| `--proxy <url>`   | 所有连接 AWS 的 HTTP 代理：模型调用、登录、令牌续期和用量查询。    |

`api_keys` 中没有任何条目，或者同一配置目录中已有网关持有锁时，它拒绝启动。收到 `SIGTERM` 或 `SIGINT` 时，它停止接收新请求，给正在处理的请求 10 秒完成，然后退出。

## login

用设备码登录 Kiro 并保存账号。

| 选项                  | 含义                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| `--start-url <url>`   | IAM Identity Center 的起始 URL。不加时用 AWS Builder ID 登录。                        |
| `--region <region>`   | 签发令牌的身份中心所在区域。默认取配置中的 `default_region`，未设置时为 `us-east-1`。 |
| `--profile-arn <arn>` | 身份有多个 Kiro profile 时要使用的那一个。                                            |
| `--config <path>`     | 要读取的配置，用于 `proxy_url` 和日志级别。                                           |

完整步骤见[账号](../guide/accounts.md#添加账号)。

## accounts list

列出保存的账号，不显示任何凭据。

| 选项                | 含义                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--details`         | 增加 ID、登录方式、超额次数、上次同步时间、令牌过期时间、复查时间和 generation。                                                                   |
| `--json`            | 以 JSON 输出同样的字段。                                                                                                                           |
| `--sort <field>`    | `email`（默认）、`id`、`auth`、`region`、`health`、`availability`、`usage`、`overage`、`last-sync`、`last-used`、`token-expires` 或 `generation`。 |
| `--order asc\|desc` | 排序方向。该字段没有值的行无论哪个方向都排在最后。                                                                                                 |

## accounts refresh

立即从 Kiro 获取一个账号或全部账号（`--all`）的当前用量，并为接近过期的访问令牌续期。`--json` 为每个账号输出一条结果。

## accounts relogin

让一个账号重新登录，并保留它的内部 ID。选项与 `login` 相同；不能把账号换到另一个 profile 上。

## accounts import

一次性复制 OpenCode 的 `opencode-kiro-auth` 中的账号。`--from <path>` 指定来源数据库；默认是与 kiro-provider 自己的目录同一配置根下的 `opencode/kiro.db`，例如 `~/.config/opencode/kiro.db`。本地副本较新的行会被跳过，除非加上 `--force`。

## accounts remove

经确认后删除一个账号，以及它的会话绑定、输出 lineage 和保存的推理内容。`--yes` 跳过确认。

## self-update

用发布版本替换独立二进制，替换前用该版本的 `SHA256SUMS` 校验。

| 选项              | 含义                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--check`         | 只报告将安装什么，不做任何改动。                                                                                     |
| `--tag <version>` | 安装这个版本，也可以是更早的版本。                                                                                   |
| `--yes`           | 不询问，直接替换。                                                                                                   |
| `--force`         | 已安装的版本已是最新或更新时，仍然重新安装。                                                                         |
| `--json`          | 以 JSON 报告结果。                                                                                                   |
| `--proxy <url>`   | 下载所用的代理。`""` 表示不使用代理；不加此选项时依次使用 `KIRO_PROVIDER_PROXY_URL`、`HTTPS_PROXY` 或 `HTTP_PROXY`。 |

Bun 安装会被拒绝，请用 `bun add -g @sunerpy/kiro-provider@latest` 更新。其余内容见[更新](../guide/updates.md)。

## --version

`kiro-provider --version` 打印已安装的版本。`--check` 还会在 GitHub 上查询最新版本，`--json` 输出一个对象，`--proxy <url>` 的用法与 `self-update` 相同。
