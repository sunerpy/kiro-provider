# 更新

本页介绍如何查看是否有新版本、如何更新各种安装方式，以及正在运行的网关需要怎样处理。

## 查看新版本

```sh
kiro-provider --version --check
```

```text
kiro-provider 3.8.0
Latest release: 3.8.0 (https://github.com/sunerpy/kiro-provider/releases/tag/v3.8.0)
Already on the latest release.
```

不加 `--check` 时，`--version` 只打印已安装的版本，不会联网。加上 `--json` 便于脚本处理；输出对象包含 `version`、`latest_version`、`latest_tag`、`update_available`、`local_is_newer` 和 `release_url`。

各版本的变更见[更新日志](../../../../changelog/CHANGELOG-v3.x.md)和 [Releases 页面](https://github.com/sunerpy/kiro-provider/releases)。

## 更新独立二进制

```sh
kiro-provider self-update --check     # 只说明将安装什么，不做任何改动
kiro-provider self-update             # 询问后替换二进制
kiro-provider self-update --yes       # 不询问，直接替换
kiro-provider self-update --tag 3.7.3 # 安装指定版本，也可以是更早的版本
```

`self-update` 从 GitHub Releases 下载当前平台的二进制，并用该版本的 `SHA256SUMS` 校验。只有摘要一致时才会替换，因此下载失败或被篡改都不会影响已安装的副本。它需要对二进制所在目录有写权限，而不是对文件本身。

如果已经是最新版本，或者比最新版本还新，`self-update` 会停止并说明原因；加上 `--force` 会照样安装最新版本。`--json` 以对象形式报告结果。

`self-update` 和 `--version --check` 都不读取网关的 `config.json`，因此配置有误不会妨碍更新。

## 更新 Bun 安装

```sh
bun add -g @sunerpy/kiro-provider@latest
```

`self-update` 会拒绝替换通过包管理器安装的副本，并说明原因。

## 通过代理

两个命令都接受 `--proxy <url>`。不加时，它们依次使用 `KIRO_PROVIDER_PROXY_URL`、`HTTPS_PROXY` 或 `HTTP_PROXY`。`--proxy ""` 表示不使用代理，也不会再回退到这些变量。Bun 自己的 `fetch` 也会读取 `HTTPS_PROXY` 和 `HTTP_PROXY`，需要完全直连时请同时取消这两个变量。

## 重启网关

`self-update` 不会改动配置、账号存储或服务定义，也不会重启任何东西。正在运行的网关会一直使用它启动时的版本，直到重启：

```sh
kiro-provider self-update --yes
systemctl --user restart kiro-provider.service
kiro-provider --version
```

Windows 上请停止再启动计划任务（先 `Stop-ScheduledTask -TaskName "kiro-provider"`，再 `Start-ScheduledTask`）。作为服务运行时，建议用 `--tag` 固定版本，而不是跟随最新版本；完整步骤和之后的健康检查见[后台服务指南](../../../readme/SERVICE.zh-CN.md#升级服务二进制)。

新版本会迁移旧版本留在 `accounts.db` 中的数据。回退到旧版本时可能需要先做一些处理，例如[联网搜索](web-search.md#搜索历史)要求在回到不支持它的版本前删除其字段。
