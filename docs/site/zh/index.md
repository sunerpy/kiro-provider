---
layout: home
title: "kiro-provider：用 OpenAI Responses 和 Anthropic Messages 接口使用你的 Kiro 账号"
titleTemplate: false
description: kiro-provider 是运行在你自己机器上的网关。它登录 AWS Kiro，在你的多个账号之间分配请求，并以 OpenAI Responses 和 Anthropic Messages 接口对外提供服务，供 Codex CLI、Claude Code、Zuno 和官方 SDK 使用。

hero:
  name: kiro-provider
  text: 让你常用的 Agent 直接使用 Kiro 账号
  tagline: 运行在你自己机器上的网关。它登录 AWS Kiro，以 OpenAI Responses 和 Anthropic Messages 接口提供你的账号，Codex CLI、Claude Code、Zuno 和官方 SDK 只需配置一个地址和一个密钥。
  actions:
    - theme: brand
      text: 安装
      link: /zh/guide/install
    - theme: alt
      text: 快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/sunerpy/kiro-provider

home:
  facts:
    - term: 运行平台
      text: Linux、macOS 和 Windows，可用单个可执行文件或 Bun 包安装，默认只监听 127.0.0.1。
    - term: 你的账号
      text: 通过 AWS Builder ID 或 IAM Identity Center 登录。令牌保存在本地数据库中，只会发送给 AWS 和 Kiro。

  visual:
    label: 一段终端会话。一个请求以 gpt-5.6-sol 发往 OpenAI Responses 路由，另一个以 claude-opus-5-5 发往 Anthropic Messages 路由，kiro-provider 3.8.0 对两者都返回 KIRO_OK。
    transcript:
      - kind: command
        text: export KP=http://127.0.0.1:18879/v1 KEY=$KIRO_GATEWAY_API_KEY
      - kind: command
        text: "curl -s $KP/responses -H \"Authorization: Bearer $KEY\" --json '{"
      - kind: continuation
        text: '    "model": "gpt-5.6-sol", "store": false,'
      - kind: continuation
        text: "    \"input\": \"Reply with exactly: KIRO_OK\"}' |"
      - kind: continuation
        text: "  jq -r '.output[-1].content[0].text'"
      - kind: output
        text: KIRO_OK
      - kind: command
        text: "curl -s $KP/messages -H \"x-api-key: $KEY\" --json '{"
      - kind: continuation
        text: '    "model": "claude-opus-5-5", "max_tokens": 1024,'
      - kind: continuation
        text: '    "messages": [{"role": "user",'
      - kind: continuation
        text: "      \"content\": \"Reply with exactly: KIRO_OK\"}]}' |"
      - kind: continuation
        text: "  jq -r '.content[0].text'"
      - kind: output
        text: KIRO_OK
    caption: 2026-10-05 用 kiro-provider 3.8.0 在测试端口上录制，另一个终端中运行着 kiro-provider serve。默认地址是 http://127.0.0.1:8787。

  index:
    title: kiro-provider 能做什么
    intro: 联网搜索和 Chat Completions 路由默认关闭，其余功能在登录账号后即可使用。
    groups:
      - name: 接口
        items:
          - title: OpenAI Responses
            body: 流式与非流式响应，支持工具、图片和推理等级；保存的响应可以取回、列出输入项并继续对话。
            status: available
            link: /zh/reference/protocol
          - title: Anthropic Messages
            body: 支持 thinking、工具和图片的 Messages 接口，以及 /v1/messages/count_tokens 的 token 估算。
            status: available
            link: /zh/reference/protocol
          - title: 联网搜索
            body: 两种接口的托管联网搜索工具由 kiro-provider 通过处理该请求的账号执行，回答中带有引用。
            status: opt-in
            link: /zh/guide/web-search
          - title: Chat Completions
            body: 较早的 OpenAI 路由，供只支持它的客户端使用。只有开启 enable_legacy_chat_completions 后才会响应。
            status: opt-in
            link: /zh/reference/configuration#协议暴露面
      - name: 账号
        items:
          - title: 直接登录
            body: 以设备码方式登录 AWS Builder ID 和 IAM Identity Center。kiro-provider 自行查找 Kiro profile，不需要 Kiro CLI。
            status: available
            link: /zh/guide/accounts
          - title: 多个账号，一个地址
            body: 请求交给当前最空闲的可用账号。额度用完的账号会暂停使用，直到 Kiro 报告新的额度。
            status: available
            link: /zh/guide/accounts
          - title: 令牌与用量
            body: 访问令牌在过期前自动续期，用量在后台刷新；accounts list 显示每个账号的状态。
            status: available
            link: /zh/guide/accounts#查看账号
      - name: 客户端
        items:
          - title: Codex CLI
            body: 配置一个 wire_api = "responses" 的自定义 model_provider，支持在 /model 中切换模型和推理等级。
            status: available
            link: /zh/clients/codex
          - title: Claude Code
            body: kiroclaude 启动器让 Claude Code 连接网关，不修改你的 Claude 设置。
            status: available
            link: /zh/clients/claude-code
          - title: Zuno
            body: 使用 Zuno 自带的 Responses 传输，并根据其会话元数据路由。
            status: available
            link: /zh/clients/zuno
          - title: 模型列表
            body: GET /v1/models 列出已登录账号可用的模型，并附带 Codex 模型菜单读取的推理等级。
            status: available
            link: /zh/clients/codex#切换模型与推理等级
      - name: 运维
        items:
          - title: 后台服务
            body: Linux 上的 systemd 用户服务或 Windows 上的计划任务，并提供供自动化使用的健康与就绪检查。
            status: available
            link: /zh/operate/service
          - title: 健康检查与日志
            body: 供服务管理器使用的 GET /health 和 GET /ready，以及只含计数、枚举值和哈希、不含提示词或凭据的 JSON 日志。
            status: available
            link: /zh/operate/
          - title: 更新
            body: self-update 只有在新版本与发布的 SHA256SUMS 一致时才会替换独立二进制。
            status: available
            link: /zh/guide/updates
  steps:
    title: 从安装到第一个回答
    items:
      - title: 安装
        command: curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
        body: Windows 上使用 PowerShell 脚本，也可以运行 bun add -g @sunerpy/kiro-provider。
      - title: 登录
        command: kiro-provider login
        body: 以设备码方式登录 AWS Builder ID。使用 IAM Identity Center 时加上 --start-url。
      - title: 启动网关
        command: kiro-provider serve
        body: 先在 config.json 的 api_keys 中写入一个私有密钥，没有密钥时网关拒绝启动。
      - title: 连接客户端
        command: http://127.0.0.1:8787/v1
        body: 在 Codex CLI、Claude Code、Zuno 或 SDK 中填入这个地址和你的密钥。

  protocols:
    columns: [路由, 协议, 默认状态]
    rows:
      - cells: [POST /v1/responses, OpenAI Responses, 开启]
      - cells: [POST /v1/messages, Anthropic Messages, 开启]
      - cells: [POST /v1/messages/count_tokens, Anthropic token 估算, 开启]
      - cells: [GET /v1/models, 模型列表, 开启]
      - cells: [POST /v1/chat/completions, OpenAI Chat Completions, 开启后可用]
    code: [0]
    caption: 除 /health 外，每个路由都要求提供 api_keys 中的一个密钥，可放在 Authorization Bearer 或 x-api-key 中。

  clients:
    columns: [客户端, 接口, 配置方式]
    rows:
      - cells: [Codex CLI, Responses, config.toml 中的 model_provider]
      - cells: [Claude Code, Messages, kiroclaude 启动器]
      - cells: [Zuno, Responses, Zuno 配置中的 provider]
      - cells: [OpenAI 与 Anthropic SDK, Responses 或 Messages, 一个地址和一个 API 密钥]
    caption: 最近一次验证于 2026-10-05，使用 Codex CLI 0.159.3 和 Claude Code 2.1.285。各客户端指南写明了验证的内容。

  search:
    columns: [接口, 工具, 回答中包含]
    rows:
      - cells: [Responses, web_search, web_search_call 条目和 url_citation 标注]
      - cells: [Messages, web_search_20250305, web_search_tool_result 块和带引用的文本]
    code: [1]
    caption: 搜索只在 gpt-5.6-sol 或 claude-opus-5.5 下、在 Kiro profile 位于 us-east-1 的账号上执行。其他模型会在执行任何操作前被拒绝。

  platforms:
    title: 支持的平台
    intro: 每个版本都为下列平台提供一个独立二进制、一个 SHA256SUMS 文件和构建证明。
    columns: [平台, 发布文件, 安装脚本]
    rows:
      - name: Linux x64
        status: available
        cells: [kiro-provider-linux-x64, install.sh]
      - name: Linux ARM64
        status: available
        cells: [kiro-provider-linux-arm64, install.sh]
      - name: macOS Intel
        status: available
        cells: [kiro-provider-darwin-x64, install.sh]
      - name: macOS Apple Silicon
        status: available
        cells: [kiro-provider-darwin-arm64, install.sh]
      - name: Windows x64
        status: available
        cells: [kiro-provider-windows-x64.exe, install.ps1]
    note: npm 包 @sunerpy/kiro-provider 使用 Bun 的 API，需要用 Bun 安装，不能在 Node.js 或 npx 下运行。

  privacy:
    title: 哪些数据留在本机
    intro: kiro-provider 只为你的账号连接 AWS，只在你查询更新时连接 GitHub。
    sendsLabel: 发往
    modes:
      - name: 模型请求
        sends: Kiro，包括你的提示词
        detail: 每个请求由处理它的账号发往 Kiro。日志只记录计数、长度和哈希，从不记录提示词、工具参数或凭据。
      - name: 账号
        sends: AWS 登录服务与 Kiro
        detail: 登录、令牌续期和用量查询。令牌保存在配置目录的 accounts.db 中，只有你的用户可以读取。
      - name: 更新
        sends: GitHub Releases
        detail: 只有 kiro-provider --version --check 和 self-update 会连接 GitHub，网关本身从不连接。

  scope:
    title: 它不做什么
    items:
      - 不共享、不转售访问权限。只用于你自己控制的 Kiro 账号。
      - 不绕过用量限制。额度用完的账号会等待 Kiro 报告新的额度。
      - 不伪造结果。联网搜索以外的托管工具、后台响应和 conversation 对象都会以带类型的错误拒绝，不会模拟。
      - 除非你把 host 设为 127.0.0.1 以外的地址，否则不监听网络。
---

<HomeIndex />

<HomeSteps />

<SplitBlock proof="protocols">

## 两种接口，一个网关

Responses 和 Messages 由同一个进程、同一组账号提供服务。Kiro 自己的 Responses 操作能原样接收的 Responses 请求会直接发往那里；其余请求（包括
`store: false` 的请求）由 kiro-provider 自行转换。两条路径都无法保留某个字段时，请求会失败，错误中写明这个字段，而不是悄悄丢掉它。

[协议兼容性](../../readme/PROTOCOL_COMPATIBILITY.zh-CN.md) · [配置参考](../../readme/CONFIGURATION.zh-CN.md)

</SplitBlock>

<SplitBlock proof="clients" flip>

## 客户端无需改动

Codex CLI 和 Zuno 使用 Responses，Claude Code 使用 Messages。每个客户端只需配置一个地址和你的一个密钥，不需要插件，也不需要修改客户端。启动器会在你现有命令旁边增加一个单独的
`kirocodex` 或 `kiroclaude` 命令。

[选择客户端](clients/index.md) · [客户端启动器](../../readme/CLIENT_LAUNCHERS.zh-CN.md)

</SplitBlock>

<SplitBlock proof="search">

## 用你自己的账号联网搜索

开启 `web_search_enabled` 后，kiro-provider 自己执行两种接口的托管搜索工具：通过 Kiro 的搜索，使用处理该请求的账号。回答按该接口定义的格式返回，包含客户端需要的搜索结果和引用。此功能默认关闭。

[联网搜索](guide/web-search.md)

</SplitBlock>

<HomePlatforms />

<HomePrivacy />

## 安装

::: code-group

```sh [Linux 和 macOS]
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

```powershell [Windows]
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

```sh [Bun]
bun add -g @sunerpy/kiro-provider
```

:::

安装脚本会先用该版本的 `SHA256SUMS` 校验二进制，再进行安装。[安装指南](guide/install.md)介绍了如何固定版本、从源码构建以及卸载。

<HomeScope />

## 反馈

问题报告和功能建议请提交到 [GitHub Issues](https://github.com/sunerpy/kiro-provider/issues)。kiro-provider 以 MIT 许可证发布，不是 AWS 的产品。
