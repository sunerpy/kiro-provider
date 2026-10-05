# 安装

本页介绍如何安装 kiro-provider、校验下载的文件，以及如何卸载。

kiro-provider 有两种发布形式：每个平台一个独立可执行文件，发布在 [GitHub Releases](https://github.com/sunerpy/kiro-provider/releases)；以及运行在 [Bun](https://bun.sh) 上的 npm 包 `@sunerpy/kiro-provider`。独立可执行文件不需要安装任何其他软件。

## Linux 和 macOS

```sh
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

脚本会选择适合当前系统（x64 或 ARM64）的二进制，只有在其 SHA-256 与该版本 `SHA256SUMS` 中的记录一致时才继续，然后把 `kiro-provider` 安装到 `$HOME/.local/bin`。脚本需要 `curl` 或 `wget`，以及 `sha256sum`、`shasum` 或 `openssl` 之一。它不会修改 shell 配置文件：如果该目录不在 `PATH` 中，脚本会打印需要添加的那一行。

设置 `KIRO_PROVIDER_INSTALL_DIR` 可以安装到其他目录。

## Windows

在 PowerShell 中运行：

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

脚本以同样的方式校验二进制，把 `kiro-provider.exe` 安装到 `%USERPROFILE%\.local\bin`。如果该目录不在 `PATH` 中，脚本会打印把它加入用户 `PATH` 的命令；运行后重新打开终端即可。这里同样可以用 `KIRO_PROVIDER_INSTALL_DIR` 指定目录。Windows 只提供 x64 版本。

## 安装指定版本

两个脚本默认安装最新版本；设置 `KIRO_PROVIDER_VERSION` 可以指定版本，带不带开头的 `v` 都可以。长期运行的安装（例如[后台服务](../../../readme/SERVICE.zh-CN.md)）应固定版本，并从同一个标签获取脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/vX.Y.Z/scripts/install.sh \
  | KIRO_PROVIDER_VERSION=X.Y.Z sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "X.Y.Z"
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/vX.Y.Z/scripts/install.ps1 | iex
```

## Bun 包

```sh
bun add -g @sunerpy/kiro-provider
kiro-provider --version
```

不安装、只运行一次时，使用 `bunx @sunerpy/kiro-provider --help`。这个包调用 Bun 自己的 API，因此不能在 Node.js、`npm exec` 或 `npx` 下运行。升级同样通过 Bun 进行，见[更新](updates.md)。

## 自行下载二进制

每个版本为每个平台提供一个二进制、一个 `SHA256SUMS` 文件，并为每个二进制提供构建证明：

| 平台                | 文件                            |
| ------------------- | ------------------------------- |
| Linux x64           | `kiro-provider-linux-x64`       |
| Linux ARM64         | `kiro-provider-linux-arm64`     |
| macOS Intel         | `kiro-provider-darwin-x64`      |
| macOS Apple Silicon | `kiro-provider-darwin-arm64`    |
| Windows x64         | `kiro-provider-windows-x64.exe` |

从同一个版本下载二进制和 `SHA256SUMS`，然后同时校验校验和与构建来源：

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify kiro-provider-linux-x64 \
  --repo sunerpy/kiro-provider \
  --signer-workflow sunerpy/kiro-provider/.github/workflows/release.yml \
  --deny-self-hosted-runners
```

把文件重命名为 `kiro-provider`（Windows 上为 `kiro-provider.exe`），设为可执行，并放到 `PATH` 中的目录里。

## 从源码构建

需要 [Bun](https://bun.sh) 和本仓库的克隆：

```sh
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
bun run build:binary
```

生成的二进制是 `dist/kiro-provider`。测试和检查见[参与开发](../developers.md)。

## 检查安装

```sh
kiro-provider --version
```

然后继续阅读[快速开始](quick-start.md)。

## 卸载

1. **停止网关。** 如果它作为服务运行，先停止并删除服务；[后台服务指南](../../../readme/SERVICE.zh-CN.md)介绍了 systemd 和 Windows 计划任务的做法。
2. **删除数据**（如果不打算再使用）。kiro-provider 的所有数据都在一个目录中：Linux 和 macOS 上是 `~/.config/kiro-provider`（或 `$XDG_CONFIG_HOME/kiro-provider`），Windows 上是 `%APPDATA%\kiro-provider`。其中包括 `config.json`、存有账号令牌的 `accounts.db`，以及加密推理内容所用的密钥文件。删除该目录即可全部移除。
3. **删除可执行文件**：`~/.local/bin/kiro-provider`、`%USERPROFILE%\.local\bin\kiro-provider.exe`，或你通过 `KIRO_PROVIDER_INSTALL_DIR` 指定的目录中的文件。Bun 安装用 `bun remove -g @sunerpy/kiro-provider` 卸载。
