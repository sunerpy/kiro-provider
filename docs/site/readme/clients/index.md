---
title: 选择客户端
description: 根据 Agent 或 SDK 已支持的协议选择 kiro-provider 接入方式。
aside: false
---

# 选择客户端

优先使用客户端已经支持的协议。原生 KiroRuntime Responses 与 stateless adapter 之间的通道选择由网关负责，不应由客户端强制指定。

<section class="kp-index-section" aria-labelledby="zh-client-guides-heading">
  <h2 id="zh-client-guides-heading">Agent 指南</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/readme/clients/codex">Codex CLI</a>
      <p>通过隔离的自定义 Provider 使用 OpenAI Responses；真实客户端验收覆盖工具、失败恢复、compaction、Ultra reasoning 和多 Agent 协作。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/clients/claude-code">Claude Code</a>
      <p>通过隔离 profile 使用 Anthropic Messages，并明确模型选择、signed thinking、输出上限和 Bedrock 备用后端的边界。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/clients/zuno">Zuno</a>
      <p>配置原生 OpenAI Provider，并正确使用稳定会话 metadata、持久续轮和账号 affinity。</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="zh-other-clients-heading">
  <h2 id="zh-other-clients-heading">其他客户端</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/readme/reference/protocol">Responses 或 Messages SDK</a>
      <p>先确认协议契约，再配置 loopback base URL 和私有网关 Key；不支持的语义会返回类型化错误。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/configuration">旧版 Chat Completions</a>
      <p>只有客户端不支持两套主接口时才开启；该路由默认由 <code>enable_legacy_chat_completions</code> 关闭。</p>
    </li>
  </ul>
</section>
