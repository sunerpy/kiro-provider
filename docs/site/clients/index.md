---
title: Choose a client
description: Pick the kiro-provider integration that matches your agent or SDK.
aside: false
---

# Choose a client

Use the protocol the client already speaks. Transport selection between native KiroRuntime Responses and the stateless adapter remains a gateway concern.

<section class="kp-index-section" aria-labelledby="client-guides-heading">
  <h2 id="client-guides-heading">Agent guides</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/clients/codex">Codex CLI</a>
      <p>OpenAI Responses through an isolated custom provider, with real-client coverage for tools, recovery, compaction, Ultra reasoning, and collaboration.</p>
    </li>
    <li class="kp-index-row">
      <a href="/clients/claude-code">Claude Code</a>
      <p>Anthropic Messages through an isolated profile with explicit model-picker, signed-thinking, token-limit, and Bedrock fallback boundaries.</p>
    </li>
    <li class="kp-index-row">
      <a href="/clients/zuno">Zuno</a>
      <p>Native OpenAI provider configuration with stable session metadata, stored continuation, and account-affinity guidance.</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="other-clients-heading">
  <h2 id="other-clients-heading">Other clients</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/reference/protocol">Responses or Messages SDK</a>
      <p>Start with the protocol contract, then use the loopback base URL and your private gateway key. Unsupported semantics fail with typed errors.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/configuration">Legacy Chat Completions</a>
      <p>Enable only when a client supports neither primary API. The route is disabled by default through <code>enable_legacy_chat_completions</code>.</p>
    </li>
  </ul>
</section>
