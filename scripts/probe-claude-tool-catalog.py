"""Compare --claude PATH clients against a loopback fixture, without inference."""

import argparse
import http.server
import json
import os
from pathlib import Path
import subprocess
import re
import tempfile
import threading


class Fixture(http.server.BaseHTTPRequestHandler):
    observations = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 8 * 1024 * 1024:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(length))
        if "count_tokens" in self.path:
            data = b'{"input_tokens":10}'
            content_type = "application/json"
        elif self.path.startswith("/v1/messages"):
            names = {tool.get("name") for tool in body.get("tools", [])}
            self.observations.append(
                {
                    "tool_count": len(names),
                    "TaskOutput_declared": "TaskOutput" in names,
                    "TaskStop_declared": "TaskStop" in names,
                    "gettask_declared": "gettask" in names,
                    "stream": body.get("stream", False),
                }
            )
            message = {
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            }
            if body.get("stream"):
                events = [
                    ("message_start", {"type": "message_start", "message": message}),
                    (
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": 0,
                            "content_block": {"type": "text", "text": ""},
                        },
                    ),
                    (
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": {"type": "text_delta", "text": "FIXTURE_OK"},
                        },
                    ),
                    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                    (
                        "message_delta",
                        {
                            "type": "message_delta",
                            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                            "usage": {"output_tokens": 1},
                        },
                    ),
                    ("message_stop", {"type": "message_stop"}),
                ]
                data = "".join(
                    f"event: {name}\ndata: {json.dumps(value)}\n\n"
                    for name, value in events
                ).encode()
                content_type = "text/event-stream"
            else:
                message.update(
                    content=[{"type": "text", "text": "FIXTURE_OK"}],
                    stop_reason="end_turn",
                )
                data = json.dumps(message).encode()
                content_type = "application/json"
        else:
            data = b"{}"
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--claude", action="append", required=True, help="Installed Claude executable")
arguments = parser.parse_args()
if len(arguments.claude) > 4:
    parser.error("at most four client binaries may be probed per run")

with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture) as server:
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    results = []
    try:
        for selected in arguments.claude:
            binary = Path(selected).resolve(strict=True)
            identification = subprocess.run(
                [str(binary), "--version"], capture_output=True, text=True, timeout=15
            )
            match = re.search(r"\b\d+\.\d+\.\d+\b", identification.stdout)
            version = match.group(0) if match else "unknown"
            with tempfile.TemporaryDirectory(prefix="kiro-client-catalog-fixture-") as root:
                # Build a small environment, excluding inherited auth/provider settings.
                env = {
                    key: value
                    for key, value in os.environ.items()
                    if key in ["PATH", "HOME", "LANG", "TERM", "TMPDIR"]
                }
                env.update(
                    CLAUDE_CONFIG_DIR=root,
                    ANTHROPIC_BASE_URL=f"http://127.0.0.1:{server.server_port}",
                    ANTHROPIC_API_KEY="synthetic-fixture-key",
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                    DISABLE_AUTOUPDATER="1",
                    NO_PROXY="127.0.0.1,localhost",
                )
                Fixture.observations = []
                try:
                    completed = subprocess.run(
                        [
                            str(binary),
                            "--print",
                            "--model",
                            "claude-fable-5-1",
                            "--setting-sources",
                            "",
                            "--strict-mcp-config",
                            "--mcp-config",
                            '{"mcpServers":{}}',
                            "--no-session-persistence",
                            "--system-prompt",
                            "Synthetic fixture. Reply with plain text; never execute tools.",
                            "Reply FIXTURE_OK",
                        ],
                        cwd=root,
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    results.append(
                        {
                            "version": version,
                            "exit_code": completed.returncode,
                            "fixture_ok": "FIXTURE_OK" in completed.stdout,
                            "stderr_bytes": len(completed.stderr.encode()),
                            "requests": Fixture.observations,
                        }
                    )
                except subprocess.TimeoutExpired:
                    results.append(
                        {
                            "version": version,
                            "timeout": True,
                            "requests": Fixture.observations,
                        }
                    )
    finally:
        server.shutdown()
        worker.join(timeout=2)
    print(json.dumps(results, indent=2))
