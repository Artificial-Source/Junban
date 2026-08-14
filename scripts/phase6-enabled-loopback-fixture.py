#!/usr/bin/env python3
"""Deterministic OpenAI-compatible TLS fixture for the Phase 6 enabled benchmark.

The fixture is a standalone process and must run outside the measured server
cgroup.  It intentionally binds only loopback, never logs requests, never
retains authorization values, and exposes only sanitized counters on a separate
loopback admin listener.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import ssl
import threading
import time
from collections import Counter
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

FIXTURE_VERSION = 1
OFFICIAL_HOST = "api.openai.com"
MODEL_ID = "phase6-benchmark-model"
TTS_BYTES = 1_048_576
STT_AUDIO_BYTES = 1_048_576
MAX_REQUEST_BYTES = 26 * 1024 * 1024
MAX_CHAT_REQUEST_BYTES = 2 * 1024 * 1024
FRAGMENT_PATTERN = (1, 2, 5, 3, 7, 4, 11)
TERMINALS = frozenset({"run_completed", "run_cancelled", "run_failed"})
MARKER_RE = re.compile(r"phase6:([a-z0-9_-]+:[a-z0-9_-]+)")


class FixtureError(RuntimeError):
    """Fail-closed fixture error."""


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def walk_strings(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, str):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            found.extend(walk_strings(item))
    elif isinstance(value, dict):
        for item in value.values():
            found.extend(walk_strings(item))
    return found


def scenario_from_body(value: Any) -> str:
    for text in reversed(walk_strings(value)):
        match = MARKER_RE.search(text)
        if match:
            return match.group(1)
    raise FixtureError("provider request omitted a benchmark scenario marker")


def response_event(event_type: str, **fields: Any) -> bytes:
    return b"data: " + json_bytes({"type": event_type, **fields}) + b"\n\n"


def completed_event() -> bytes:
    return response_event(
        "response.completed",
        response={"usage": {"input_tokens": 7, "output_tokens": 3}},
    )


def text_stream(text: str) -> bytes:
    # The non-ASCII text is deliberate: the fragment pattern splits UTF-8 codepoints.
    return b"".join(
        (
            response_event("response.created"),
            response_event("response.output_text.delta", delta=text),
            completed_event(),
            b"data: [DONE]\n\n",
        )
    )


def tool_stream(call_id: str, name: str, arguments: dict[str, Any]) -> bytes:
    arguments_json = json.dumps(arguments, separators=(",", ":"), ensure_ascii=False)
    return b"".join(
        (
            response_event("response.created"),
            response_event(
                "response.output_item.added",
                output_index=0,
                item={
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                },
            ),
            response_event(
                "response.function_call_arguments.done",
                output_index=0,
                arguments=arguments_json,
            ),
            completed_event(),
            b"data: [DONE]\n\n",
        )
    )


class FixtureState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.requests: Counter[str] = Counter()
        self.scenario_rounds: Counter[str] = Counter()
        self.active_connections = 0
        self.max_active_connections = 0
        self.authenticated_requests = 0
        self.fragment_writes = 0
        self.fragment_max_bytes = 0
        self.stt_audio_sizes: list[int] = []
        self.tts_response_sizes: list[int] = []
        self.quiesced: set[str] = set()
        self.errors: list[str] = []
        self.stop = threading.Event()

    def connection_opened(self) -> None:
        with self.changed:
            self.active_connections += 1
            self.max_active_connections = max(
                self.max_active_connections, self.active_connections
            )
            self.changed.notify_all()

    def connection_closed(self) -> None:
        with self.changed:
            self.active_connections -= 1
            if self.active_connections < 0:
                self.errors.append("negative active connection count")
                self.active_connections = 0
            self.changed.notify_all()

    def begin_request(self, route: str, authenticated: bool) -> None:
        with self.changed:
            self.requests[route] += 1
            if authenticated:
                self.authenticated_requests += 1
            self.changed.notify_all()

    def next_round(self, scenario: str) -> int:
        with self.changed:
            self.scenario_rounds[scenario] += 1
            return self.scenario_rounds[scenario]

    def fragments(self, sizes: list[int]) -> None:
        with self.changed:
            self.fragment_writes += len(sizes)
            if sizes:
                self.fragment_max_bytes = max(self.fragment_max_bytes, max(sizes))

    def mark_quiesced(self, scenario: str) -> None:
        with self.changed:
            self.quiesced.add(scenario)
            self.changed.notify_all()

    def fail(self, message: str) -> None:
        with self.changed:
            self.errors.append(message[:200])
            self.changed.notify_all()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "version": FIXTURE_VERSION,
                "requests": dict(sorted(self.requests.items())),
                "scenario_rounds": dict(sorted(self.scenario_rounds.items())),
                "active_connections": self.active_connections,
                "max_active_connections": self.max_active_connections,
                "authenticated_requests": self.authenticated_requests,
                "fragment_writes": self.fragment_writes,
                "fragment_max_bytes": self.fragment_max_bytes,
                "stt_audio_sizes": list(self.stt_audio_sizes),
                "tts_response_sizes": list(self.tts_response_sizes),
                "quiesced": sorted(self.quiesced),
                "errors": list(self.errors),
            }

    def wait_quiesced(self, scenario: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self.changed:
            while scenario not in self.quiesced:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.changed.wait(remaining)
            return True


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], state: FixtureState):
        self.state = state
        super().__init__(address, handler)


class QuietHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JunbanPhase6Fixture/1"
    sys_version = ""

    @property
    def state(self) -> FixtureState:
        return self.server.state  # type: ignore[attr-defined]

    def setup(self) -> None:
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.state.connection_opened()

    def finish(self) -> None:
        try:
            super().finish()
        finally:
            self.state.connection_closed()

    def log_message(self, _format: str, *_args: Any) -> None:
        # Requests can contain synthetic bearer material; logging is forbidden.
        return

    def _authenticated(self) -> bool:
        value = self.headers.get("Authorization", "")
        return value.startswith("Bearer ") and len(value) > len("Bearer ")

    def _official_host(self) -> bool:
        return self.headers.get("Host") == OFFICIAL_HOST

    def _read_body(self, ceiling: int) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise FixtureError("request omitted content-length")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise FixtureError("invalid content-length") from error
        if length < 0 or length > ceiling:
            raise FixtureError("request body exceeded fixture ceiling")
        body = self.rfile.read(length)
        if len(body) != length:
            raise FixtureError("request body was truncated")
        return body

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True

    def _send_fragmented(self, body: bytes, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        sizes: list[int] = []
        offset = 0
        index = 0
        while offset < len(body):
            size = min(FRAGMENT_PATTERN[index % len(FRAGMENT_PATTERN)], len(body) - offset)
            self.wfile.write(body[offset : offset + size])
            self.wfile.flush()
            sizes.append(size)
            offset += size
            index += 1
        self.state.fragments(sizes)
        self.close_connection = True

    def _error(self, status: int, message: str) -> None:
        self.state.fail(message)
        self._send(status, json_bytes({"error": {"code": "fixture_rejected"}}), "application/json")

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        route = urlsplit(self.path).path
        if route == "/__fixture/health":
            self.state.begin_request(route, False)
            if not self._official_host():
                self._error(HTTPStatus.BAD_REQUEST, "interception probe used an unexpected host")
                return
            self._send(HTTPStatus.OK, json_bytes({"status": "ok", "version": FIXTURE_VERSION}), "application/json")
            return
        authenticated = self._authenticated()
        self.state.begin_request(route, authenticated)
        if not self._official_host():
            self._error(HTTPStatus.BAD_REQUEST, "provider request used an unexpected host")
            return
        if not authenticated:
            self._error(HTTPStatus.UNAUTHORIZED, "provider request lacked bearer authorization")
            return
        if route == "/v1/models":
            self._send_fragmented(
                json_bytes(
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": MODEL_ID,
                                "object": "model",
                                "owned_by": "junban-benchmark",
                            }
                        ],
                    }
                ),
                "application/json",
            )
            return
        self._error(HTTPStatus.NOT_FOUND, f"unexpected GET route {route}")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        route = urlsplit(self.path).path
        authenticated = self._authenticated()
        self.state.begin_request(route, authenticated)
        if not self._official_host():
            self._error(HTTPStatus.BAD_REQUEST, "provider request used an unexpected host")
            return
        if not authenticated:
            self._error(HTTPStatus.UNAUTHORIZED, "provider request lacked bearer authorization")
            return
        try:
            if route == "/v1/responses":
                self._chat()
            elif route == "/v1/audio/transcriptions":
                self._transcription()
            elif route == "/v1/audio/speech":
                self._speech()
            else:
                self._error(HTTPStatus.NOT_FOUND, f"unexpected POST route {route}")
        except (FixtureError, json.JSONDecodeError) as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            self.close_connection = True

    def _chat(self) -> None:
        body = json.loads(self._read_body(MAX_CHAT_REQUEST_BYTES))
        if body.get("model") != MODEL_ID or body.get("stream") is not True:
            raise FixtureError("chat request model/stream contract mismatch")
        scenario = scenario_from_body(body)
        round_number = self.state.next_round(scenario)
        category, _, sample = scenario.partition(":")

        if category == "retry" and round_number == 1:
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            return
        if category == "timeout":
            # Event waiting, not a correctness sleep.  The production 60 s client
            # timeout closes this socket; the stop event is only a cleanup escape.
            self.connection.settimeout(65.0)
            try:
                while not self.state.stop.is_set():
                    data = self.connection.recv(1)
                    if not data:
                        break
            except (socket.timeout, OSError, ssl.SSLError):
                pass
            self.state.mark_quiesced(scenario)
            self.close_connection = True
            return
        if category == "midstream":
            partial = response_event("response.created") + response_event(
                "response.output_text.delta", delta="midstream-prefix-世"
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for byte in partial:
                self.wfile.write(bytes((byte,)))
                self.wfile.flush()
            self.state.fragments([1] * len(partial))
            self.close_connection = True
            return
        if category == "cancel":
            prefix = response_event("response.created") + response_event(
                "response.output_text.delta", delta="cancel-prefix-世"
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            for byte in prefix:
                self.wfile.write(bytes((byte,)))
                self.wfile.flush()
            self.state.fragments([1] * len(prefix))
            self.connection.settimeout(10.0)
            try:
                while not self.state.stop.is_set():
                    data = self.connection.recv(1)
                    if not data:
                        break
            except (socket.timeout, OSError, ssl.SSLError):
                pass
            self.state.mark_quiesced(scenario)
            try:
                self.connection.sendall(
                    response_event("response.output_text.delta", delta="STALE_AFTER_CANCEL")
                    + completed_event()
                )
            except OSError:
                pass
            self.close_connection = True
            return

        if category == "read" and round_number == 1:
            payload = tool_stream(f"read-{sample}", "list_projects", {})
        elif category == "reject" and round_number == 1:
            payload = tool_stream(
                f"reject-{sample}",
                "create_task",
                {"title": f"phase6-rejected-{sample}"},
            )
        elif category == "approve" and round_number == 1:
            payload = tool_stream(
                f"approve-{sample}",
                "create_task",
                {"title": f"phase6-approved-{sample}"},
            )
        else:
            payload = text_stream(f"fixture-complete-{scenario}-世")
        self._send_fragmented(payload, "text/event-stream")

    def _transcription(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        match = re.fullmatch(r"multipart/form-data; boundary=([A-Za-z0-9-]+)", content_type)
        if not match:
            raise FixtureError("transcription content type mismatch")
        boundary = match.group(1).encode("ascii")
        body = self._read_body(MAX_REQUEST_BYTES)
        file_header = b'name="file"'
        file_index = body.find(file_header)
        if file_index < 0:
            raise FixtureError("transcription omitted file part")
        audio_start = body.find(b"\r\n\r\n", file_index)
        if audio_start < 0:
            raise FixtureError("transcription file framing malformed")
        audio_start += 4
        suffix = b"\r\n--" + boundary + b"--\r\n"
        if not body.endswith(suffix):
            raise FixtureError("transcription closing boundary malformed")
        audio = body[audio_start : -len(suffix)]
        if len(audio) != STT_AUDIO_BYTES or not audio.startswith(b"P6STT:"):
            raise FixtureError("transcription audio was not the exact 1 MiB fixture")
        with self.state.changed:
            self.state.stt_audio_sizes.append(len(audio))
            self.state.changed.notify_all()
        marker = audio[:64].split(b"\0", 1)[0].decode("ascii", errors="strict")
        transcript = marker.replace("P6STT:", "phase6-transcript-")
        self._send_fragmented(json_bytes({"text": transcript}), "application/json")

    def _speech(self) -> None:
        body = json.loads(self._read_body(MAX_CHAT_REQUEST_BYTES))
        if body.get("model") != "tts-1" or body.get("voice") != "alloy":
            raise FixtureError("speech model/voice contract mismatch")
        if body.get("response_format") != "mp3" or not isinstance(body.get("input"), str):
            raise FixtureError("speech request shape mismatch")
        audio = b"ID3" + b"J" * (TTS_BYTES - 3)
        with self.state.changed:
            self.state.tts_response_sizes.append(len(audio))
            self.state.changed.notify_all()
        # Speech latency measures the production 1 MiB path, not hundreds of
        # thousands of artificial TLS records. Fragmentation authority belongs
        # to model JSON and the 30 UTF-8/SSE turns.
        self._send(HTTPStatus.OK, audio, "audio/mpeg")


class AdminHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JunbanPhase6FixtureAdmin/1"
    sys_version = ""

    @property
    def state(self) -> FixtureState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send_json(self, status: int, value: Any) -> None:
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/status":
            self._send_json(HTTPStatus.OK, self.state.snapshot())
            return
        if parsed.path == "/wait":
            query = parse_qs(parsed.query, strict_parsing=True)
            scenario = query.get("scenario", [""])[0]
            timeout_raw = query.get("timeout", ["5"])[0]
            try:
                timeout = min(70.0, max(0.0, float(timeout_raw)))
            except ValueError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"quiesced": False})
                return
            quiesced = self.state.wait_quiesced(scenario, timeout)
            self._send_json(HTTPStatus.OK, {"scenario": scenario, "quiesced": quiesced})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})


def self_check() -> None:
    expected = "phase6:short:p0-00"
    body = {"input": [{"content": [{"text": expected}]}]}
    assert scenario_from_body(body) == "short:p0-00"
    stream = text_stream("split-世界")
    assert stream.count(b"data: ") == 4
    assert b"response.output_text.delta" in stream
    assert len(b"ID3" + b"J" * (TTS_BYTES - 3)) == TTS_BYTES
    chunks: list[bytes] = []
    offset = 0
    index = 0
    while offset < len(stream):
        size = min(FRAGMENT_PATTERN[index % len(FRAGMENT_PATTERN)], len(stream) - offset)
        chunks.append(stream[offset : offset + size])
        offset += size
        index += 1
    assert b"".join(chunks) == stream
    assert max(map(len, chunks)) <= max(FRAGMENT_PATTERN)
    print("phase6 enabled loopback fixture self-check passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--admin-port", type=int, default=0)
    parser.add_argument("--ready-file", type=Path)
    parser.add_argument("--self-check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_check:
        self_check()
        return 0
    if args.cert is None or args.key is None or args.ready_file is None:
        raise FixtureError("--cert, --key, and --ready-file are required")
    if args.port != 0 and not 1024 <= args.port <= 65535:
        raise FixtureError("fixture port must be ephemeral or an unprivileged high port")
    state = FixtureState()
    tls_server = FixtureServer(("127.0.0.1", args.port), QuietHandler, state)
    tls_port = int(tls_server.server_address[1])
    if tls_port <= 1023:
        tls_server.server_close()
        raise FixtureError("fixture unexpectedly acquired a privileged port")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)

    def require_official_sni(
        _socket: ssl.SSLSocket, server_name: str | None, _context: ssl.SSLContext
    ) -> None:
        if server_name != OFFICIAL_HOST:
            raise ssl.SSLError("fixture rejected unexpected TLS server name")

    context.set_servername_callback(require_official_sni)
    tls_server.socket = context.wrap_socket(tls_server.socket, server_side=True)
    admin_server = FixtureServer(("127.0.0.1", args.admin_port), AdminHandler, state)

    def stop(_signum: int, _frame: Any) -> None:
        state.stop.set()
        threading.Thread(target=tls_server.shutdown, daemon=True).start()
        threading.Thread(target=admin_server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    tls_thread = threading.Thread(target=tls_server.serve_forever, daemon=True)
    admin_thread = threading.Thread(target=admin_server.serve_forever, daemon=True)
    tls_thread.start()
    admin_thread.start()
    ready = {
        "version": FIXTURE_VERSION,
        "pid": os.getpid(),
        "tls_address": f"127.0.0.1:{tls_port}",
        "admin_address": f"127.0.0.1:{admin_server.server_address[1]}",
        "official_host": OFFICIAL_HOST,
    }
    fd = os.open(args.ready_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(ready, handle, sort_keys=True)
        handle.write("\n")
    state.stop.wait()
    tls_server.shutdown()
    admin_server.shutdown()
    tls_server.server_close()
    admin_server.server_close()
    tls_thread.join(timeout=5)
    admin_thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FixtureError, OSError, ssl.SSLError) as error:
        print(f"fixture failed: {error}", file=os.sys.stderr)
        raise SystemExit(2)
