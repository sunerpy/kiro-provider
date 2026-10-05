# 运维 kiro-provider

## 每个用户一个网关

为每个操作系统用户运行一个长期存活的 kiro-provider，并让该用户的所有客户端都连接它。为每个 Agent 或每段对话单独启动网关，会失去长期进程才有的东西：让对话留在原账号上的绑定、与 Kiro 的连接，以及在客户端之间分配账号的队列。配置目录中的锁文件会阻止第二个网关在同一目录上启动（`service_instance_already_running`）。

[后台服务](../../../readme/SERVICE.zh-CN.md)指南介绍了如何在 Linux 上安装为 systemd 用户服务、在 Windows 上安装为当前用户的计划任务，以及如何升级。

## 健康与就绪

| 检查          | 需要密钥 | 返回                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health` | 否       | 进程运行期间返回 `{"status":"ok"}`。                                                                                                       |
| `GET /ready`  | 是       | 有可用账号且存储可用时返回 HTTP 200 和 `"status":"ready"`；否则返回 503、`"status":"not_ready"` 和 `reason`（例如 `no_active_accounts`）。 |

```sh
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

`/health` 适合用作存活探针，`/ready` 适合在启动客户端之前检查。`/ready` 返回中的 `model_catalog` 对象说明模型列表来自 Kiro 还是内置的后备列表。

## 日志

网关以每行一个 JSON 对象的形式把日志写到标准错误。事件名称说明发生了什么（`request_received`、`account_selection_completed`、`upstream_attempt_failed`），并附带计数、耗时、枚举值和哈希。提示词、工具名称与参数、令牌和会话标识从不出现在日志中。`log_level`（`debug`、`info`、`warn`、`error`，默认 `info`）设定记录的级别。

在 systemd 下，日志位于 journal 中：

```sh
journalctl --user -u kiro-provider.service -n 200 --no-pager
```

[排障手册](../../../readme/TROUBLESHOOTING.zh-CN.md)从你看到的信号（HTTP 状态、错误码或日志事件）出发，说明它的含义和处理方式。

## 文件

kiro-provider 的所有数据都在一个目录中：Linux 和 macOS 上是 `$XDG_CONFIG_HOME/kiro-provider` 或 `~/.config/kiro-provider`，Windows 上是 `%APPDATA%\kiro-provider`。

| 文件                         | 内容                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `config.json`                | 你的配置和 `api_keys`。请保持只有你的用户可以读取。          |
| `accounts.db`                | 账号与令牌、用量、保存的响应、会话绑定、推理内容和搜索历史。 |
| `reasoning-replay-keys.json` | 加密推理内容和搜索历史所用的密钥。                           |
| `service.instance`           | 运行中的网关持有的锁。                                       |

`config.json` 能被其他用户读取时，网关会记录 `config_file_permissions_loose` 警告，执行 `chmod 600` 即可修正。`accounts.db` 及其 `-wal`、`-shm` 文件在创建时只有你的用户可以读取。备份时请备份整个目录：没有密钥文件，`accounts.db` 中保存的推理内容无法解密。

## 延伸阅读

- [配置参考](../../../readme/CONFIGURATION.zh-CN.md)：每个字段、对应的环境变量和默认值。
- [后台服务](../../../readme/SERVICE.zh-CN.md)：安装、升级和检查服务。
- [排障手册](../../../readme/TROUBLESHOOTING.zh-CN.md)：从现象找到原因。
- [流式错误契约](../../../STREAM_ERROR_CONTRACT.md)：流已经开始后出错时客户端会收到什么（英文）。
