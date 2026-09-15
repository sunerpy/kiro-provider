---
title: Reference
description: Protocol, configuration, architecture, usage, and replay contracts for kiro-provider.
aside: false
---

# Reference

These pages define the current gateway contract. Dated audits record how a claim was verified; they do not replace the current reference.

<section class="kp-index-section" aria-labelledby="contract-reference-heading">
  <h2 id="contract-reference-heading">Contract</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/reference/protocol">Protocol compatibility</a>
      <p>Request routing, stored Responses, unsupported semantics, model controls, and client evidence.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/configuration">Configuration</a>
      <p>Every supported field, default, environment variable, CLI override, range, and file location.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/usage">Usage and context</a>
      <p>Measured, estimated, and unknown usage fields, cache counts, reasoning counts, and context accounting.</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="implementation-reference-heading">
  <h2 id="implementation-reference-heading">Implementation</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/reference/architecture">Architecture</a>
      <p>Ingress, protocol contracts, native and stateless lanes, scheduling, storage, replay, and lifecycle.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/streaming-errors">Streaming errors</a>
      <p>Failure phases, retry causality, terminal events, cancellation, timeout, and cleanup behavior.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/historical-tools">Historical tools</a>
      <p>How stored tool identity is replayed without authorizing a tool call on the current turn.</p>
    </li>
    <li class="kp-index-row">
      <a href="/audits/">Audit index</a>
      <p>Dated protocol, client, runtime, account, and release validation records.</p>
    </li>
  </ul>
</section>
