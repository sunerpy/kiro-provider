# 常见问题

简短的回答，每条都链接到包含细节的页面。

## 需要 Kiro CLI 或 Kiro IDE 吗？

不需要。`kiro-provider login` 自己完成登录、查找 Kiro profile 和续期令牌，运行时也不读取其他程序的文件。[账号](../guide/accounts.md)

## 能在 Node.js 上运行吗？

npm 包使用 Bun 的 API，只能在 Bun 上运行：`bun add -g @sunerpy/kiro-provider`。独立二进制两者都不需要。[安装](../guide/install.md)

## 可以使用哪些模型？

你已登录的账号能使用的模型。`GET /v1/models` 会列出它们，其中包括 `auto`，以及有推理等级的模型按等级区分的名称。[选择客户端](../clients/index.md#模型名称)

## Responses 请求返回 `403 access_denied`，为什么？

不带 `store: false` 的请求会发往 Kiro 自己的 Responses 操作，而 Kiro 可能对某个账号拒绝该操作。加上 `store: false` 后，请求会经由 kiro-provider 自己的转换处理，Codex CLI 的请求也是这样。[快速开始](../guide/quick-start.md#4-发送第一个请求)

## 请求失败，错误中写明了某个字段，这是缺陷吗？

通常不是。两条通往 Kiro 的路径都无法保留某个字段时，请求会以带类型的错误（例如 `unsupported_structured_output`）失败，而不是丢掉这个字段。每种接口接受什么见[协议兼容性](../../../readme/PROTOCOL_COMPATIBILITY.zh-CN.md)；有意拒绝的内容见[已知限制](../limits.md)。

## 其他机器能使用我的网关吗？

除非你设置了 `host`，否则它只监听 `127.0.0.1`。如果把它开放到网络上，每个请求仍然需要 `api_keys` 中的一个密钥，但传输的是明文 HTTP；请放在负责 TLS 的代理之后，并像对待密码一样对待这些密钥。[配置参考](../../../readme/CONFIGURATION.zh-CN.md)

## 可以和别人共享我的账号吗？

不可以。kiro-provider 只用于你自己控制的 Kiro 账号，也不会绕过这些账号的用量限制。

## 为什么账号显示 `quota-exhausted` 或 `overage-blocked`？

前者表示 Kiro 报告其额度已用完，后者表示它已进入付费超额而 `stop_on_overage` 不允许使用。额度重置后账号会自动恢复。[账号](../guide/accounts.md#查看账号)

## 它会保存我的提示词吗？

只保存两种接口默认保存的内容。不带 `store: false` 的 Responses 请求会在本地保存 30 天，供客户端取回和继续对话；对话还会保存加密的推理内容，供下一轮使用。这些都在你机器上的 `accounts.db` 中，日志从不包含提示词。[数据与网络](../privacy.md)

## 除了 AWS，它还会连接别的地方吗？

只有在你运行 `kiro-provider --version --check` 或 `self-update` 时才会连接 GitHub。网关本身不会向 GitHub 发送任何内容，也没有遥测。[数据与网络](../privacy.md)

## 可以运行两个网关吗？

不能在同一个配置目录上运行：第二个会以 `service_instance_already_running` 停止。推荐的做法是每个用户一个网关。[运维](../operate/index.md#每个用户一个网关)

## 这是 AWS 的产品吗？

不是。kiro-provider 是以 MIT 许可证发布的独立开源项目。
