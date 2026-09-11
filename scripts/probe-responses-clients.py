#!/usr/bin/env python3
"""Run real Codex/Zuno clients against an explicitly supplied isolated provider."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request


CAPTURE = r"""
import { appendFileSync, writeFileSync } from "node:fs";
const base = process.env.FIDELITY_UPSTREAM;
const log = process.env.FIDELITY_CAPTURE;
const ready = process.env.FIDELITY_READY;
if (!base || !log || !ready) throw new Error("capture configuration missing");
const endpoint = new URL(base);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const injected = url.pathname.startsWith("/plan-injected/");
    const path = injected ? url.pathname.slice("/plan-injected".length) : url.pathname;
    let body = request.method === "POST" ? await request.text() : undefined;
    if (body && path.endsWith("/responses")) {
      const json = JSON.parse(body);
      const input = Array.isArray(json.input) ? json.input : [];
      const toolResult = input.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      const addTail = injected && toolResult;
      if (addTail) {
        input.push({role:"developer", content:"Continue in Plan mode. Do not modify files. Finish the response to the user's request."});
        body = JSON.stringify({...json, input});
      }
      const declarations = [...(json.tools ?? []), ...input.filter(item => item.type === "additional_tools").flatMap(item => item.tools ?? [])];
      const flattened = [];
      const visit = tools => { for (const tool of tools) { flattened.push(tool); if (tool.type === "namespace") visit(tool.tools ?? []); } };
      visit(declarations);
      appendFileSync(log, JSON.stringify({
        capture_version:2,
        model:json.model, store:json.store, stream:json.stream,
        requested_effort:json.reasoning?.effort,
        includes_encrypted_reasoning:(json.include ?? []).includes("reasoning.encrypted_content"),
        encrypted_input_items:input.filter(item => item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0).length,
        local_replay_items:input.filter(item => item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.startsWith("kr1_")).length,
        item_types:input.map(item => item.type ?? item.role),
        namespace_tools:flattened.filter(tool => tool.type === "namespace").length,
        custom_tools:flattened.filter(tool => tool.type === "custom").length,
        has_tool_result:toolResult, injected_tail:addTail,
        input_bytes:Buffer.byteLength(body)
      }) + "\n", {mode:0o600});
    }
    const upstream = await fetch(new URL(path + url.search, endpoint.origin), {
      method:request.method, headers:request.headers, body, signal:request.signal,
    });
    return new Response(upstream.body, {status:upstream.status, headers:upstream.headers});
  }
});
writeFileSync(ready, JSON.stringify({baseURL:`http://127.0.0.1:${server.port}/v1`}), {mode:0o600});
process.on("SIGTERM", () => {server.stop(true); process.exit(0)});
"""


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def events_from(text):
    events = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

def ledger_fixture(project, prefix):
    rows = [
        {"kind": "sale", "status": "posted", "amount_cents": 1347},
        {"kind": "sale", "status": "posted", "amount_cents": 8276},
        {"kind": "refund", "status": "posted", "amount_cents": 329},
        {"kind": "sale", "status": "pending", "amount_cents": 28000},
        {"kind": "sale", "status": "posted", "amount_cents": 2085},
        {"kind": "refund", "status": "posted", "amount_cents": 77},
        {"kind": "refund", "status": "voided", "amount_cents": 400},
    ]
    (project / "ledger.json").write_text(json.dumps(rows))
    total = sum(row["amount_cents"] * (1 if row["kind"] == "sale" else -1)
                for row in rows if row["status"] == "posted")
    return prefix + str(total)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--config", required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:18787/v1")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--codex-bin", default=shutil.which("codex"))
    parser.add_argument("--zuno-bin", default=shutil.which("zuno"))
    parser.add_argument("--clients", default="codex,zuno")
    parser.add_argument("--codex-state-root")
    parser.add_argument("--zuno-profile-dir", help="Read an existing profile and its global kiro-local provider; use isolated state and endpoint")
    parser.add_argument("--zuno-models", default="claude-opus-5")
    parser.add_argument("--zuno-variant")
    args = parser.parse_args()
    if not args.confirm:
        parser.error("live client inference requires --confirm")
    os.umask(0o077)
    parent = Path(args.work_dir).resolve()
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="clients-", dir=parent))
    api_key = json.loads(Path(args.config).read_text())["api_keys"][0]
    capture_path = root / "capture.jsonl"
    capture_script = root / "capture.ts"
    capture_script.write_text(CAPTURE)
    ready_path = root / "capture-ready.json"
    capture_log = (root / "capture.stderr").open("wb")
    proxy = subprocess.Popen(
        [shutil.which("bun"), str(capture_script)],
        env={**os.environ, "FIDELITY_UPSTREAM": args.endpoint,
             "FIDELITY_CAPTURE": str(capture_path), "FIDELITY_READY": str(ready_path),
             "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"},
        stdout=capture_log, stderr=capture_log, start_new_session=True,
    )
    results = []
    catalog_extensions = []
    clients = set(args.clients.split(","))
    try:
        for _ in range(100):
            if ready_path.exists():
                break
            if proxy.poll() is not None:
                raise RuntimeError("capture proxy exited")
            time.sleep(0.1)
        base_url = json.loads(ready_path.read_text())["baseURL"]

        def run(client, name, binary, command, env, project, token, marker=None):
            stdout = root / f"{name}.stdout"
            stderr = root / f"{name}.stderr"
            started = time.monotonic()
            before = len(capture_path.read_text().splitlines()) if capture_path.exists() else 0
            with stdout.open("wb") as out, stderr.open("wb") as err:
                child = subprocess.Popen([binary, *command], cwd=project, env=env,
                                         stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                         start_new_session=True)
                timed_out = False
                try:
                    child.wait(timeout=450)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    stop(child)
            text = stdout.read_text(errors="replace")
            nodes = list(walk(events_from(text)))
            commands = [node for node in nodes if node.get("type") == "command_execution"]
            tools = [node for node in nodes if node.get("type") in {"tool", "tool_dispatch_completed"}]
            failed = any(node.get(key) == 23 for node in nodes
                         for key in ["exit_code", "exitCode", "exit"])
            failed = failed or any(
                node.get("name") == "shell"
                and "exit 23" in node.get("title", "")
                and re.search(r"\(exit 23[,)]", node.get("output", ""))
                for node in tools)
            final = []
            zuno_text = {}
            for event in events_from(text):
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "text":
                    part = event.get("part", {})
                    final.append(part.get("text", "") if isinstance(part, dict) else "")
                    if isinstance(event.get("text"), str):
                        zuno_text.setdefault(event.get("step", 0), []).append(event["text"])
                item = event.get("item", {})
                if isinstance(item, dict) and item.get("type") == "agent_message":
                    final.append(item.get("text", ""))
            if zuno_text:
                final.append("".join(zuno_text[max(zuno_text)]))
            final_file = project / "last-message.txt"
            if final_file.exists():
                final.append(final_file.read_text())
            captured = [json.loads(line) for line in capture_path.read_text().splitlines()[before:]]
            marker_ok = marker is None or (marker.exists() and marker.read_text().strip() == token)
            result = {
                "client": client, "case": name, "exit_code": child.returncode,
                "timed_out": timed_out, "duration_s": round(time.monotonic() - started, 2),
                "final_marker": token in "\n".join(final), "file_marker": marker_ok,
                "command_events": len(commands), "tool_events": len(tools),
                "failure_23_observed": failed, "requests": len(captured),
                "tool_result_requests": sum(bool(row["has_tool_result"]) for row in captured),
                "namespace_requests": sum(row["namespace_tools"] > 0 for row in captured),
                "custom_tool_requests": sum(row["custom_tools"] > 0 for row in captured),
                "custom_call_requests": sum("custom_tool_call" in row["item_types"] for row in captured),
                "injected_tail_requests": sum(bool(row["injected_tail"]) for row in captured),
                "requested_efforts": sorted({row["requested_effort"] for row in captured if row.get("requested_effort")}),
                "requested_models": sorted({row["model"] for row in captured}),
                "reasoning_replay_requests": sum(bool(row["includes_encrypted_reasoning"]) for row in captured),
                "encrypted_input_items": sum(row["encrypted_input_items"] for row in captured),
                "local_replay_items": sum(row["local_replay_items"] for row in captured),
                "reasoning_events": sum(node.get("type") == "reasoning" for node in nodes),
                "stdout_sha256": hashlib.sha256(stdout.read_bytes()).hexdigest(),
                "stderr_sha256": hashlib.sha256(stderr.read_bytes()).hexdigest(),
            }
            action_ok = (failed if "recovery" in name else
                         result["custom_call_requests"] > 0 if "custom" in name else
                         result["injected_tail_requests"] > 0)
            result["passed"] = (child.returncode == 0 and result["final_marker"] and marker_ok
                                and result["tool_result_requests"] > 0 and bool(action_ok))
            results.append(result)
            Path(args.out).write_text(json.dumps({"schema_version": 1, "private_work_dir": str(root),
                                                 "isolated_catalog_extensions": catalog_extensions,
                                                 "results": results}, indent=2) + "\n")
            print(json.dumps(result), flush=True)

        if "codex" in clients:
            if args.codex_state_root:
                state_parent = Path(args.codex_state_root).resolve()
                state_parent.mkdir(parents=True, exist_ok=True)
                state = Path(tempfile.mkdtemp(prefix="fidelity-", dir=state_parent))
            else:
                state = root / "codex-state"
            project = root / "codex-project"
            state.mkdir(exist_ok=True)
            project.mkdir()
            (state / "config.toml").write_text(
                'model = "gpt-5.6-sol"\nmodel_provider = "localgw"\nmodel_reasoning_effort = "low"\n'
                'model_context_window = 1000000\n'
                '[model_providers.localgw]\nname = "Isolated fidelity gateway"\n'
                f'base_url = "{base_url}"\nenv_key = "LOCALGW_KEY"\nwire_api = "responses"\n')
            env = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG"}}
            env.update(CODEX_HOME=str(state), CODEX_SQLITE_HOME=str(root / "codex-sqlite"),
                       LOCALGW_KEY=api_key, NO_COLOR="1", TERM="dumb",
                       NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            prefix = "CODEX_FIDELITY_" + root.name.split("-")[-1] + "_"
            token = ledger_fixture(project, prefix)
            prompt = (
                "This is an isolated tool protocol test. Use your shell tool. First execute "
                "`sh -c 'exit 23'` as a separate call and observe the nonzero exit. Then recover "
                "by reading ledger.json and computing posted sales minus posted refunds, excluding every other status. "
                f"Write {prefix} followed by the computed integer total in cents to marker.txt and read it back. "
                "Finish by replying only with that file's content. Work only in the current directory. "
                "Do not delegate or use network tools.")
            run("codex", "codex-recovery", args.codex_bin,
                ["exec", "--skip-git-repo-check", "--json", "-o", "last-message.txt",
                 "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write", prompt],
                env, project, token, project / "marker.txt")
            (project / "last-message.txt").unlink(missing_ok=True)
            custom_token = "CODEX_CUSTOM_" + root.name.split("-")[-1]
            run("codex", "codex-custom", args.codex_bin,
                ["exec", "--skip-git-repo-check", "--json", "-o", "last-message.txt",
                 "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write",
                 "Use the apply_patch tool to create custom-marker.txt with exactly "
                 f"{custom_token} on one line. Read the file back, then reply with {custom_token}. "
                 "Keep all changes in this directory. Do not delegate or use network tools."],
                env, project, custom_token, project / "custom-marker.txt")

        if "zuno" in clients:
            profile = None
            source_config = None
            if args.zuno_profile_dir:
                profile_dir = Path(args.zuno_profile_dir).resolve()
                profile = json.loads((profile_dir / "zuno.json").read_text())
                source_config = json.loads((profile_dir.parent.parent / "zuno.json").read_text())
                if profile.get("preset") != "kiro-local" or "kiro-local" not in source_config.get("provider", {}):
                    raise RuntimeError("The supplied profile does not define kiro-local")
                configured = source_config["provider"]["kiro-local"]["models"]
                missing = [model for model in args.zuno_models.split(",") if model not in configured]
                if missing:
                    request = urllib.request.Request(
                        args.endpoint.rstrip("/") + "/models",
                        headers={"Authorization": "Bearer " + api_key})
                    with urllib.request.urlopen(request, timeout=30) as response:
                        catalog = {item["id"]: item for item in json.load(response)["data"]}
                    for model in missing:
                        entry = catalog.get(model)
                        if not entry:
                            raise RuntimeError(f"Model {model} is absent from both the profile and gateway catalog")
                        configured[model] = {
                            "name": entry.get("name", model),
                            "limit": {"context": entry["context_limit"], "output": entry["output_limit"]},
                            "modalities": entry.get("modalities", {"input": ["text"], "output": ["text"]}),
                            "reasoning": True, "tool_call": True,
                            "variants": {effort: {"reasoningEffort": effort}
                                         for effort in ["low", "medium", "high", "xhigh", "max"]
                                         if model + "-" + effort in catalog},
                        }
                        catalog_extensions.append(model)
            for model, plan in [(model, plan) for model in args.zuno_models.split(",") for plan in [False, True]]:
                name = ("zuno-plan-tail-" if plan else "zuno-recovery-") + model
                state = root / name
                project = state / "project"
                for directory in ["project", "home", "data", "config", "cache", "state", "tmp"]:
                    (state / directory).mkdir(parents=True, exist_ok=True)
                token = ("ZUNO_PLAN_" if plan else "ZUNO_FIDELITY_") + root.name.split("-")[-1]
                url = base_url.replace("/v1", "/plan-injected/v1") if plan else base_url
                provider_id = "kiro-local" if profile else "probe"
                config = {
                    "formatter": False, "lsp": False, "memory": False,
                    "model": f"probe/{model}", "small_model": f"probe/{model}",
                    "permission": {"mode": "allow_all"},
                    "provider": {"probe": {
                        "name": "Isolated fidelity gateway", "id": "probe", "env": [],
                        "transport": "openai", "surface": "responses",
                        "models": {model: {"id": model, "name": model, "attachment": False,
                                          "reasoning": True, "temperature": False, "tool_call": True,
                                          "release_date": "2026-09-10",
                                          "limit": {"context": 200000, "output": 32000},
                                          "cost": {"input": 0, "output": 0}, "options": {}}},
                        "options": {"baseURL": url, "extraBody": {"reasoning": {"effort": "low"}}}
                    }},
                }
                if profile is not None:
                    provider = source_config["provider"][provider_id]
                    config["provider"] = {
                        provider_id: {
                            **provider,
                            "options": {**provider.get("options", {}), "baseURL": url},
                        }
                    }
                    config["model"] = profile["model"]
                    config["small_model"] = profile["small_model"]
                    config["preset"] = profile["preset"]
                    config["presets"] = {"kiro-local": source_config["presets"]["kiro-local"]}
                    config_dir = state / "config" / "zuno"
                    config_dir.mkdir(exist_ok=True)
                    (config_dir / "zuno.json").write_text(json.dumps(config))
                env = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG"}}
                env.update(
                    ZUNO_TEST_HOME=str(state / "home"), XDG_DATA_HOME=str(state / "data"),
                    XDG_CONFIG_HOME=str(state / "config"), XDG_CACHE_HOME=str(state / "cache"),
                    XDG_STATE_HOME=str(state / "state"), TMPDIR=str(state / "tmp"),
                    ZUNO_DB=str(state / "data/zuno.db"), ZUNO_DISABLE_AUTOUPDATE="1",
                    ZUNO_DISABLE_MODELS_FETCH="1", ZUNO_DISABLE_PROJECT_CONFIG="1",
                    ZUNO_AUTH_CONTENT=json.dumps({provider_id: {"type": "api", "key": api_key}}),
                    ZUNO_CONFIG_CONTENT=json.dumps(config), NO_COLOR="1", TERM="dumb",
                    NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost",
                )
                if profile is not None:
                    # The user's profile is read unchanged. All writable state and the
                    # merged provider endpoint are in this run's private directory.
                    env["ZUNO_CONFIG_DIR"] = str(profile_dir)
                    env["ZUNO_KIRO_LOCAL_API_KEY"] = api_key
                if plan:
                    (project / "plan-input.txt").write_text(token + "\n")
                    prompt = ("Stay in Plan mode and do not modify files. Use the read tool to read "
                              "plan-input.txt, then reply with exactly its content. Do not delegate.")
                else:
                    prefix = token + "_"
                    token = ledger_fixture(project, prefix)
                    prompt = (
                        "This is an isolated tool protocol test. First use your shell tool to run "
                        "`sh -c 'exit 23'` as a separate call. Observe its nonzero exit, then recover "
                        "by reading ledger.json and computing posted sales minus posted refunds, excluding every other status. "
                        f"Write {prefix} followed by the computed integer total in cents to marker.txt and read it back. "
                        "Finish by replying only with that file's content. Work only here; do not delegate or use network tools.")
                run("zuno", name, args.zuno_bin,
                    ["run", "--format", "json", "--agent", "plan" if plan else "build",
                     *(["--variant", args.zuno_variant] if args.zuno_variant else []),
                     "--model", f"{provider_id}/{model}", "--title", name, "--sandbox", "read-only" if plan else "workspace-write", prompt],
                    env, project, token, None if plan else project / "marker.txt")
                if plan and (project / "plan-input.txt").read_text() != token + "\n":
                    raise RuntimeError("Plan fixture was modified")
    finally:
        stop(proxy)
        capture_log.close()
    if not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
