---
title: 参考
description: kiro-provider 的协议、配置、用量、架构与回放契约。
aside: false
---

# 参考

这些页面定义当前网关契约。带日期的审计用于说明结论如何得到验证，但不会取代当前参考文档。

<section class="kp-index-section" aria-labelledby="zh-contract-reference-heading">
  <h2 id="zh-contract-reference-heading">契约</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/readme/reference/protocol">协议兼容范围</a>
      <p>请求路由、Response 存储、不支持的语义、模型控制和客户端证据。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/configuration">配置参考</a>
      <p>所有受支持的字段、默认值、环境变量、CLI 覆盖项、取值范围和文件位置。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/usage">用量与上下文</a>
      <p>区分实测、估算和未知用量字段，以及 cache、reasoning 与 context 统计。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/zuno-stream-errors">Zuno 流错误交接</a>
      <p>Provider 与 Zuno 之间的流错误语义、terminal evidence 和恢复边界。</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="zh-implementation-reference-heading">
  <h2 id="zh-implementation-reference-heading">实现与证据</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/reference/architecture">架构说明（英文）</a>
      <p>Ingress、协议契约、native/stateless 通道、调度、存储、回放和生命周期。</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/streaming-errors">流错误契约（英文）</a>
      <p>故障阶段、重试因果、terminal event、取消、超时与清理行为。</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/historical-tools">历史工具契约（英文）</a>
      <p>如何回放已存储的工具身份，同时避免把历史声明当成本轮调用授权。</p>
    </li>
    <li class="kp-index-row">
      <a href="/audits/">审计索引</a>
      <p>带日期的协议、客户端、运行时、账号和发布验收记录。</p>
    </li>
  </ul>
</section>
