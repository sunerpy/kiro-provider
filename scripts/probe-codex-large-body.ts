/** Synthetic large-image acceptance through a running isolated gateway and the installed Codex. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { defaultConfigPath } from "../src/config/paths.js";

const option = (name: string, fallback = ""): string => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const OLD_LIMIT = 10 * 1024 * 1024;
const IMAGE_COUNT = 14;
const MARKER = "LARGE_BODY_OK";

/** A real RGB PNG with deterministic synthetic pixels, not a padded data URL. */
function syntheticImage(): Buffer {
  const width = 512;
  const height = 384;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 123456789;
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 3 + 1);
    for (let x = 1; x <= width * 3; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw[offset + x] = seed & 255;
    }
  }
  const chunk = (kind: string, data: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    payload.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const configPath = resolve(option("--config", defaultConfigPath()));
  const endpoint = new URL(option("--endpoint", "http://127.0.0.1:18879/v1"));
  if (
    !process.argv.includes("--confirm-live") ||
    configPath === resolve(defaultConfigPath()) ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.port === "8787"
  )
    throw new Error("isolated_configuration_required");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    api_keys?: string[];
    account_maintenance_enabled?: boolean;
    port?: number;
  };
  if (
    !config.api_keys?.[0] ||
    config.account_maintenance_enabled !== false ||
    String(config.port) !== endpoint.port
  )
    throw new Error("isolated_configuration_required");
  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(cache, "kiro-codex-large-body-"));
  chmodSync(root, 0o700);
  const png = syntheticImage();
  const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
  const input: Record<string, unknown>[] = [
    { role: "user", content: "Inspect synthetic screenshots." },
  ];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    input.push({
      type: "function_call",
      call_id: `fixture_${i}`,
      name: "view_fixture",
      arguments: "{}",
    });
    input.push({
      type: "function_call_output",
      call_id: `fixture_${i}`,
      output: [{ type: "input_image", image_url: imageUrl }],
    });
  }
  input.push({
    role: "user",
    content: `Reply exactly ${MARKER}. These are synthetic noise fixtures; do not call tools.`,
  });
  const requestBody = JSON.stringify({
    model: "gpt-5.6-sol",
    input,
    tools: [],
    tool_choice: "none",
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  });
  const requestBytes = Buffer.byteLength(requestBody);
  if (requestBytes <= OLD_LIMIT) throw new Error("fixture_not_large_enough");
  if (option("--case", "all") !== "codex") {
    const response = await fetch(`${endpoint.href.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_keys[0]}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal: AbortSignal.timeout(240000),
    });
    const wire = await response.text();
    const events = wire
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    const completed = events.filter((event) => event.type === "response.completed");
    const text =
      completed[0]?.response?.output
        ?.flatMap(
          (item: { content?: { text?: string }[] }) =>
            item.content?.map((part) => part.text ?? "") ?? [],
        )
        .join("") ?? "";
    const historyOk = response.status === 200 && completed.length === 1 && text.trim() === MARKER;
    console.log(
      JSON.stringify({
        case: "historical_tool_images",
        status: response.status,
        request_bytes: requestBytes,
        image_count: IMAGE_COUNT,
        image_hash: hash(png),
        completion_count: completed.length,
        output_hash: hash(text),
        marker_match: text.trim() === MARKER,
        success: historyOk,
      }),
    );
    if (!historyOk) throw new Error("historical_image_generation_failed");
  }
  if (option("--case", "all") === "history") return;

  const paths: string[] = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    const path = join(root, `fixture-${i}.png`);
    await Bun.write(path, png);
    paths.push(path);
  }
  const clientRoot = join(root, "codex");
  mkdirSync(clientRoot, { mode: 0o700 });
  const catalogResponse = await fetch(`${endpoint.href.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${config.api_keys[0]}` },
    signal: AbortSignal.timeout(15000),
  });
  const catalog = (await catalogResponse.json()) as { models?: { slug?: string }[] };
  if (!catalogResponse.ok || !catalog.models?.some((model) => model.slug === "gpt-5.6-sol"))
    throw new Error("catalog_model_missing");
  const catalogPath = join(clientRoot, "models.json");
  await Bun.write(catalogPath, JSON.stringify({ models: catalog.models }));
  chmodSync(catalogPath, 0o600);
  const observed: {
    bytes: number;
    status: number;
    model: string;
    historical_images: number;
    error_code?: string;
    error_param?: string;
  }[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 40 * 1024 * 1024,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const bytes =
        request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
      const headers = new Headers(request.headers);
      headers.delete("host");
      const result = await fetch(`${endpoint.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: bytes,
        signal: request.signal,
      });
      if (url.pathname.endsWith("/responses") && bytes) {
        const sent = JSON.parse(new TextDecoder().decode(bytes));
        const model = sent.model;
        const historicalImages = Array.isArray(sent.input)
          ? sent.input.reduce(
              (count: number, item: { type?: string; output?: { type?: string }[] }) =>
                count +
                (item.type === "function_call_output" && Array.isArray(item.output)
                  ? item.output.filter((part) => part.type === "input_image").length
                  : 0),
              0,
            )
          : 0;
        const error = (
          result.ok
            ? undefined
            : await result
                .clone()
                .json()
                .catch(() => ({}))
        ) as { error?: { code?: string; param?: string } } | undefined;
        observed.push({
          bytes: bytes.length,
          status: result.status,
          model: typeof model === "string" ? model : "unknown",
          historical_images: historicalImages,
          error_code: error?.error?.code,
          error_param: error?.error?.param,
        });
      }
      return result;
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(
      [
        option("--codex-bin", "codex"),
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--color",
        "never",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_provider="large-body-fixture"',
        "-c",
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        "-c",
        `model_providers.large-body-fixture={name="Large body fixture",base_url="http://127.0.0.1:${proxy.port}/v1",wire_api="responses",env_key="KIRO_LARGE_BODY_PROBE_KEY",supports_websockets=false}`,
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'web_search="disabled"',
        "--",
        `This is a gateway image-history test. Use the native view_image tool exactly once for EACH of the following ${IMAGE_COUNT} PNG files. Every file is required; parallel calls are welcome. Do not use exec or another tool to read or transform them. The images are synthetic noise, so no analysis is needed. After all ${IMAGE_COUNT} view_image calls have returned, reply exactly ${MARKER}.\n${paths.join("\n")}`,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          TERM: "dumb",
          CODEX_HOME: clientRoot,
          CODEX_SQLITE_HOME: clientRoot,
          KIRO_LARGE_BODY_PROBE_KEY: config.api_keys[0],
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    timer = setTimeout(() => child?.kill("SIGKILL"), 600000);
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream))
      throw new Error("missing_child_pipes");
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await Bun.write(join(root, "codex.stderr"), stderr);
    chmodSync(join(root, "codex.stderr"), 0o600);
    const rows = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const messages = rows
      .filter((row) => row.type === "item.completed" && row.item?.type === "agent_message")
      .map((row) => String(row.item.text));
    const success =
      exitCode === 0 &&
      messages.some((value) => value.trim() === MARKER) &&
      observed.some(
        (row) =>
          row.bytes > OLD_LIMIT && row.status === 200 && row.historical_images >= IMAGE_COUNT,
      );
    console.log(
      JSON.stringify({
        case: "real_codex_images",
        exit_code: exitCode,
        request_count: observed.length,
        max_request_bytes: Math.max(0, ...observed.map((row) => row.bytes)),
        statuses: observed.map((row) => row.status),
        requests: observed,
        message_count: messages.length,
        marker_match: messages.some((value) => value.trim() === MARKER),
        stderr_bytes: Buffer.byteLength(stderr),
        diagnostic_root: root,
        success,
      }),
    );
    if (!success) throw new Error("real_codex_large_body_failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await proxy.stop(true);
  }
}

if (import.meta.main)
  await main().catch(() => {
    console.error(JSON.stringify({ success: false, error: "large_body_probe_failed" }));
    process.exitCode = 1;
  });
