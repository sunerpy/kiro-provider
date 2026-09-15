---
title: Operate kiro-provider
description: Keep one local gateway healthy, observable, and recoverable.
aside: false
---

# Operate kiro-provider

Run one credential owner per OS user. Verify process health and authenticated readiness separately, and diagnose from structured state rather than retrying requests blindly.

<section class="kp-index-section" aria-labelledby="operate-guides-heading">
  <h2 id="operate-guides-heading">Run</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/operate/service">Background service</a>
      <p>Install a pinned binary, configure systemd or Windows Task Scheduler, locate logs, and enforce startup and readiness gates.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/configuration">Configuration</a>
      <p>Review precedence, paths, account maintenance, timeouts, proxying, protocol switches, and storage controls.</p>
    </li>
  </ul>
</section>

<section class="kp-index-section" aria-labelledby="diagnose-guides-heading">
  <h2 id="diagnose-guides-heading">Diagnose</h2>
  <ul class="kp-index-list">
    <li class="kp-index-row">
      <a href="/operate/troubleshooting">Troubleshooting</a>
      <p>Map symptoms to HTTP error codes, account availability, audit events, causes, and bounded remedies.</p>
    </li>
    <li class="kp-index-row">
      <a href="/reference/streaming-errors">Streaming error contract</a>
      <p>Understand pre-publication retries, accepted-stream failures, terminal evidence, and client-visible error ordering.</p>
    </li>
    <li class="kp-index-row">
      <a href="/audits/">Validation evidence</a>
      <p>Use dated probe records when a claim depends on a specific client, upstream behavior, or released implementation.</p>
    </li>
  </ul>
</section>
