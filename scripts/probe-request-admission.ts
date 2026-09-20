/**
 * Exercise a compiled gateway's upload admission without dispatching inference.
 * Run inside a bounded transient scope. Requires an isolated config and --confirm.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { defaultConfigPath } from "../src/config/paths.js";

function arg(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}
function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
function memory(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const field = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0) * 1024;
  return { rss_bytes: field("VmRSS"), peak_rss_bytes: field("VmHWM") };
}
function scopeMemory() {
  const group = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!group) return { available: false };
  const root = join("/sys/fs/cgroup", group);
  try {
    const events = readFileSync(join(root, "memory.events"), "utf8");
    return {
      available: true,
      max_bytes: readFileSync(join(root, "memory.max"), "utf8").trim(),
      peak_bytes: Number(readFileSync(join(root, "memory.peak"), "utf8").trim()),
      oom_kill: Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0),
    };
  } catch {
    return { available: false };
  }
}
async function main() {
  const configPath = arg("--config");
  const binary = arg("--binary");
  if (
    !Bun.argv.includes("--confirm") ||
    !configPath ||
    !binary ||
    resolve(configPath) === resolve(defaultConfigPath())
  )
    throw new Error("isolated_configuration_required");
  const config = loadConfig({ configPath, env: {} });
  if (
    config.host !== "127.0.0.1" ||
    config.port === 8787 ||
    config.port === 0 ||
    config.account_maintenance_enabled
  )
    throw new Error("isolated_configuration_required");
  const root = dirname(resolve(configPath));
  const cycles = Number(arg("--cycles") ?? "3");
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 5) throw new Error("invalid_cycle_bound");
  const out = join(root, "admission-probe.stdout");
  const audit = join(root, "admission-probe.stderr");
  writeFileSync(out, "", { mode: 0o600 });
  writeFileSync(audit, "", { mode: 0o600 });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("KIRO_PROVIDER_")),
  );
  const child = Bun.spawn([resolve(binary), "serve", "--config", resolve(configPath)], {
    env: { ...environment, XDG_CONFIG_HOME: root },
    stdout: Bun.file(out),
    stderr: Bun.file(audit),
  });
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { "Content-Type": "application/json", "x-api-key": config.api_keys[0] as string };
  const controllers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/ready`, {
          headers,
          signal: AbortSignal.timeout(500),
        });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("isolated_gateway_not_ready");
    const samples = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      const initial = memory(child.pid);
      const admitted = Math.min(
        config.max_inflight_requests,
        Math.floor(config.max_inflight_request_body_bytes / config.max_request_body_bytes),
      );
      const chunkBytes = Math.floor(config.max_request_body_bytes * 0.9);
      for (let i = 0; i < admitted; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        let sent = false;
        const chunk = new Uint8Array(chunkBytes).fill(32);
        const body = new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              if (!sent) {
                sent = true;
                stream.enqueue(chunk);
              }
            },
          },
          { highWaterMark: 0 },
        );
        pending.push(
          fetch(`${base}/v1/messages`, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }).then(
            async (response) => {
              await response.arrayBuffer();
              return response.status;
            },
            () => "aborted",
          ),
        );
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          records(audit)
            .filter((record) => record.event === "request_admission_acquired")
            .at(-1)?.active_requests === admitted
        )
          break;
        await Bun.sleep(50);
      }
      // Let each large partial upload reach the bounded reader before sampling.
      await Bun.sleep(250);
      const pressure = memory(child.pid);
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      const readiness = await fetch(`${base}/ready`, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
      const overflow = [];
      for (const path of ["/v1/messages", "/v1/responses", "/v1/messages/count_tokens"]) {
        const response = await fetch(base + path, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(1000),
        });
        const value = (await response.json()) as { error?: { type?: string; code?: string } };
        overflow.push({
          path,
          status: response.status,
          retry_after: response.headers.get("Retry-After"),
          type: value.error?.type,
          code: value.error?.code,
        });
      }
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      for (let attempt = 0; attempt < 100; attempt++) {
        const last = records(audit)
          .filter((record) => record.event === "request_admission_released")
          .at(-1);
        if (last?.active_requests === 0) break;
        await Bun.sleep(50);
      }
      const count = await fetch(`${base}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-fable-5-1",
          messages: [{ role: "user", content: "fixture" }],
        }),
        signal: AbortSignal.timeout(1000),
      });
      await count.arrayBuffer();
      const after = memory(child.pid);
      const auditRecords = records(audit);
      const released = auditRecords
        .filter((record) => record.event === "request_admission_released")
        .at(-1);
      const dispatches = auditRecords.filter(
        (record) =>
          record.event === "sdk_dispatch_started" ||
          record.event === "native_responses_dispatch_started",
      ).length;
      const passed =
        health.status === 200 &&
        readiness.status === 200 &&
        count.status === 200 &&
        overflow.every((response) => response.status === 503 && response.retry_after === "1") &&
        released?.active_requests === 0 &&
        released.reserved_body_bytes === 0 &&
        dispatches === 0;
      samples.push({
        cycle,
        passed,
        admitted_uploads: admitted,
        bytes_per_partial_upload: chunkBytes,
        request_limit: config.max_inflight_requests,
        aggregate_body_budget: config.max_inflight_request_body_bytes,
        initial,
        pressure,
        after,
        health_status: health.status,
        ready_status: readiness.status,
        overflow,
        post_cancel_count_status: count.status,
        remaining_requests: released?.active_requests,
        remaining_reserved_bytes: released?.reserved_body_bytes,
        sdk_dispatches: dispatches,
        scope_memory: scopeMemory(),
      });
      if (!passed) process.exitCode = 1;
      controllers.length = 0;
      pending.length = 0;
      await Bun.sleep(100);
    }
    console.log(
      JSON.stringify(
        {
          passed: samples.every((sample) => sample.passed),
          cycles,
          samples,
          scope_memory: scopeMemory(),
        },
        null,
        2,
      ),
    );
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
    if (child.exitCode === null) child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 10_000);
    await child.exited;
    clearTimeout(timeout);
  }
}
if (import.meta.main) {
  main().catch(() => {
    console.log(JSON.stringify({ passed: false, phase: "admission_probe_error" }));
    process.exitCode = 1;
  });
}
