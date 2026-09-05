"""Sanitize mitmproxy flows before any request structure is inspected.

Run through mitmdump so the mitmproxy dependency remains temporary:

    KIRO_FLOW_REPORT=/tmp/kiro-flow-report.json \
      uvx --from mitmproxy mitmdump -nr /tmp/flows.mitm \
      -s scripts/kiro-cli-flow-sanitize.py

The report preserves endpoint and structural information only. Credentials,
signatures, identifiers, model-visible strings, and binary bodies are redacted
or replaced by length plus SHA-256.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from mitmproxy import http


SENSITIVE_KEY = re.compile(
    r"authorization|access.?token|refresh.?token|client.?secret|signature|"
    r"encrypted|credential|cookie",
    re.IGNORECASE,
)
ID_KEY = re.compile(
    r"(^|_)(id|conversationId|agentContinuationId|toolUseId|callId|profileArn)$",
    re.IGNORECASE,
)
TEXT_KEY = re.compile(
    r"content|text|innerContext|description|prompt|input|output",
    re.IGNORECASE,
)
NAME_KEY = re.compile(r"(^|_)(name|toolName)$", re.IGNORECASE)
SAFE_STRING_KEY = re.compile(
    r"^(modelId|model|origin|chatTriggerType|agentTaskType|agentMode|format|"
    r"status|type|role|stopReason)$"
)
SENSITIVE_HEADER = re.compile(
    r"authorization|cookie|token|signature|credential|x-amz-security-token",
    re.IGNORECASE,
)
SAFE_HEADER_VALUE = {
    "content-type",
    "content-encoding",
    "x-amz-target",
    "user-agent",
    "x-amz-user-agent",
    "x-amzn-kiro-client-attribution",
    "x-kiro-attempt",
    "accept",
    "accept-encoding",
    "transfer-encoding",
}


def hash16(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()[:16]


def summarize(label: str, value: str) -> str:
    encoded = value.encode("utf-8", errors="replace")
    return f"<{label}:chars={len(value)}:sha256={hash16(encoded)}>"


def sanitize(value: Any, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "<redacted>"
    if isinstance(value, bytes):
        return f"<bytes:length={len(value)}:sha256={hash16(value)}>"
    if isinstance(value, list):
        return [sanitize(item, key) for item in value]
    if isinstance(value, dict):
        return {
            str(child_key): sanitize(child, str(child_key))
            for child_key, child in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if not isinstance(value, str):
        return value
    if SAFE_STRING_KEY.fullmatch(key):
        return value
    if ID_KEY.search(key):
        return summarize("id", value)
    if NAME_KEY.search(key):
        return summarize("name", value)
    if TEXT_KEY.search(key):
        return summarize("text", value)
    return summarize("string", value)


def decoded_content(content: bytes | None, content_encoding: str) -> bytes:
    body = content or b""
    if content_encoding.lower() == "gzip":
        try:
            return gzip.decompress(body)
        except OSError:
            return body
    return body


def parse_body(body: bytes, content_type: str) -> Any:
    if not body:
        return None
    if "json" in content_type or body[:1] in {b"{", b"["}:
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    if "cbor" in content_type:
        try:
            import cbor2

            return cbor2.loads(body)
        except (ImportError, ValueError):
            pass
    return f"<opaque:length={len(body)}:sha256={hash16(body)}>"


def safe_headers(headers: http.Headers) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in sorted(headers.items(multi=True)):
        lowered = name.lower()
        if SENSITIVE_HEADER.search(lowered):
            rendered = "<redacted>"
        elif lowered in SAFE_HEADER_VALUE:
            rendered = value
        else:
            rendered = summarize("header", value)
        result[lowered] = rendered
    return result


def safe_url(url: str) -> dict[str, Any]:
    parsed = urlsplit(url)
    query: dict[str, str] = {}
    for name, value in parse_qsl(parsed.query, keep_blank_values=True):
        query[name] = sanitize(value, name)
    return {
        "scheme": parsed.scheme,
        "host": parsed.hostname,
        "port": parsed.port,
        "path": parsed.path,
        "query": query,
    }


class FlowSanitizer:
    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self.marker = os.environ.get(
            "KIRO_SYNTHETIC_MARKER",
            "KIRO_NATIVE_WIRE_CAPTURE_B72E",
        ).encode()

    def request(self, flow: http.HTTPFlow) -> None:
        body = decoded_content(
            flow.request.raw_content,
            flow.request.headers.get("content-encoding", ""),
        )
        content_type = flow.request.headers.get("content-type", "").lower()
        response_body = decoded_content(
            flow.response.raw_content if flow.response else None,
            flow.response.headers.get("content-encoding", "") if flow.response else "",
        )
        response_content_type = (
            flow.response.headers.get("content-type", "").lower() if flow.response else ""
        )
        self.entries.append(
            {
                "method": flow.request.method,
                "url": safe_url(flow.request.pretty_url),
                "request_headers": safe_headers(flow.request.headers),
                "request_body_length": len(body),
                "request_body_sha256": hashlib.sha256(body).hexdigest(),
                "synthetic_marker_present": self.marker in body,
                "request_body": sanitize(parse_body(body, content_type)),
                "response_status": flow.response.status_code if flow.response else None,
                "response_content_type": response_content_type or None,
                "response_body_length": len(response_body),
                "response_body_sha256": hashlib.sha256(response_body).hexdigest(),
                "response_body": sanitize(parse_body(response_body, response_content_type)),
            }
        )

    def done(self) -> None:
        output = Path(os.environ["KIRO_FLOW_REPORT"])
        output.parent.mkdir(parents=True, exist_ok=True)
        rendered = json.dumps(
            {
                "schema_version": 1,
                "flow_count": len(self.entries),
                "flows": self.entries,
            },
            indent=2,
            sort_keys=True,
        )
        output.write_text(f"{rendered}\n", encoding="utf-8")
        output.chmod(0o600)


addons = [FlowSanitizer()]
