import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const launcher = resolve(import.meta.dir, "../scripts/kiroclaude");
const helper = resolve(import.meta.dir, "../scripts/kiroclaude-token");
const roots: string[] = [];
const expectedHeaders = (directory = process.cwd()): string =>
  [
    "X-Kiro-Output-Token-Limit-Mode: advisory",
    "X-Kiro-Client-Normalization: claude-code-bash-v1",
    `X-Kiro-Working-Directory-Hash: ${createHash("sha256").update("kiro-provider-working-directory-v1\0").update(directory).digest("hex")}`,
  ].join("\n");

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
def merge(base, override):
    if isinstance(base, dict) and isinstance(override, dict):
        merged = dict(base)
        for key, value in override.items():
            merged[key] = merge(merged.get(key), value)
        return merged
    return override
native_settings = {}
config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.environ["HOME"], ".claude")
native_path = os.path.join(config_dir, "settings.json")
if os.path.isfile(native_path):
    with open(native_path, encoding="utf-8") as source:
        native_settings = json.load(source)
overlay = json.loads(arguments[arguments.index("--settings") + 1])
with open(path, "w", encoding="utf-8") as output:
    json.dump({
        "arguments": arguments,
        "env": {key: os.environ.get(key) for key in keys},
        "effectiveSettings": merge(native_settings, overlay),
    }, output)
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
    AWS_PROFILE: "shell-profile",
    AWS_REGION: "shell-region",
    AWS_DEFAULT_REGION: "shell-default-region",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "must-not-leak",
  } as Record<string, string>;
}

describe.skipIf(process.platform === "win32")("kiroclaude Linux scripts", () => {
  test("uses the probe-confirmed Sonnet fallback for small-fast requests while preserving custom pins", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const env = environment(root, fake);
    const defaults = Bun.spawnSync(["sh", launcher, "--print", "fixture"], { env });
    expect(defaults.exitCode).toBe(0);
    const captured = JSON.parse(readFileSync(fake.capture, "utf8")) as { arguments: string[] };
    const settings = JSON.parse(captured.arguments[1] as string) as {
      env: Record<string, string>;
      modelPicker: { options: Array<{ model: string }> };
      autoCompactWindow: number;
    };
    expect(settings.autoCompactWindow).toBe(1000000);
    expect(settings.env.CLAUDE_CODE_TOASTY_THIMBLE).toBe("0");
    expect(settings.env.CLAUDE_CODE_GENTLE_PARASOL).toBe("0");
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(expectedHeaders());
    // The built-in Opus row is the only Claude row the launcher pins per run, so
    // it carries the current flagship while Opus 5 stays an explicit picker row.
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5-5[1m]");
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5[1m]");
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("claude-fable-5-1[1m]");
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5[1m]");
    expect(settings.modelPicker.options.map((option) => option.model)).toEqual([
      "claude-opus-5[1m]",
      "gpt-5.6-sol[1m]",
      "gpt-5.6-terra[1m]",
      "gpt-5.6-luna[1m]",
    ]);
    const custom = Bun.spawnSync(["sh", launcher, "--print", "fixture"], {
      env: {
        ...env,
        KIROCLAUDE_OPUS_MODEL: "custom-opus",
        KIROCLAUDE_OPUS5_MODEL: "custom-opus5",
        KIROCLAUDE_SOL_MODEL: "custom-sol",
      },
    });
    expect(custom.exitCode).toBe(0);
    const overridden = JSON.parse(readFileSync(fake.capture, "utf8")) as { arguments: string[] };
    const customSettings = JSON.parse(overridden.arguments[1] as string) as typeof settings;
    expect(customSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("custom-opus");
    expect(customSettings.modelPicker.options[0]?.model).toBe("custom-opus5");
    expect(customSettings.modelPicker.options[1]?.model).toBe("custom-sol");
  });

  test("shares the native Claude home while applying process-local Kiro defaults", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const nativeSettings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".claude", "skills"));
    writeFileSync(join(root, ".claude", "skills", "shared-skill.md"), "shared\n");
    writeFileSync(
      nativeSettings,
      `${JSON.stringify({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "native-bedrock",
          AWS_REGION: "us-east-2",
          ANTHROPIC_DEFAULT_FABLE_MODEL: "native-fable",
        },
        permissions: {
          defaultMode: "manual",
          allow: ["Read"],
          deny: ["Bash(rm *)"],
        },
        enabledPlugins: { "typescript-lsp@claude-plugins-official": true },
        model: "fable",
        effortLevel: "low",
        tui: "fullscreen",
      })}\n`,
    );
    const original = readFileSync(nativeSettings, "utf8");

    const result = Bun.spawnSync(["sh", launcher, "--print", "hello"], {
      env: environment(root, fake),
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
      env: Record<string, string | null>;
      effectiveSettings: {
        enabledPlugins: Record<string, boolean>;
        tui: string;
        permissions: { defaultMode: string; allow: string[]; deny: string[] };
        env: Record<string, string>;
      };
    };
    expect(capture.env.CLAUDE_CONFIG_DIR).toBeNull();
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
      permissions?: { defaultMode: string };
      skipDangerousModePermissionPrompt?: boolean;
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
    expect(settings.effortLevel).toBe("max");
    expect(settings.ultracode).toBe(true);
    expect(settings).not.toHaveProperty("permissions");
    expect(settings).not.toHaveProperty("skipDangerousModePermissionPrompt");
    expect(settings.awaySummaryEnabled).toBe(false);
    expect(settings.modelPicker).toEqual({
      replaceBuiltInOptions: false,
      options: [
        {
          model: "claude-opus-5[1m]",
          label: "Claude Opus 5",
          description: "Kiro Claude previous flagship",
          behavesAs: "claude-opus-5",
        },
        {
          model: "gpt-5.6-sol[1m]",
          label: "GPT-5.6 Sol",
          description: "Kiro GPT flagship",
          behavesAs: "claude-opus-5",
        },
        {
          model: "gpt-5.6-terra[1m]",
          label: "GPT-5.6 Terra",
          description: "Kiro GPT balanced",
          behavesAs: "claude-opus-5",
        },
        {
          model: "gpt-5.6-luna[1m]",
          label: "GPT-5.6 Luna",
          description: "Kiro GPT efficient",
          behavesAs: "claude-opus-5",
        },
      ],
    });
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1[1m]",
      ANTHROPIC_CUSTOM_HEADERS: expectedHeaders(),
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      CLAUDE_CODE_USE_MANTLE: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
    });
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      expect(settings.env[key]).toBe("");
    }
    expect(capture.effectiveSettings.enabledPlugins).toEqual({
      "typescript-lsp@claude-plugins-official": true,
    });
    expect(capture.effectiveSettings.tui).toBe("fullscreen");
    expect(capture.effectiveSettings.permissions).toEqual({
      defaultMode: "manual",
      allow: ["Read"],
      deny: ["Bash(rm *)"],
    });
    expect(capture.effectiveSettings.env.CLAUDE_CODE_USE_BEDROCK).toBe("0");
    expect(capture.effectiveSettings.env.AWS_PROFILE).toBe("native-bedrock");
    expect(capture.effectiveSettings.env.AWS_REGION).toBe("us-east-2");
    expect(capture.effectiveSettings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(capture.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY).toBe("0");
    expect(capture.env.AWS_PROFILE).toBe("shell-profile");
    expect(capture.env.AWS_REGION).toBe("shell-region");
    expect(capture.env.AWS_DEFAULT_REGION).toBe("shell-default-region");
    expect(capture.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeNull();
    expect(settings.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
    expect(readFileSync(nativeSettings, "utf8")).toBe(original);
    expect(readFileSync(join(root, ".claude", "skills", "shared-skill.md"), "utf8")).toBe(
      "shared\n",
    );
  });

  test("supports isolated endpoint and model overrides without appending /v1", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const env = {
      ...environment(root, fake),
      CLAUDE_CONFIG_DIR: join(root, "native-custom"),
      KIROCLAUDE_BASE_URL: "https://gateway.example.test",
      KIROCLAUDE_CONFIG_DIR: join(root, "isolated"),
      KIROCLAUDE_MODEL: "sonnet",
      KIROCLAUDE_EFFORT: "high",
      KIROCLAUDE_OPUS_MODEL: "opus-custom",
      KIROCLAUDE_SONNET_MODEL: "sonnet-custom",
      KIROCLAUDE_HAIKU_MODEL: "haiku-custom",
      KIROCLAUDE_KIRO_FABLE_MODEL: "fable-custom",
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
      permissions?: { defaultMode: string };
      skipDangerousModePermissionPrompt?: boolean;
      env: Record<string, string>;
    };
    expect(capture.env.CLAUDE_CONFIG_DIR).toBe(join(root, "isolated"));
    expect(settings.model).toBe("sonnet");
    expect(settings.effortLevel).toBe("high");
    expect(settings.ultracode).toBe(false);
    expect(settings).not.toHaveProperty("permissions");
    expect(settings).not.toHaveProperty("skipDangerousModePermissionPrompt");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-custom");
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("haiku-custom");
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("fable-custom");
    expect(capture.arguments.slice(-3)).toEqual(["--model", "claude-sonnet-5", "task"]);
  });

  test("preserves an inherited native Claude config directory", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const nativeCustom = join(root, "native-custom");
    mkdirSync(nativeCustom);
    writeFileSync(join(nativeCustom, "settings.json"), '{"tui":"fullscreen"}\n');

    const result = Bun.spawnSync(["sh", launcher, "--print", "hello"], {
      env: {
        ...environment(root, fake),
        CLAUDE_CONFIG_DIR: nativeCustom,
      },
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      env: Record<string, string | null>;
      effectiveSettings: { tui: string };
    };
    expect(capture.env.CLAUDE_CONFIG_DIR).toBe(nativeCustom);
    expect(capture.effectiveSettings.tui).toBe("fullscreen");
  });

  test("offers Fable 5.1 through the shared native Bedrock backend", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({
        env: {
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_BASE_URL: "https://native-gateway.example.test",
          ANTHROPIC_BEDROCK_BASE_URL: "https://native-bedrock-gateway.example.test",
          ANTHROPIC_API_KEY: "native-key-must-not-survive",
        },
      })}\n`,
    );
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
      effectiveSettings: { env: Record<string, string> };
    };
    const settings = JSON.parse(capture.arguments[1] as string) as {
      apiKeyHelper?: string;
      model: string;
      effortLevel: string;
      ultracode: boolean;
      permissions?: { defaultMode: string };
      skipDangerousModePermissionPrompt?: boolean;
      awaySummaryEnabled: boolean;
      modelPicker: {
        replaceBuiltInOptions: boolean;
        options: Array<Record<string, string>>;
      };
      env: Record<string, string>;
    };

    expect(capture.env.CLAUDE_CONFIG_DIR).toBeNull();
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
        CLAUDE_CODE_USE_VERTEX: "0",
        CLAUDE_CODE_USE_FOUNDRY: "0",
        CLAUDE_CODE_USE_MANTLE: "0",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "",
        ANTHROPIC_BEDROCK_BASE_URL: "",
        ANTHROPIC_VERTEX_BASE_URL: "",
        ANTHROPIC_FOUNDRY_BASE_URL: "",
        ANTHROPIC_AWS_BASE_URL: "",
        AWS_PROFILE: "us-claude",
        AWS_REGION: "us-east-2",
        AWS_DEFAULT_REGION: "us-east-2",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "us.anthropic.claude-fable-5-1",
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      },
    });
    expect(settings).not.toHaveProperty("permissions");
    expect(settings).not.toHaveProperty("skipDangerousModePermissionPrompt");
    expect(capture.effectiveSettings.env.CLAUDE_CODE_USE_VERTEX).toBe("0");
    expect(capture.effectiveSettings.env.ANTHROPIC_BASE_URL).toBe("");
    expect(capture.effectiveSettings.env.ANTHROPIC_BEDROCK_BASE_URL).toBe("");
    expect(capture.effectiveSettings.env.ANTHROPIC_API_KEY).toBe("");
    expect(capture.arguments.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("allows an explicit safer permission mode without changing shared settings", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);
    const nativeSettings = join(root, ".claude", "settings.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(nativeSettings, '{"permissions":{"defaultMode":"bypassPermissions"}}\n');
    const original = readFileSync(nativeSettings, "utf8");

    const result = Bun.spawnSync(["sh", launcher, "--permission-mode", "plan", "task"], {
      env: {
        ...environment(root, fake),
        KIROCLAUDE_PERMISSION_MODE: "manual",
      },
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
      effectiveSettings: {
        permissions: { defaultMode: string };
        skipDangerousModePermissionPrompt: boolean;
      };
    };
    expect(capture.effectiveSettings.permissions.defaultMode).toBe("manual");
    expect(capture.effectiveSettings.skipDangerousModePermissionPrompt).toBe(false);
    expect(capture.arguments.slice(-3)).toEqual(["--permission-mode", "plan", "task"]);
    expect(readFileSync(nativeSettings, "utf8")).toBe(original);
  });

  test("enables bypassPermissions only through an explicit launcher override", () => {
    const root = temporaryRoot();
    const fake = fakeClaude(root);

    const result = Bun.spawnSync(["sh", launcher, "task"], {
      env: {
        ...environment(root, fake),
        KIROCLAUDE_PERMISSION_MODE: "bypassPermissions",
      },
    });

    expect(result.exitCode).toBe(0);
    const capture = JSON.parse(readFileSync(fake.capture, "utf8")) as {
      arguments: string[];
    };
    const settings = JSON.parse(capture.arguments[1] as string) as {
      permissions: { defaultMode: string };
      skipDangerousModePermissionPrompt: boolean;
    };
    expect(settings.permissions).toEqual({ defaultMode: "bypassPermissions" });
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
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

    const badPermission = Bun.spawnSync(["sh", launcher], {
      env: { ...environment(root, fake), KIROCLAUDE_PERMISSION_MODE: "danger-full-access" },
    });
    expect(badPermission.exitCode).toBe(1);
    expect(badPermission.stderr.toString()).toContain("unsupported permission mode");
  });
});
