---
layout: home
title: kiro-provider documentation
titleTemplate: false
description: Run your AWS Kiro accounts behind OpenAI Responses and Anthropic Messages APIs.
hero:
  name: kiro-provider
  text: Your Kiro accounts. Standard agent APIs.
  tagline: Run one local gateway for Codex, Claude Code, Zuno, and SDKs that speak OpenAI Responses or Anthropic Messages.
  actions:
    - theme: brand
      text: Start in five minutes
      link: /quick-start
    - theme: alt
      text: Choose a client
      link: /clients/
---

<div class="kp-index" aria-label="Documentation index">
  <section class="kp-index-section" aria-labelledby="start-heading">
    <h2 id="start-heading">Start</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/quick-start">Quick start</a>
        <p>Install the gateway, sign in to Kiro, verify readiness, and complete the first Responses request.</p>
      </li>
      <li class="kp-index-row">
        <a href="/reference/configuration">Configuration</a>
        <p>Set authentication, ports, timeouts, protocol projection, proxying, and account behavior.</p>
      </li>
      <li class="kp-index-row">
        <a href="/operate/service">Run as a service</a>
        <p>Operate one pinned, long-lived provider per OS user with explicit health and readiness gates.</p>
      </li>
    </ul>
  </section>
  <section class="kp-index-section" aria-labelledby="clients-heading">
    <h2 id="clients-heading">Connect</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/clients/codex">Codex CLI</a>
        <p>Use an isolated OpenAI Responses provider profile without changing your ordinary Codex state.</p>
      </li>
      <li class="kp-index-row">
        <a href="/clients/claude-code">Claude Code</a>
        <p>Use the Anthropic Messages surface through a separate Kiro profile, model picker, and token helper.</p>
      </li>
      <li class="kp-index-row">
        <a href="/clients/zuno">Zuno</a>
        <p>Configure the native OpenAI transport with stable session metadata and explicit compatibility boundaries.</p>
      </li>
    </ul>
  </section>
  <section class="kp-index-section" aria-labelledby="understand-heading">
    <h2 id="understand-heading">Understand</h2>
    <ul class="kp-index-list">
      <li class="kp-index-row">
        <a href="/reference/protocol">Protocol compatibility</a>
        <p>See which requests use native Responses, which require stateless projection, and which fail closed.</p>
      </li>
      <li class="kp-index-row">
        <a href="/operate/troubleshooting">Troubleshooting</a>
        <p>Diagnose account health, quota, replay, proxy, stream, configuration, and lifecycle failures by symptom.</p>
      </li>
      <li class="kp-index-row">
        <a href="/audits/">Validation evidence</a>
        <p>Review dated real-client probes and regression evidence separately from the current operator contract.</p>
      </li>
    </ul>
  </section>
</div>
