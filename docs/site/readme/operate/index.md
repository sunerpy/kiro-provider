---
title: 运维 kiro-provider
description: 让本地网关保持健康、可观察并且可以恢复。
aside: false
---

# 运维 kiro-provider

每个系统用户只运行一个凭据所有者。分别检查进程健康与带鉴权的就绪状态，并从结构化状态诊断，不要盲目重试请求。

<section class="kp-index-section" aria-labelledby="zh-operate-guides-heading">
  <h2 id="zh-operate-guides-heading">运行</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/readme/operate/service">后台服务</a>
      <p>安装固定版本的二进制，配置 systemd 或 Windows 计划任务，定位日志并设置启动与就绪门禁。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/configuration">配置参考</a>
      <p>查看配置优先级、路径、账号维护、超时、代理、协议开关和存储控制。</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="zh-diagnose-guides-heading">
  <h2 id="zh-diagnose-guides-heading">诊断</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/readme/operate/troubleshooting">排障手册</a>
      <p>把现象映射到 HTTP error code、账号可用性、审计事件、原因和有边界的处置方式。</p>
    </li>
    <li class="kp-index-row">
      <a href="/readme/reference/zuno-stream-errors">Zuno 流错误交接</a>
      <p>区分发布前重试、已接受流故障、terminal evidence 和客户端可见的错误顺序。</p>
    </li>
    <li class="kp-index-row">
      <a href="/audits/">验收记录</a>
      <p>当结论依赖特定客户端、上游行为或发布版本时，查阅带日期的探测证据。</p>
    </li>
  </ul>
</section>
