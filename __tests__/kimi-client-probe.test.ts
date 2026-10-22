import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCandidateBridgeHandler,
  privateCandidatePathAllowed,
  readPrivateCandidateConfig,
  requirePrivateCandidateOwner,
  runKimiClientProbeOnPlatform,
} from "../scripts/probe-kimi-clients.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kimi-bridge-budget-"));
  roots.push(root);
  return {
    ledger: join(root, "ledger.json"),
    base: new URL("http://127.0.0.1:18787"),
    config: {
      port: 18787,
      api_keys: ["synthetic-candidate-key"],
      stream_max_attempts: 1,
      rate_limit_max_retries: 0,
      retry_empty_completion: false,
    },
  };
}
function request(extra: Record<string, unknown> = {}) {
  return new Request("http://fixture/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic-kimi-client-key",
      "content-type": "application/json",
      "x-kiro-output-token-limit-mode": "advisory",
    },
    body: JSON.stringify({
      model: "kimi-k3",
      output_config: { effort: "max" },
      thinking: { type: "adaptive" },
      tools: [],
      stream: true,
      max_tokens: 32000,
      messages: [{ role: "user", content: "Synthetic budget test" }],
      ...extra,
    }),
  });
}

test("the live bridge reserves one HTTP forward across concurrent body reads without networking", async () => {
  const { ledger, base, config } = fixture();
  let calls = 0;
  const handler = createCandidateBridgeHandler(base, config, ledger, async (url, init) => {
    calls++;
    expect(url.href).toBe("http://127.0.0.1:18787/v1/messages");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-candidate-key");
    expect(JSON.parse(readFileSync(ledger, "utf8")).phase).toBe("dispatch_started");
    await Promise.resolve();
    return new Response("event: message_stop\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const responses = await Promise.all([handler.fetch(request()), handler.fetch(request())]);
  await Promise.all(responses.map((response) => response.text()));
  expect(calls).toBe(1);
  expect(existsSync(`${ledger}.dispatch.lock`)).toBe(true);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect(handler.evidence.forwarded_requests).toBe(1);
});

test("the live bridge refuses a second process using the same dispatch ledger", async () => {
  const { ledger, base, config } = fixture();
  let calls = 0;
  const forward = async () => {
    calls++;
    return new Response("event: message_stop\ndata: {}\n\n");
  };
  const first = createCandidateBridgeHandler(base, config, ledger, forward);
  expect((await first.fetch(request())).status).toBe(200);
  const second = createCandidateBridgeHandler(base, config, ledger, forward);
  expect((await second.fetch(request())).status).toBe(409);
  expect(calls).toBe(1);
  expect(second.evidence.forwarded_requests).toBe(0);
});

test("an existing ledger cannot be overwritten even without a companion lock", async () => {
  const { ledger, base, config } = fixture();
  writeFileSync(ledger, '{"phase":"previous_evidence"}\n', { mode: 0o600 });
  let calls = 0;
  const handler = createCandidateBridgeHandler(base, config, ledger, async () => {
    calls++;
    return new Response("fixture");
  });
  expect((await handler.fetch(request())).status).toBe(409);
  expect(calls).toBe(0);
  expect(JSON.parse(readFileSync(ledger, "utf8")).phase).toBe("previous_evidence");
});

test("a safeguards capability probe is typed-rejected locally before the single HTTP forward", async () => {
  const { ledger, base, config } = fixture();
  let calls = 0;
  const handler = createCandidateBridgeHandler(base, config, ledger, async () => {
    calls++;
    return new Response("event: message_stop\ndata: {}\n\n");
  });
  const rejected = await handler.fetch(request({ safeguards: { synthetic: true } }));
  expect(rejected.status).toBe(400);
  expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
    code: "unsupported_parameter",
    param: "safeguards",
  });
  expect(calls).toBe(0);
  expect(existsSync(ledger)).toBe(false);
  expect((await handler.fetch(request())).status).toBe(200);
  expect(calls).toBe(1);
  expect(handler.evidence.local_capability_rejections).toBe(1);
  expect(handler.evidence.inbound_requests).toBe(2);
});

test("unsupported K3 temperature remains strict rather than being removed by the bridge", async () => {
  const { ledger, base, config } = fixture();
  let calls = 0;
  const handler = createCandidateBridgeHandler(base, config, ledger, async () => {
    calls++;
    return new Response();
  });
  const rejected = await handler.fetch(request({ temperature: 1 }));
  expect(rejected.status).toBe(400);
  expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
    code: "unsupported_parameter",
    param: "temperature",
  });
  expect(calls).toBe(0);
  expect(handler.evidence.forwarded_requests).toBe(0);
});

test("candidate fixtures reject production identity, links, and shared permissions", () => {
  const { ledger, config } = fixture();
  const path = join(dirname(ledger), "config.json"),
    alias = join(dirname(ledger), "alias.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  if (process.platform !== "linux") {
    expect(() => readPrivateCandidateConfig(path)).toThrow("kimi_client_probe_requires_linux");
    expect(() => readPrivateCandidateConfig(path, path)).toThrow(
      "kimi_client_probe_requires_linux",
    );
    return;
  }
  expect(readPrivateCandidateConfig(path, join(dirname(ledger), "absent.json")).port).toBe(18787);
  expect(() => readPrivateCandidateConfig(path, path)).toThrow("production_config_forbidden");
  symlinkSync(path, alias);
  expect(() => readPrivateCandidateConfig(alias)).toThrow("candidate_config_must_not_be_symlinked");
  rmSync(alias);
  linkSync(path, alias);
  expect(() => readPrivateCandidateConfig(path)).toThrow(
    "owner_only_regular_candidate_config_required",
  );
  rmSync(alias);
  chmodSync(path, 0o644);
  expect(() => readPrivateCandidateConfig(path)).toThrow(
    "owner_only_regular_candidate_config_required",
  );
  chmodSync(path, 0o600);
  chmodSync(dirname(path), 0o755);
  expect(() => readPrivateCandidateConfig(path)).toThrow("owner_only_candidate_directory_required");
});

test("all platforms exercise the Linux private-path and owner policy without filesystem assumptions", () => {
  expect(privateCandidatePathAllowed("/tmp/private/config.json", "/tmp")).toBe(true);
  expect(privateCandidatePathAllowed("/config/.cache/private/config.json", "/tmp")).toBe(true);
  for (const path of [
    "relative/config.json",
    "/tmp",
    "/tmp-other/config.json",
    "/tmp/private/../../etc/config.json",
    "/config/.cache-other/config.json",
  ]) {
    expect(privateCandidatePathAllowed(path, "/tmp")).toBe(false);
  }
  const facts = {
    ownerUid: 1000 as number | undefined,
    file: { regular: true, nlink: 1, mode: 0o600, uid: 1000 },
    directory: { directory: true, mode: 0o700, uid: 1000 },
  };
  expect(() => requirePrivateCandidateOwner(facts)).not.toThrow();
  for (const file of [
    { ...facts.file, regular: false },
    { ...facts.file, nlink: 2 },
    { ...facts.file, mode: 0o644 },
    { ...facts.file, uid: 1001 },
  ]) {
    expect(() => requirePrivateCandidateOwner({ ...facts, file })).toThrow(
      "owner_only_regular_candidate_config_required",
    );
  }
  expect(() => requirePrivateCandidateOwner({ ...facts, ownerUid: undefined })).toThrow(
    "owner_only_regular_candidate_config_required",
  );
  for (const directory of [
    { ...facts.directory, directory: false },
    { ...facts.directory, mode: 0o755 },
    { ...facts.directory, uid: 1001 },
  ]) {
    expect(() => requirePrivateCandidateOwner({ ...facts, directory })).toThrow(
      "owner_only_candidate_directory_required",
    );
  }
});

test("unsupported platform execution never invokes the client runner", async () => {
  let executions = 0;
  const execute = async () => {
    executions++;
    return "synthetic";
  };
  for (const platform of ["win32", "darwin", "freebsd"]) {
    await expect(runKimiClientProbeOnPlatform(platform, execute)).rejects.toThrow(
      "kimi_client_probe_requires_linux",
    );
  }
  expect(executions).toBe(0);
  expect(await runKimiClientProbeOnPlatform("linux", execute)).toBe("synthetic");
  expect(executions).toBe(1);
  if (process.platform !== "linux") {
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../scripts/probe-kimi-clients.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).not.toBe(0);
    expect(JSON.parse(child.stderr.toString())).toEqual({
      error: "kimi_client_probe_requires_linux",
    });
    expect(child.stdout.toString()).toBe("");
  }
});

test("the actual private-config reader refuses Windows before reading a fixture", () => {
  const { ledger, config } = fixture();
  const path = join(dirname(ledger), "config.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const module = pathToFileURL(join(import.meta.dir, "../scripts/probe-kimi-clients.ts")).href;
  const code = `
    const {readPrivateCandidateConfig} = await import(${JSON.stringify(module)});
    Object.defineProperty(process, "platform", {value: "win32"});
    try {
      readPrivateCandidateConfig(${JSON.stringify(path)}, ${JSON.stringify(join(dirname(ledger), "absent.json"))});
      console.log(JSON.stringify({rejected: false}));
    } catch (error) {
      console.log(JSON.stringify({rejected: error.message === "kimi_client_probe_requires_linux"}));
    }
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", code], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({ rejected: true });
});
