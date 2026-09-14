import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const launcher = resolve(import.meta.dir, "../scripts/kiroclaude");
const helper = resolve(import.meta.dir, "../scripts/kiroclaude-token");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    Bun.spawnSync(["sh", "-c", 'rm -r -- "$1"', "cleanup", root]);
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kiroclaude-test-"));
  roots.push(root);
  return root;
}

function providerConfig(root: string, mode = 0o600): string {
  const path = join(root, "provider.json");
  writeFileSync(path, JSON.stringify({ api_keys: ["  sk-provider-test  "] }), {
    mode,
  });
  chmodSync(path, mode);
  return path;
}

function fakeClaude(root: string): { executable: string; capture: string } {
  const executable = join(root, "claude-fake");
  const capture = join(root, "capture.json");
  writeFileSync(
    executable,
    `#!/bin/sh
python3 - "$KIROCLAUDE_TEST_CAPTURE" "$@" <<'PY'
import json, os, sys
path, *arguments = sys.argv[1:]
keys = [
  "CLAUDE_CONFIG_DIR", "KIRO_PROVIDER_CONFIG", "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "ENABLE_TOOL_SEARCH",
  "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_ENABLE_AWAY_SUMMARY",
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "ANTHROPIC_DEFAULT_FABLE_MODEL",
]
with open(path, "w", encoding="utf-8") as output:
    json.dump({"arguments": arguments, "env": {key: os.environ.get(key) for key in keys}}, output)
PY
`,
    { mode: 0o755 },
  );
  return { executable, capture };
}

function environment(root: string, fake: ReturnType<typeof fakeClaude>): Record<string, string> {
  return {
    ...process.env,
    HOME: root,
    KIROCLAUDE_CLAUDE_BIN: fake.executable,
    KIROCLAUDE_TEST_CAPTURE: fake.capture,
    KIROCLAUDE_PROVIDER_CONFIG: providerConfig(root),
    ANTHROPIC_API_KEY: "must-not-leak",
    ANTHROPIC_AUTH_TOKEN: "must-not-leak",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CODE_USE_MANTLE: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    ENABLE_TOOL_SEARCH: "true",
    ANTHROPIC_CUSTOM_HEADERS: "X-Unrelated: must-not-leak",
    CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "1",
    AWS_PROFILE: "must-not-leak",
    AWS_REGION: "must-not-leak",
    AWS_DEFAULT_REGION: "must-not-leak",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "must-not-leak",
  } as Record<string, string>;
}

describe("kiroclaude Linux scripts", () => {
  test("uses an isolated profile, apiKeyHelper, current beta features, and exact arguments", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const nativeSettings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(nativeSettings, '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}\n');
    const original = readFileSync(nativeSettings, "utf8");

    const result = Bun.spawnSync(["sh", launcher, "--print", "hello"], {
      env: environment(root, fake),
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
      env: Record<string, string | null>;
    };
    expect(capture.env.CLAUDE_CONFIG_DIR).toBe(join(root, ".kiroclaude"));
    expect(capture.env.KIRO_PROVIDER_CONFIG).toBe(join(root, "provider.json"));
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
      "ENABLE_TOOL_SEARCH",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]) {
      expect(capture.env[key]).toBeNull();
    }
    expect(capture.arguments.slice(-2)).toEqual(["--print", "hello"]);
    expect(capture.arguments[0]).toBe("--settings");
    const settings = JSON.parse(capture.arguments[1] as string) as {
      apiKeyHelper: string;
      model: string;
      effortLevel: string;
      ultracode: boolean;
      awaySummaryEnabled: boolean;
      modelPicker: {
        replaceBuiltInOptions: boolean;
        options: Array<{
          model: string;
          label: string;
          description: string;
          behavesAs: string;
        }>;
      };
      env: Record<string, string>;
    };
    expect(settings.apiKeyHelper).toBe(helper);
    expect(settings.model).toBe("opus");
    expect(settings.effortLevel).toBe("xhigh");
    expect(settings.ultracode).toBe(true);
    expect(settings.awaySummaryEnabled).toBe(false);
    expect(settings.modelPicker).toEqual({
      replaceBuiltInOptions: false,
      options: [
        {
          model: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          description: "Kiro GPT flagship",
          behavesAs: "claude-opus-5",
        },
        {
          model: "gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          description: "Kiro GPT balanced",
          behavesAs: "claude-opus-5",
        },
        {
          model: "gpt-5.6-luna",
          label: "GPT-5.6 Luna",
          description: "Kiro GPT efficient",
          behavesAs: "claude-opus-5",
        },
      ],
    });
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_CUSTOM_HEADERS: "X-Kiro-Output-Token-Limit-Mode: advisory",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    });
    expect(capture.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY).toBe("0");
    for (const key of [
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
    ]) {
      expect(capture.env[key]).toBeNull();
    }
    expect(settings.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
    expect(readFileSync(nativeSettings, "utf8")).toBe(original);
  });

  test("supports isolated endpoint and model overrides without appending /v1", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const env = {
      ...environment(root, fake),
      KIROCLAUDE_BASE_URL: "https://gateway.example.test",
      KIROCLAUDE_CONFIG_DIR: join(root, "isolated"),
      KIROCLAUDE_MODEL: "sonnet",
      KIROCLAUDE_EFFORT: "high",
      KIROCLAUDE_OPUS_MODEL: "opus-custom",
      KIROCLAUDE_SONNET_MODEL: "sonnet-custom",
      KIROCLAUDE_HAIKU_MODEL: "haiku-custom",
    };
    const result = Bun.spawnSync(["sh", launcher, "--model", "claude-sonnet-5", "task"], {
      env,
    });
    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
      env: Record<string, string | null>;
    };
    const settings = JSON.parse(capture.arguments[1] as string) as {
      model: string;
      effortLevel: string;
      ultracode: boolean;
      env: Record<string, string>;
    };
    expect(capture.env.CLAUDE_CONFIG_DIR).toBe(join(root, "isolated"));
    expect(settings.model).toBe("sonnet");
    expect(settings.effortLevel).toBe("high");
    expect(settings.ultracode).toBe(false);
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-custom");
    expect(capture.arguments.slice(-3)).toEqual(["--model", "claude-sonnet-5", "task"]);
  });

  test("offers Fable 5.1 through an isolated native Bedrock backend", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const result = Bun.spawnSync(["sh", launcher, "--bedrock-fable", "--print", "hello"], {
      env: {
        ...environment(root, fake),
        KIROCLAUDE_TOKEN_HELPER: join(root, "missing-helper"),
        KIROCLAUDE_PROVIDER_CONFIG: join(root, "missing-provider.json"),
      },
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
      env: Record<string, string | null>;
    };
    const settings = JSON.parse(capture.arguments[1] as string) as {
      apiKeyHelper?: string;
      model: string;
      effortLevel: string;
      ultracode: boolean;
      awaySummaryEnabled: boolean;
      modelPicker: {
        replaceBuiltInOptions: boolean;
        options: Array<Record<string, string>>;
      };
      env: Record<string, string>;
    };

    expect(capture.env.CLAUDE_CONFIG_DIR).toBe(join(root, ".kiroclaude-fable"));
    expect(capture.env.KIRO_PROVIDER_CONFIG).toBeNull();
    expect(capture.env.ANTHROPIC_BASE_URL).toBeNull();
    expect(capture.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(capture.env.AWS_PROFILE).toBe("us-claude");
    expect(capture.env.AWS_REGION).toBe("us-east-2");
    expect(capture.env.AWS_DEFAULT_REGION).toBe("us-east-2");
    expect(capture.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("us.anthropic.claude-fable-5-1");
    expect(settings).not.toHaveProperty("apiKeyHelper");
    expect(settings).toMatchObject({
      model: "fable",
      effortLevel: "max",
      ultracode: false,
      awaySummaryEnabled: false,
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [
          {
            model: "fable",
            label: "Claude Fable 5.1 (Bedrock)",
          },
        ],
      },
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "us-claude",
        AWS_REGION: "us-east-2",
        AWS_DEFAULT_REGION: "us-east-2",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "us.anthropic.claude-fable-5-1",
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      },
    });
    expect(capture.arguments.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("helper emits only the first valid key from an owner-only config", () => {
    const root = temporaryRoot();
    const path = providerConfig(root);
    const result = Bun.spawnSync([helper], {
      env: { ...process.env, KIRO_PROVIDER_CONFIG: path },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("sk-provider-test\n");
    expect(result.stderr.toString()).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("helper failures are clear and prevent the client from sending a request", () => {
    const root = temporaryRoot();
    const path = providerConfig(root, 0o644);
    const direct = Bun.spawnSync([helper], {
      env: { ...process.env, KIRO_PROVIDER_CONFIG: path },
    });
    expect(direct.exitCode).toBe(1);
    expect(direct.stderr.toString()).toContain("permissions must be 0600");

    const requestMarker = join(root, "request-sent");
    const fake = join(root, "claude-helper-probe");
    writeFileSync(
      fake,
      `#!/usr/bin/env python3
import json, os, subprocess, sys
arguments = sys.argv[1:]
settings = json.loads(arguments[arguments.index("--settings") + 1])
result = subprocess.run(settings["apiKeyHelper"], shell=True, env=os.environ, text=True, capture_output=True)
if result.returncode != 0:
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)
open(os.environ["KIROCLAUDE_REQUEST_MARKER"], "w").write("sent")
`,
      { mode: 0o755 },
    );
    const missing = join(root, "missing.json");
    const result = Bun.spawnSync(["sh", launcher, "--print", "hello"], {
      env: {
        ...process.env,
        HOME: root,
        KIROCLAUDE_CLAUDE_BIN: fake,
        KIROCLAUDE_PROVIDER_CONFIG: missing,
        KIROCLAUDE_REQUEST_MARKER: requestMarker,
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("cannot read a valid provider API key");
    expect(Bun.file(requestMarker).size).toBe(0);
  });

  test("rejects a base URL with /v1 before starting Claude", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const result = Bun.spawnSync(["sh", launcher], {
      env: {
        ...environment(root, fake),
        KIROCLAUDE_BASE_URL: "http://127.0.0.1:8787/v1",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("gateway root");
  });

  test("rejects unknown backends and effort modes before starting Claude", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const badBackend = Bun.spawnSync(["sh", launcher], {
      env: { ...environment(root, fake), KIROCLAUDE_BACKEND: "myopenai" },
    });
    expect(badBackend.exitCode).toBe(1);
    expect(badBackend.stderr.toString()).toContain("unsupported backend");

    const badEffort = Bun.spawnSync(["sh", launcher], {
      env: { ...environment(root, fake), KIROCLAUDE_EFFORT: "extreme" },
    });
    expect(badEffort.exitCode).toBe(1);
    expect(badEffort.stderr.toString()).toContain("unsupported effort");
  });
});
