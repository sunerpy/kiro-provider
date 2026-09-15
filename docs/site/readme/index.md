---
layout: home
title: kiro-provider 文档
titleTemplate: false
description: 通过 OpenAI Responses 与 Anthropic Messages API 使用自己的 AWS Kiro 账号。
hero:
  name: kiro-provider
  text: 你的 Kiro 账号，标准 Agent API。
  tagline: 在本机运行一个网关，让 Codex、Claude Code、Zuno 以及常见 SDK 使用 OpenAI Responses 或 Anthropic Messages。
  actions:
    - theme: brand
      text: 五分钟开始使用
      link: /readme/quick-start
    - theme: alt
      text: 选择客户端
      link: /readme/clients/
---

<div class="kp-index" aria-label="文档索引">
  <section class="kp-index-section" aria-labelledby="zh-start-heading">
    <h2 id="zh-start-heading">开始</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/readme/quick-start">快速开始</a>
        <p>安装网关、登录 Kiro、检查就绪状态，并完成第一次 Responses 请求。</p>
      </li>
      <li class="kp-index-row">
        <a href="/readme/reference/configuration">配置参考</a>
        <p>配置鉴权、端口、超时、协议投影、代理和账号行为。</p>
      </li>
      <li class="kp-index-row">
        <a href="/readme/operate/service">作为服务运行</a>
        <p>每个系统用户运行一个固定版本的常驻 Provider，并使用明确的健康和就绪门禁。</p>
      </li>
    </ul>
  </section>
  <section class="kp-index-section" aria-labelledby="zh-clients-heading">
    <h2 id="zh-clients-heading">连接</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/readme/clients/codex">Codex CLI</a>
        <p>使用隔离的 OpenAI Responses Provider profile，不修改普通 Codex 状态。</p>
      </li>
      <li class="kp-index-row">
        <a href="/readme/clients/claude-code">Claude Code</a>
        <p>通过独立 Kiro profile、模型选择器和 token helper 使用 Anthropic Messages。</p>
      </li>
      <li class="kp-index-row">
        <a href="/readme/clients/zuno">Zuno</a>
        <p>配置原生 OpenAI transport、稳定会话 metadata 和明确的兼容边界。</p>
      </li>
    </ul>
  </section>
  <section class="kp-index-section" aria-labelledby="zh-understand-heading">
    <h2 id="zh-understand-heading">深入了解</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/readme/reference/protocol">协议兼容范围</a>
        <p>了解哪些请求使用原生 Responses、哪些需要 stateless 投影、哪些会明确拒绝。</p>
      </li>
      <li class="kp-index-row">
        <a href="/readme/operate/troubleshooting">排障手册</a>
        <p>按现象诊断账号健康、额度、回放、代理、流式传输、配置与生命周期故障。</p>
      </li>
      <li class="kp-index-row">
        <a href="/audits/">验收记录</a>
        <p>查看带日期的真实客户端探测和回归证据，并与当前运维契约分开阅读。</p>
      </li>
    </ul>
  </section>
</div>
