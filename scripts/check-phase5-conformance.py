#!/usr/bin/env python3
"""Phase 5 cross-surface conformance harness (junban-phase5-conformance-v1).

Runs the frozen 17-revision corpus against four fresh profiles/surfaces:

1. direct authenticated HTTP to an optimized junban-server
2. junban --json --server ... --credential-file ... tool call (remote owner)
3. junban --json --data-dir ... tool call (temporary local owner)
4. persistent junban-mcp stdio tools/call against an active owner

Pure Python 3 standard library. Release binaries only unless --build is passed.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

# ── Protocol constants (frozen) ──────────────────────────────────────────────

PROTOCOL_NAME = "junban-phase5-conformance-v1"
PROTOCOL_VERSION = 1
EXPECTED_FINAL_REVISION = 17
EXPECTED_EVENT_COUNT = 17
SCHEMA_VERSION = 5

BACKUP_MAGIC = b"JNBK"
BACKUP_VERSION = 1
BACKUP_HEADER_LEN = 4 + 2 + 4 + 32 + 8

TOKEN_FILE = "access-token"
RUNTIME_FILE = "runtime.json"
LOCK_FILE = "profile.lock"

READY_TIMEOUT_SECONDS = 20.0
STOP_TIMEOUT_SECONDS = 20.0
CALL_TIMEOUT_SECONDS = 60.0
MCP_TIMEOUT_SECONDS = 60.0
SSE_CATCHUP_TIMEOUT_SECONDS = 10.0
POLL_INTERVAL_SECONDS = 0.025

IMPORT_CONTENT = "- [ ] Imported conformance task"
IMPORT_CONTENT_CHANGED = "- [ ] Imported conformance task CHANGED"
TEXT_IMPORT_INPUT = "- [ ] Parent line\n  - [ ] Child line\n"
QUICK_ENTRY_INPUT = "Write report p2 45m due 2030-01-15 #agent"
FILTER_INPUT = "priority:2 due_after:2030-01-01 due_before:2030-01-31 #agent"
MISSING_TASK_ID = "00000000-0000-0000-0000-000000000001"

UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
# Require token-shaped material after Bearer (not prose like "bearer tokens").
BEARER_RE = re.compile(
    r"\bBearer\s+[A-Za-z0-9_\-.=+/]{16,}",
    re.IGNORECASE,
)
JBA_RE = re.compile(r"\bjba_[0-9a-fA-F-]{36}_[0-9a-fA-F]{64}\b")

SURFACES = ("http", "cli_remote", "cli_local", "mcp")


class HarnessError(Exception):
    """Fail-closed harness or corpus failure."""


# ── Small utilities ──────────────────────────────────────────────────────────


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_value(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def write_private_file(path: Path, text: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        if not text.endswith("\n"):
            handle.write("\n")
    os.chmod(path, 0o600)


def ensure_mode700(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def poll_until(timeout: float, predicate: Callable[[], bool], message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(POLL_INTERVAL_SECONDS)
    raise HarnessError(message)


def run_checked(
    args: list[str],
    *,
    timeout: float,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=str(cwd) if cwd else None,
        )
    except subprocess.TimeoutExpired as error:
        raise HarnessError(f"command timed out after {timeout}s: {args[0]}") from error


def git_head(repo: Path) -> str:
    result = run_checked(["git", "-C", str(repo), "rev-parse", "HEAD"], timeout=10)
    if result.returncode != 0:
        raise HarnessError(f"git rev-parse failed: {result.stderr.strip()}")
    return result.stdout.strip()


def git_dirty(repo: Path) -> bool:
    result = run_checked(["git", "-C", str(repo), "status", "--porcelain"], timeout=10)
    if result.returncode != 0:
        raise HarnessError(f"git status failed: {result.stderr.strip()}")
    return bool(result.stdout.strip())


def secret_leak_in(text: str, secrets_set: set[str]) -> str | None:
    if BEARER_RE.search(text):
        return "Bearer token pattern"
    if JBA_RE.search(text):
        return "automation token pattern"
    for secret in secrets_set:
        if secret and secret in text:
            return "known secret material"
    return None


def assert_no_secrets(text: str, secrets_set: set[str], *, where: str) -> None:
    leak = secret_leak_in(text, secrets_set)
    if leak:
        raise HarnessError(f"secret leak in {where}: {leak}")


# ── Binary resolution ────────────────────────────────────────────────────────


@dataclass
class Binaries:
    server: Path
    cli: Path
    mcp: Path
    web_dir: Path


def default_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_binaries(
    repo: Path,
    *,
    server: Path | None,
    cli: Path | None,
    mcp: Path | None,
    web_dir: Path | None,
    build: bool,
) -> Binaries:
    release = repo / "target" / "release"
    resolved = Binaries(
        server=(server or release / "junban-server").resolve(),
        cli=(cli or release / "junban").resolve(),
        mcp=(mcp or release / "junban-mcp").resolve(),
        web_dir=(web_dir or repo).resolve(),
    )
    if build:
        eprint("building release binaries: junban-server junban-cli junban-mcp")
        result = run_checked(
            [
                "cargo",
                "build",
                "--release",
                "-p",
                "junban-server",
                "-p",
                "junban-cli",
                "-p",
                "junban-mcp",
            ],
            timeout=600,
            cwd=repo,
        )
        if result.returncode != 0:
            raise HarnessError(f"cargo build failed:\n{result.stderr[-4000:]}")
    missing = [
        name
        for name, path in (
            ("junban-server", resolved.server),
            ("junban", resolved.cli),
            ("junban-mcp", resolved.mcp),
        )
        if not path.is_file()
    ]
    if missing:
        raise HarnessError(
            "missing release binaries: "
            + ", ".join(missing)
            + " (pass --build or --server/--cli/--mcp)"
        )
    if not (resolved.web_dir / "index.html").is_file():
        raise HarnessError(f"web-dir missing index.html: {resolved.web_dir}")
    return resolved


def binary_record(path: Path) -> dict[str, Any]:
    return {
        "path_name": path.name,
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


# ── Profile + server process ─────────────────────────────────────────────────


@dataclass
class OwnedServer:
    profile: Path
    process: subprocess.Popen[bytes]
    base_url: str
    host: str
    operator_token: str
    stderr_path: Path
    unit_label: str

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                self.process.kill()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    raise HarnessError(
                        f"{self.unit_label}: server did not die after SIGKILL"
                    ) from error
        def cleaned() -> bool:
            return (
                self.process.poll() is not None
                and not (self.profile / RUNTIME_FILE).exists()
                and lock_is_free(self.profile)
            )

        try:
            poll_until(
                STOP_TIMEOUT_SECONDS,
                cleaned,
                f"{self.unit_label}: owner lock/runtime retained after stop",
            )
        except HarnessError:
            if self.process.poll() is None:
                self.process.kill()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            try:
                poll_until(
                    5.0,
                    cleaned,
                    f"{self.unit_label}: owner lock/runtime retained after stop",
                )
            except HarnessError:
                runtime = (self.profile / RUNTIME_FILE).exists()
                rc = self.process.poll()
                free = lock_is_free(self.profile)
                raise HarnessError(
                    f"{self.unit_label}: cleanup failed rc={rc} runtime={runtime} lock_free={free}"
                )


def prepare_profile(profile: Path, operator_token: str) -> None:
    if profile.exists():
        shutil.rmtree(profile)
    ensure_mode700(profile)
    write_private_file(profile / TOKEN_FILE, operator_token)


def start_server(
    binaries: Binaries,
    profile: Path,
    operator_token: str,
    *,
    label: str,
    work_root: Path,
) -> OwnedServer:
    prepare_profile(profile, operator_token)
    stderr_path = work_root / f"{label}.stderr.log"
    stderr_handle = stderr_path.open("wb")
    process = subprocess.Popen(
        [
            str(binaries.server),
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            str(profile),
            "--web-dir",
            str(binaries.web_dir),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=stderr_handle,
        cwd=str(binaries.web_dir),
    )
    stderr_handle.close()
    runtime_path = profile / RUNTIME_FILE
    holder: dict[str, Any] = {}

    def runtime_ready() -> bool:
        if process.poll() is not None:
            tail = stderr_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise HarnessError(f"{label}: server exited early ({process.returncode}): {tail}")
        if not runtime_path.is_file():
            return False
        try:
            data = json.loads(runtime_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        address = data.get("address")
        if not isinstance(address, str) or not address.startswith("127.0.0.1:"):
            return False
        holder["runtime"] = data
        return True

    try:
        poll_until(READY_TIMEOUT_SECONDS, runtime_ready, f"{label}: runtime.json not ready")
    except Exception:
        if process.poll() is None:
            process.kill()
        raise

    address = str(holder["runtime"]["address"])
    base_url = f"http://{address}"

    def health_ready() -> bool:
        try:
            payload, status, _ = http_json("GET", base_url, "/api/v1/health", host=address)
        except HarnessError:
            return False
        return status == 200 and isinstance(payload, dict) and bool(payload.get("status"))

    poll_until(READY_TIMEOUT_SECONDS, health_ready, f"{label}: health not ready")
    return OwnedServer(
        profile=profile,
        process=process,
        base_url=base_url,
        host=address,
        operator_token=operator_token,
        stderr_path=stderr_path,
        unit_label=label,
    )


def mint_operator_token() -> str:
    # High-entropy operator token; never logged.
    return secrets.token_hex(32)


def mint_automation_token(credential_id: uuid.UUID) -> str:
    return f"jba_{credential_id}_{secrets.token_hex(32)}"


def create_automation_credential(
    server: OwnedServer,
    token_path: Path,
    *,
    label: str = "phase5-conformance",
) -> str:
    credential_id = uuid.uuid4()
    # uuid4 is fine for harness setup; server accepts any UUID.
    # Prefer UUIDv7-like ordering not required for auth.
    token = mint_automation_token(credential_id)
    write_private_file(token_path, token)
    body = {
        "id": str(credential_id),
        "label": label,
        "scopes": ["read", "write", "data"],
        "token": token,
    }
    payload, status, _ = http_json(
        "POST",
        server.base_url,
        "/api/v1/auth/credentials",
        host=server.host,
        token=server.operator_token,
        body=body,
        mutation=True,
    )
    if status != 200:
        raise HarnessError(f"create automation credential failed: {status} {payload}")
    if not isinstance(payload, dict) or payload.get("id") != str(credential_id):
        raise HarnessError(f"credential create response unexpected: {payload!r}")
    return token


# ── HTTP helpers ─────────────────────────────────────────────────────────────


def http_json(
    method: str,
    base_url: str,
    path: str,
    *,
    host: str,
    token: str | None = None,
    body: Any | None = None,
    mutation: bool = False,
    timeout: float = CALL_TIMEOUT_SECONDS,
    expect_json: bool = True,
) -> tuple[Any, int, dict[str, str]]:
    headers = {"Host": host}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data: bytes | None = None
    if mutation:
        headers["Origin"] = base_url
        headers["Idempotency-Key"] = str(uuid.uuid4())
    if body is not None:
        data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        base_url + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = int(response.status)
            resp_headers = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        raw = error.read()
        status = int(error.code)
        resp_headers = {k.lower(): v for k, v in error.headers.items()}
    except urllib.error.URLError as error:
        raise HarnessError(f"HTTP {method} {path} failed: {error}") from error

    if not expect_json:
        return raw, status, resp_headers
    if not raw:
        return None, status, resp_headers
    try:
        return json.loads(raw.decode("utf-8")), status, resp_headers
    except json.JSONDecodeError as error:
        snippet = raw[:300].decode("utf-8", errors="replace")
        raise HarnessError(f"malformed JSON from {method} {path}: {error}: {snippet!r}") from error


def http_download(
    base_url: str,
    path: str,
    dest: Path,
    *,
    host: str,
    token: str,
    timeout: float = CALL_TIMEOUT_SECONDS,
) -> tuple[int, dict[str, str], int]:
    headers = {
        "Host": host,
        "Authorization": f"Bearer {token}",
    }
    request = urllib.request.Request(base_url + path, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            resp_headers = {k.lower(): v for k, v in response.headers.items()}
            dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            size = 0
            with dest.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    handle.write(chunk)
                    size += len(chunk)
            os.chmod(dest, 0o600)
            return status, resp_headers, size
    except urllib.error.HTTPError as error:
        raw = error.read()
        snippet = raw[:300].decode("utf-8", errors="replace")
        raise HarnessError(f"download {path} failed: {error.code} {snippet}") from error
    except urllib.error.URLError as error:
        raise HarnessError(f"download {path} failed: {error}") from error


def sse_catchup_events(
    base_url: str,
    *,
    host: str,
    token: str,
    event_epoch: str,
    expected_count: int,
    timeout: float = SSE_CATCHUP_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.hostname is None or parsed.port is None:
        raise HarnessError(f"invalid base_url for SSE: {base_url}")
    path = f"/api/v1/events?event_epoch={urllib.parse.quote(event_epoch)}&since=0"
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
    try:
        conn.request(
            "GET",
            path,
            headers={
                "Host": host,
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream",
            },
        )
        response = conn.getresponse()
        if response.status != 200:
            body = response.read(300).decode("utf-8", errors="replace")
            raise HarnessError(f"SSE catch-up HTTP {response.status}: {body}")
        events: list[dict[str, Any]] = []
        buffer = ""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and len(events) < expected_count:
            chunk = response.read(1)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")
            while "\n\n" in buffer:
                block, buffer = buffer.split("\n\n", 1)
                data_lines = [
                    line[5:] for line in block.splitlines() if line.startswith("data:")
                ]
                if not data_lines:
                    continue
                payload = json.loads("\n".join(data_lines))
                if isinstance(payload, dict) and "revision" in payload:
                    events.append(payload)
        if len(events) != expected_count:
            raise HarnessError(
                f"SSE catch-up got {len(events)} events, expected {expected_count}"
            )
        return events
    finally:
        try:
            # Drop the streaming response promptly so the server can shut down.
            conn.close()
        except Exception:
            pass


# ── Alias registry + normalization ───────────────────────────────────────────


@dataclass
class AliasRegistry:
    """Maps generated UUIDs and a few special IDs to stable semantic aliases."""

    id_to_alias: dict[str, str] = field(default_factory=dict)
    alias_to_id: dict[str, str] = field(default_factory=dict)
    op_by_step: dict[str, str] = field(default_factory=dict)
    special: dict[str, str] = field(default_factory=dict)

    def bind(self, alias: str, raw_id: str) -> None:
        if not isinstance(raw_id, str) or not raw_id:
            raise HarnessError(f"cannot bind empty id to {alias}")
        existing = self.alias_to_id.get(alias)
        if existing and existing != raw_id:
            raise HarnessError(
                f"alias {alias} rebound from {existing} to {raw_id}"
            )
        # Multiple semantic aliases may name the same id (e.g. op:step and
        # op:rev-N). Normalization uses one canonical id_to_alias entry.
        self.alias_to_id[alias] = raw_id
        prior = self.id_to_alias.get(raw_id)
        if prior is None:
            self.id_to_alias[raw_id] = alias
        elif prior != alias and not (
            prior.startswith("op:") and alias.startswith("op:")
        ):
            # Non-operation entities must keep a single semantic alias.
            raise HarnessError(
                f"id {raw_id} already aliased as {prior}, cannot bind {alias}"
            )

    def bind_op(self, step: str, operation_id: str) -> None:
        self.op_by_step[step] = operation_id
        self.bind(f"op:{step}", operation_id)

    def get(self, alias: str) -> str:
        try:
            return self.alias_to_id[alias]
        except KeyError as error:
            raise HarnessError(f"unknown alias {alias}") from error

    def learn_from_final_state(self, state: dict[str, Any]) -> None:
        """Assign protocol aliases from immutable semantic fields + creation order."""
        catalog = state["catalog"]
        projects = catalog["projects"]
        sections = catalog["sections"]
        tags = catalog["tags"]
        templates = catalog["templates"]
        filters = catalog["saved_filters"]
        tasks = state["tasks"]["tasks"]
        comments = state["task_root_comments"]["comments"]
        slots = state["time_slots"]["time_slots"]
        blocks = state["time_blocks"]["time_blocks"]
        reminders = state["task_root_reminders"]["reminders"]

        project = _unique_by(projects, "name", "Automation Project")
        self.bind("project:automation", project["id"])
        section = _unique_by(sections, "name", "Doing")
        self.bind("section:doing", section["id"])
        tag = _unique_by(tags, "name", "agent")
        self.bind("tag:agent", tag["id"])
        template = _unique_by(templates, "name", "Weekly check")
        self.bind("template:weekly-check", template["id"])
        saved = _unique_by(filters, "name", "Important")
        self.bind("filter:important", saved["id"])

        root = _unique_by(tasks, "title", "Conformance root")
        self.bind("task:root", root["id"])
        dep = _unique_by(tasks, "title", "Conformance dependency")
        self.bind("task:dependency", dep["id"])
        imported = _unique_by(tasks, "title", "Imported conformance task")
        self.bind("task:imported", imported["id"])

        if len(comments) != 1:
            raise HarnessError(f"expected one comment, got {len(comments)}")
        self.bind("comment:conformance", comments[0]["id"])

        slot = _unique_by(slots, "title", "Deep work")
        self.bind("slot:deep-work", slot["id"])
        block = _unique_by(blocks, "title", "Root block")
        self.bind("block:root", block["id"])

        if len(reminders) != 1:
            raise HarnessError(f"expected one root reminder, got {len(reminders)}")
        # Reminder occurrences are keyed by task_id (no separate id).
        self.special["reminder:root_task"] = reminders[0]["task_id"]

        # Event/operation aliases from ordered catch-up.
        events = state["events"]
        if len(events) != EXPECTED_EVENT_COUNT:
            raise HarnessError(
                f"expected {EXPECTED_EVENT_COUNT} events, got {len(events)}"
            )
        for event in events:
            rev = int(event["revision"])
            # Prefer stable op:rev-N as the canonical operation alias when the
            # step-time alias already reserved the UUID; bind() keeps one canon.
            self.bind(f"op:rev-{rev}", event["operation_id"])

        epoch = state["sync_state"]["event_epoch"]
        self.special["event_epoch"] = str(epoch)


def _unique_by(items: list[dict[str, Any]], key: str, value: str) -> dict[str, Any]:
    matches = [item for item in items if item.get(key) == value]
    if len(matches) != 1:
        raise HarnessError(f"expected unique {key}={value!r}, found {len(matches)}")
    return matches[0]


def normalize_value(
    value: Any,
    aliases: AliasRegistry,
    *,
    path: str = "$",
    known_paths: set[str] | None = None,
) -> Any:
    """Replace approved nondeterminism with stable placeholders.

    Unknown UUID-looking strings are rejected rather than dropped.
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key in sorted(value.keys()):
            child_path = f"{path}.{key}"
            # Download tool wrappers report local byte counts that embed
            # generated timestamps inside artifacts; keep presence only.
            if key == "bytes_written" and isinstance(value[key], int):
                out[key] = "<bytes_written>"
                continue
            out[key] = normalize_value(
                value[key], aliases, path=child_path, known_paths=known_paths
            )
        return out
    if isinstance(value, list):
        # Sort only free-form sets that have no protocol order; preserve arrays
        # that are inherently ordered (events by revision, activity).
        normalized_items = [
            normalize_value(item, aliases, path=f"{path}[]", known_paths=known_paths)
            for item in value
        ]
        if path.endswith(
            (
                ".tag_ids",
                ".task_ids",
                ".project_ids",
                ".section_ids",
                ".comment_ids",
                ".template_ids",
                ".saved_filter_ids",
                ".time_slot_ids",
                ".time_block_ids",
                ".tag_names",
                ".project_names",
                ".warnings",
            )
        ):
            return sorted(
                normalized_items,
                key=lambda item: canonical_json(item),
            )
        if path.endswith(
            (
                ".projects",
                ".sections",
                ".tags",
                ".templates",
                ".saved_filters",
                ".tasks",
                ".comments",
                ".relations",
                ".reminders",
                ".time_slots",
                ".time_blocks",
                ".drafts",
            )
        ):
            return sorted(
                normalized_items,
                key=lambda item: canonical_json(item),
            )
        return normalized_items
    if isinstance(value, str):
        return normalize_string(value, aliases, path=path)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    raise HarnessError(f"unsupported JSON type at {path}: {type(value).__name__}")


def normalize_string(value: str, aliases: AliasRegistry, *, path: str) -> str:
    # Absolute local paths from export/backup tool wrappers.
    if path.endswith(".output_path") or path.endswith("output_path"):
        return "<output_path>"
    if path.endswith(".token_path"):
        return "<token_path>"

    # Known special non-UUID ids.
    if value == "settings":
        return "settings"

    # Epoch
    if path.endswith("event_epoch") or path.endswith(".event_epoch"):
        return "<event_epoch>"

    # Sample/as-of civil dates that reflect server-local "today".
    if path.endswith("as_of_date") and DATE_RE.match(value):
        # Corpus planning requests pin 2030-01-15; list_tasks as_of_date is server today.
        if value != "2030-01-15":
            return "<as_of_date>"

    # RFC3339 timestamps.
    if RFC3339_RE.match(value):
        # Keep corpus-fixed instants; placeholder the rest.
        if value in {
            "2030-01-14T12:00:00Z",
            "2030-01-14T11:30:00Z",
            "2030-01-21T11:30:00Z",
        }:
            return value
        return "<timestamp>"

    # Content fingerprints are deterministic for fixed content — keep them.
    if path.endswith("content_fingerprint") or path.endswith("fingerprint"):
        return value
    if path.endswith("payload_sha256") and HEX64_RE.match(value):
        return "<payload_sha256>"

    # UUIDs → aliases.
    if UUID_RE.fullmatch(value):
        alias = aliases.id_to_alias.get(value)
        if alias:
            return alias
        # request_id and similar transport ids
        if path.endswith("request_id") or path.endswith(".request_id"):
            return "<request_id>"
        # occurrence_key embeds id:date — handled below via partial replace
        raise HarnessError(f"unmapped UUID at {path}: {value}")

    # occurrence_key and similar composite strings may embed UUIDs.
    if UUID_RE.search(value):
        def repl(match: re.Match[str]) -> str:
            raw = match.group(0)
            alias = aliases.id_to_alias.get(raw)
            if not alias:
                raise HarnessError(f"unmapped UUID embedded at {path}: {raw}")
            return alias

        return UUID_RE.sub(repl, value)

    return value


def normalize_error_envelope(payload: Any, *, http_status: int | None = None) -> dict[str, Any]:
    """Unify HTTP/CLI/MCP error transport wrappers into one semantic object."""
    if not isinstance(payload, dict):
        raise HarnessError(f"error payload is not an object: {payload!r}")

    # MCP: structuredContent already {"error":{...}} or nested.
    error_obj = payload.get("error")
    if not isinstance(error_obj, dict):
        raise HarnessError(f"error payload missing error object: {payload!r}")

    code = error_obj.get("code")
    message = error_obj.get("message")
    retryable = error_obj.get("retryable")
    details = error_obj.get("details")
    fields = error_obj.get("fields")
    if details is None and isinstance(fields, dict):
        details = fields
    if not isinstance(code, str) or not isinstance(message, str):
        raise HarnessError(f"error missing code/message: {payload!r}")

    # Message class: stable code + generic top-level server messages.
    # Keep exact server message text; it is stable for domain errors.
    out: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": bool(retryable) if retryable is not None else False,
    }
    if isinstance(details, dict) and details:
        # Normalize detail map keys sorted via canonical dump later.
        out["details"] = {str(k): str(v) for k, v in sorted(details.items())}
    # HTTP status is part of the HTTP surface contract; include when known so
    # all surfaces that can observe it agree. CLI/MCP omit transport status.
    if http_status is not None:
        out["http_status"] = http_status
    return out


# ── Artifact validation ──────────────────────────────────────────────────────


def validate_json_export(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise HarnessError("JSON export root must be object")
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        # export format uses nested structure — accept either tasks array or format marker
        if data.get("format") != "junban_tasks":
            raise HarnessError(f"JSON export unexpected shape keys={list(data)[:12]}")
    inventory = {
        "format": data.get("format", "json"),
        "keys": sorted(data.keys()),
        "task_titles": sorted(
            [
                t.get("title")
                for t in (data.get("tasks") or [])
                if isinstance(t, dict) and isinstance(t.get("title"), str)
            ]
        ),
        "project_names": sorted(
            [
                p.get("name")
                for p in (data.get("projects") or [])
                if isinstance(p, dict) and isinstance(p.get("name"), str)
            ]
        ),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }
    return inventory


def validate_csv_export(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines:
        raise HarnessError("CSV export empty")
    header = lines[0]
    if "title" not in header:
        raise HarnessError(f"CSV header unexpected: {header!r}")
    return {
        "format": "csv",
        "header": header,
        "row_count": max(0, len(lines) - 1),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def validate_markdown_export(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if "- [ ]" not in text and "- [x]" not in text:
        raise HarnessError("Markdown export missing checkbox lines")
    titles = re.findall(r"^- \[[ xX]\] (.+)$", text, flags=re.MULTILINE)
    return {
        "format": "markdown",
        "titles": sorted(titles),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def validate_backup_artifact(path: Path) -> dict[str, Any]:
    size = path.stat().st_size
    if size < BACKUP_HEADER_LEN:
        raise HarnessError(f"backup shorter than header: {size}")
    with path.open("rb") as handle:
        magic = handle.read(4)
        version = int.from_bytes(handle.read(2), "little")
        manifest_len = int.from_bytes(handle.read(4), "little")
        manifest_sha = handle.read(32)
        payload_len = int.from_bytes(handle.read(8), "little")
        if magic != BACKUP_MAGIC:
            raise HarnessError(f"bad backup magic {magic!r}")
        if version != BACKUP_VERSION:
            raise HarnessError(f"bad backup version {version}")
        if manifest_len <= 0 or payload_len <= 0:
            raise HarnessError("backup manifest/payload length must be positive")
        expected = BACKUP_HEADER_LEN + manifest_len + payload_len
        if size != expected:
            raise HarnessError(f"backup size {size} != {expected}")
        manifest_raw = handle.read(manifest_len)
        payload = handle.read(payload_len)
    if len(manifest_raw) != manifest_len or len(payload) != payload_len:
        raise HarnessError("backup truncated while reading body")
    if hashlib.sha256(manifest_raw).digest() != manifest_sha:
        raise HarnessError("backup manifest hash mismatch")
    manifest = json.loads(manifest_raw.decode("utf-8"))
    if not isinstance(manifest, dict):
        raise HarnessError("backup manifest is not an object")
    if int(manifest.get("artifact_version", -1)) != BACKUP_VERSION:
        raise HarnessError(f"manifest artifact_version {manifest.get('artifact_version')}")
    if int(manifest.get("schema_version", -1)) != SCHEMA_VERSION:
        raise HarnessError(f"manifest schema_version {manifest.get('schema_version')}")
    payload_sha = hashlib.sha256(payload).hexdigest()
    if str(manifest.get("payload_sha256", "")).lower() != payload_sha:
        raise HarnessError("backup payload hash mismatch vs manifest")

    # SQLite integrity via stdlib, never against the live profile DB.
    with tempfile.NamedTemporaryFile(prefix="junban-backup-payload-", suffix=".sqlite3") as tmp:
        tmp.write(payload)
        tmp.flush()
        conn = sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)
        try:
            conn.execute("PRAGMA query_only=ON")
            integrity = list(conn.execute("PRAGMA integrity_check"))
            if integrity != [("ok",)]:
                raise HarnessError(f"backup integrity_check failed: {integrity!r}")
            conn.execute("PRAGMA foreign_keys=ON")
            fk = list(conn.execute("PRAGMA foreign_key_check"))
            if fk:
                raise HarnessError(f"backup foreign_key_check failed: {fk[:5]!r}")
            schema_version = conn.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            ).fetchone()[0]
            if int(schema_version) != SCHEMA_VERSION:
                raise HarnessError(
                    f"backup sqlite schema_version {schema_version} != {SCHEMA_VERSION}"
                )
        finally:
            conn.close()

    # Semantic inventory only. Framing lengths and payload bytes embed generated
    # timestamps/UUIDs and are validated above, not compared across surfaces.
    inventory = {
        "artifact_version": int(manifest["artifact_version"]),
        "schema_version": int(manifest["schema_version"]),
        "task_count": int(manifest["task_count"]),
        "project_count": int(manifest["project_count"]),
        "tag_count": int(manifest["tag_count"]),
        "event_count": int(manifest["event_count"]),
        "revision": int(manifest["revision"]),
        "integrity": "ok",
        "foreign_keys": "ok",
        # Retained for diagnostics in single-surface runs; lengths are checked
        # for positivity during parse but excluded from cross-surface digests
        # via normalize_surface_bundle.
        "_framing": {
            "payload_len": payload_len,
            "manifest_len": manifest_len,
        },
    }
    return inventory


# ── Surface runners ──────────────────────────────────────────────────────────


@dataclass
class CallResult:
    ok: bool
    value: Any
    http_status: int | None = None
    raw_text: str | None = None


class SurfaceRunner:
    name: str

    def call(self, tool: str, arguments: dict[str, Any]) -> CallResult:
        raise NotImplementedError

    def close(self) -> None:
        return None


class HttpRunner(SurfaceRunner):
    """Direct authenticated HTTP using the shared catalog semantics."""

    name = "http"

    def __init__(self, server: OwnedServer, bearer: str, artifact_dir: Path) -> None:
        self.server = server
        self.bearer = bearer
        self.artifact_dir = artifact_dir

    def call(self, tool: str, arguments: dict[str, Any]) -> CallResult:
        plan = http_plan(tool, arguments, self.artifact_dir)
        if plan.download_path is not None:
            status, headers, size = http_download(
                self.server.base_url,
                plan.path,
                plan.download_path,
                host=self.server.host,
                token=self.bearer,
            )
            if status >= 400:
                # downloads shouldn't error in success corpus
                raise HarnessError(f"HTTP download {tool} status {status}")
            value = {
                "bytes_written": size,
                "output_path": str(plan.download_path),
            }
            return CallResult(ok=True, value=value, http_status=status)

        payload, status, _ = http_json(
            plan.method,
            self.server.base_url,
            plan.path,
            host=self.server.host,
            token=self.bearer,
            body=plan.body,
            mutation=plan.mutation,
        )
        if status >= 400:
            return CallResult(ok=False, value=payload, http_status=status)
        return CallResult(ok=True, value=payload, http_status=status)


@dataclass
class HttpPlan:
    method: str
    path: str
    body: Any | None
    mutation: bool
    download_path: Path | None = None


def http_plan(tool: str, arguments: dict[str, Any], artifact_dir: Path) -> HttpPlan:
    """Map catalog tool name + JSON arguments to an HTTP request."""
    args = dict(arguments)

    def path_fill(template: str) -> str:
        out = template
        for key, value in list(args.items()):
            token = "{" + key + "}"
            if token in out:
                out = out.replace(token, urllib.parse.quote(str(value), safe=""))
                args.pop(key)
        if "{" in out:
            raise HarnessError(f"{tool}: unresolved path template {out} args={arguments}")
        return out

    # Downloads
    if tool == "export_tasks":
        fmt = args.pop("format")
        output_path = Path(str(args.pop("output_path")))
        args.pop("overwrite", None)
        if args:
            raise HarnessError(f"export_tasks extra args {args}")
        return HttpPlan(
            "GET",
            f"/api/v1/exports/tasks?format={urllib.parse.quote(str(fmt))}",
            None,
            False,
            download_path=output_path,
        )
    if tool == "create_backup":
        output_path = Path(str(args.pop("output_path")))
        args.pop("overwrite", None)
        if args:
            raise HarnessError(f"create_backup extra args {args}")
        return HttpPlan("GET", "/api/v1/backup", None, False, download_path=output_path)

    table: dict[str, tuple[str, str, bool, bool]] = {
        # name -> method, path, mutation, has_json_body
        "get_profile": ("GET", "/api/v1/profile", False, False),
        "get_sync_state": ("GET", "/api/v1/sync-state", False, False),
        "get_settings": ("GET", "/api/v1/settings", False, False),
        "parse_quick_entry": ("POST", "/api/v1/parse/quick-entry", False, True),
        "parse_filter": ("POST", "/api/v1/parse/filter", False, True),
        "parse_text_import": ("POST", "/api/v1/parse/text-import", False, True),
        "create_project": ("POST", "/api/v1/projects", True, True),
        "create_section": ("POST", "/api/v1/sections", True, True),
        "create_tag": ("POST", "/api/v1/tags", True, True),
        "create_template": ("POST", "/api/v1/templates", True, True),
        "create_saved_filter": ("POST", "/api/v1/saved_filters", True, True),
        "create_task": ("POST", "/api/v1/tasks", True, True),
        "reschedule_reminder": (
            "POST",
            "/api/v1/tasks/{task_id}/reminders/reschedule",
            True,
            True,
        ),
        "add_relation": ("POST", "/api/v1/tasks/{task_id}/relations", True, True),
        "create_comment": ("POST", "/api/v1/tasks/{task_id}/comments", True, True),
        "create_time_slot": ("POST", "/api/v1/time-slots", True, True),
        "append_time_slot_task": (
            "POST",
            "/api/v1/time-slots/{time_slot_id}/tasks",
            True,
            True,
        ),
        "create_time_block": ("POST", "/api/v1/time-blocks", True, True),
        "patch_settings": ("PATCH", "/api/v1/settings", True, True),
        "complete_task": ("POST", "/api/v1/tasks/{task_id}/complete", True, False),
        "undo_operation": (
            "POST",
            "/api/v1/operations/{source_operation_id}/undo",
            True,
            False,
        ),
        "preview_import": ("POST", "/api/v1/imports/preview", False, True),
        "apply_import": ("POST", "/api/v1/imports/apply", True, True),
        "get_catalog": ("GET", "/api/v1/catalog", False, False),
        "get_task": ("GET", "/api/v1/tasks/{task_id}", False, False),
        "list_comments": ("GET", "/api/v1/tasks/{task_id}/comments", False, False),
        "list_relations": ("GET", "/api/v1/tasks/{task_id}/relations", False, False),
        "list_task_reminders": (
            "GET",
            "/api/v1/tasks/{task_id}/reminders",
            False,
            False,
        ),
        "list_task_activity": (
            "GET",
            "/api/v1/tasks/{task_id}/activity",
            False,
            False,
        ),
        "list_tasks": ("GET", "/api/v1/tasks", False, False),
        "list_time_slots": ("GET", "/api/v1/time-slots", False, False),
        "list_time_blocks": ("GET", "/api/v1/time-blocks", False, False),
        "planning_daily": ("GET", "/api/v1/planning/daily", False, False),
        "planning_weekly": ("GET", "/api/v1/planning/weekly", False, False),
        "calendar_tasks": ("GET", "/api/v1/calendar/tasks", False, False),
        "stats": ("GET", "/api/v1/stats", False, False),
    }
    if tool not in table:
        raise HarnessError(f"http_plan: unknown tool {tool}")
    method, template, mutation, has_body = table[tool]
    # Query params for GET list-style tools.
    query_keys = {
        "list_tasks": (
            "view",
            "search",
            "status",
            "project_id",
            "section_id",
            "parent_id",
            "tag_id",
            "tag_ids",
            "priority",
            "due_on",
            "due_before",
            "due_after",
            "someday",
            "overdue",
            "sort",
            "cursor",
            "limit",
        ),
        "list_time_slots": ("date", "project_id"),
        "list_time_blocks": ("from", "to"),
        "planning_daily": ("date", "capacity_minutes"),
        "planning_weekly": ("date", "week_start"),
        "calendar_tasks": ("from", "to", "project_id"),
        "stats": ("from", "to"),
    }
    path = path_fill(template)
    query: list[tuple[str, str]] = []
    for key in query_keys.get(tool, ()):
        if key in args:
            val = args.pop(key)
            if isinstance(val, list):
                for item in val:
                    query.append((key, str(item)))
            elif val is not None:
                query.append((key, str(val)))
    if query:
        path = path + "?" + urllib.parse.urlencode(query)
    body = None
    if has_body:
        body = args
        args = {}
    elif args:
        # complete/undo should only have path params remaining
        raise HarnessError(f"{tool}: unexpected leftover args {args}")
    if args and has_body:
        # body consumed all remaining
        pass
    return HttpPlan(method, path, body, mutation)


class CliRunner(SurfaceRunner):
    def __init__(
        self,
        binaries: Binaries,
        *,
        name: str,
        data_dir: Path,
        server_url: str | None,
        credential_file: Path | None,
        secrets: set[str],
    ) -> None:
        self.name = name
        self.binaries = binaries
        self.data_dir = data_dir
        self.server_url = server_url
        self.credential_file = credential_file
        self.secrets = secrets

    def call(self, tool: str, arguments: dict[str, Any]) -> CallResult:
        args = [
            str(self.binaries.cli),
            "--json",
            "--data-dir",
            str(self.data_dir),
        ]
        if self.server_url is not None:
            if self.credential_file is None:
                raise HarnessError("cli remote requires credential file")
            args.extend(
                [
                    "--server",
                    self.server_url,
                    "--credential-file",
                    str(self.credential_file),
                ]
            )
        input_json = json.dumps(arguments, separators=(",", ":"), ensure_ascii=False)
        args.extend(["tool", "call", tool, "--input", input_json])
        result = run_checked(args, timeout=CALL_TIMEOUT_SECONDS)
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        assert_no_secrets(stdout, self.secrets, where=f"{self.name} stdout")
        assert_no_secrets(stderr, self.secrets, where=f"{self.name} stderr")
        text = stdout.strip()
        if not text:
            raise HarnessError(
                f"{self.name} {tool}: empty stdout rc={result.returncode} stderr={stderr[-500:]}"
            )
        # Exactly one JSON value.
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise HarnessError(
                f"{self.name} {tool}: stdout is not one JSON value: {text[:300]!r}"
            ) from error
        if result.returncode == 0:
            if isinstance(payload, dict) and "error" in payload and len(payload) == 1:
                raise HarnessError(f"{self.name} {tool}: success rc with error payload")
            return CallResult(ok=True, value=payload, raw_text=text)
        if not isinstance(payload, dict) or "error" not in payload:
            raise HarnessError(
                f"{self.name} {tool}: failure without error envelope: {payload!r}"
            )
        return CallResult(ok=False, value=payload, raw_text=text)


class McpRunner(SurfaceRunner):
    name = "mcp"

    def __init__(
        self,
        binaries: Binaries,
        *,
        data_dir: Path,
        server_url: str,
        credential_file: Path,
        secrets: set[str],
    ) -> None:
        self.binaries = binaries
        self.secrets = secrets
        self._rpc_id = 100
        self._stderr_chunks: list[str] = []
        self.process = subprocess.Popen(
            [
                str(binaries.mcp),
                "--data-dir",
                str(data_dir),
                "--server",
                server_url,
                "--credential-file",
                str(credential_file),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self.process.stdin and self.process.stdout and self.process.stderr
        self._stderr_thread = threading.Thread(target=self._pump_stderr, daemon=True)
        self._stderr_thread.start()
        self._initialize()

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            for line in self.process.stderr:
                self._stderr_chunks.append(line)
        except Exception:
            return

    def _write(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def _read(self, *, timeout: float) -> dict[str, Any]:
        assert self.process.stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                err = "".join(self._stderr_chunks)[-2000:]
                raise HarnessError(f"mcp exited early rc={self.process.returncode}: {err}")
            # readline blocks; use a short socket-style approach via background?
            # Text mode line buffering with timeout via select on POSIX.
            import select

            ready, _, _ = select.select([self.process.stdout], [], [], 0.05)
            if not ready:
                continue
            line = self.process.stdout.readline()
            if line == "":
                raise HarnessError("mcp stdout EOF")
            text = line.strip()
            if not text:
                continue
            assert_no_secrets(text, self.secrets, where="mcp stdout")
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as error:
                raise HarnessError(f"mcp invalid JSON frame: {text[:300]!r}") from error
            if not isinstance(payload, dict):
                raise HarnessError(f"mcp frame not object: {payload!r}")
            # Skip notifications (no id).
            if "id" not in payload and payload.get("method"):
                continue
            return payload
        raise HarnessError("mcp read timed out")

    def _initialize(self) -> None:
        self._write(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "phase5-conformance", "version": "0.1.0"},
                },
            }
        )
        init = self._read(timeout=MCP_TIMEOUT_SECONDS)
        if init.get("id") != 1 or "result" not in init:
            raise HarnessError(f"mcp initialize failed: {init}")
        self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call(self, tool: str, arguments: dict[str, Any]) -> CallResult:
        self._rpc_id += 1
        req_id = self._rpc_id
        self._write(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
            }
        )
        response = self._read(timeout=MCP_TIMEOUT_SECONDS)
        if response.get("id") != req_id:
            raise HarnessError(f"mcp id mismatch: {response}")
        if "error" in response:
            # Protocol-level JSON-RPC error (not domain tool error).
            raise HarnessError(f"mcp JSON-RPC error for {tool}: {response['error']}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise HarnessError(f"mcp tools/call missing result: {response}")
        is_error = bool(result.get("isError"))
        structured = result.get("structuredContent")
        if structured is None:
            raise HarnessError(f"mcp tools/call missing structuredContent: {result}")
        if is_error:
            return CallResult(ok=False, value=structured)
        if isinstance(structured, dict) and "error" in structured and set(structured) <= {
            "error"
        }:
            # Defensive: some paths might omit isError.
            return CallResult(ok=False, value=structured)
        return CallResult(ok=True, value=structured)

    def close(self) -> None:
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except Exception:
            pass
        try:
            self.process.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        err = "".join(self._stderr_chunks)
        assert_no_secrets(err, self.secrets, where="mcp stderr")


# ── Corpus ───────────────────────────────────────────────────────────────────


@dataclass
class StepOutcome:
    step: str
    tool: str
    ok: bool
    raw: Any
    normalized: Any
    revision_after: int | None = None
    operation_id: str | None = None


def extract_primary_id(mutation: dict[str, Any]) -> str | None:
    event = mutation.get("event")
    if not isinstance(event, dict):
        return None
    snapshot = event.get("snapshot")
    if isinstance(snapshot, dict):
        for key in (
            "project",
            "section",
            "tag",
            "template",
            "saved_filter",
            "task",
            "comment",
            "time_slot",
            "time_block",
        ):
            entity = snapshot.get(key)
            if isinstance(entity, dict) and isinstance(entity.get("id"), str):
                return entity["id"]
    primary = event.get("primary")
    if isinstance(primary, dict) and isinstance(primary.get("id"), str):
        if primary["id"] != "settings":
            return primary["id"]
    return None


def extract_operation_id(mutation: dict[str, Any]) -> str:
    event = mutation.get("event")
    if not isinstance(event, dict) or not isinstance(event.get("operation_id"), str):
        raise HarnessError(f"mutation missing operation_id: {mutation!r}")
    return event["operation_id"]


def extract_revision(mutation: dict[str, Any]) -> int:
    event = mutation.get("event")
    if not isinstance(event, dict) or not isinstance(event.get("revision"), int):
        raise HarnessError(f"mutation missing revision: {mutation!r}")
    return int(event["revision"])


class CorpusDriver:
    def __init__(
        self,
        runner: SurfaceRunner,
        *,
        aliases: AliasRegistry,
        artifact_dir: Path,
        observe_http: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self.runner = runner
        self.aliases = aliases
        self.artifact_dir = artifact_dir
        self.observe_http = observe_http
        self.fingerprint: str | None = None
        self.complete_operation_id: str | None = None
        self.next_occurrence_id: str | None = None
        self.success_steps: list[StepOutcome] = []
        self.error_steps: list[StepOutcome] = []
        self.export_inventories: dict[str, Any] = {}
        self.backup_inventory: dict[str, Any] | None = None
        self.expected_revision = 0

    def _call_ok(self, step: str, tool: str, arguments: dict[str, Any]) -> Any:
        result = self.runner.call(tool, arguments)
        if not result.ok:
            raise HarnessError(
                f"{self.runner.name}/{step} {tool} failed unexpectedly: {result.value!r}"
            )
        return result.value

    def _call_err(self, step: str, tool: str, arguments: dict[str, Any]) -> CallResult:
        result = self.runner.call(tool, arguments)
        if result.ok:
            raise HarnessError(
                f"{self.runner.name}/{step} {tool} succeeded unexpectedly: {result.value!r}"
            )
        return result

    def _mutation(
        self,
        step: str,
        tool: str,
        arguments: dict[str, Any],
        *,
        bind_alias: str | None = None,
        bind_from_title: tuple[str, str] | None = None,
    ) -> dict[str, Any]:
        value = self._call_ok(step, tool, arguments)
        if not isinstance(value, dict) or "event" not in value:
            raise HarnessError(f"{step}: mutation response missing event: {value!r}")
        revision = extract_revision(value)
        self.expected_revision += 1
        if revision != self.expected_revision:
            raise HarnessError(
                f"{step}: revision {revision} != expected {self.expected_revision}"
            )
        op_id = extract_operation_id(value)
        self.aliases.bind_op(step, op_id)
        primary = extract_primary_id(value)
        if bind_alias and primary:
            self.aliases.bind(bind_alias, primary)
        # Learn ids from snapshot titles when needed.
        event = value["event"]
        snapshot = event.get("snapshot") if isinstance(event, dict) else None
        if bind_from_title and isinstance(snapshot, dict):
            entity_key, title = bind_from_title
            entity = snapshot.get(entity_key)
            if isinstance(entity, dict) and entity.get("title") == title and entity.get("id"):
                # alias decided by caller via bind_alias
                pass
        outcome = StepOutcome(
            step=step,
            tool=tool,
            ok=True,
            raw=value,
            normalized=None,
            revision_after=revision,
            operation_id=op_id,
        )
        self.success_steps.append(outcome)
        return value

    def _read(self, step: str, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        value = self._call_ok(step, tool, arguments or {})
        self.success_steps.append(
            StepOutcome(step=step, tool=tool, ok=True, raw=value, normalized=None)
        )
        return value

    def run_success_corpus(self) -> None:
        # 1. empty profile reads
        profile = self._read("01_get_profile", "get_profile")
        if not isinstance(profile, dict) or int(profile.get("revision", -1)) != 0:
            raise HarnessError(f"empty profile revision not 0: {profile!r}")
        sync = self._read("01_get_sync_state", "get_sync_state")
        if not isinstance(sync, dict) or int(sync.get("revision", -1)) != 0:
            raise HarnessError(f"empty sync revision not 0: {sync!r}")
        settings = self._read("01_get_settings", "get_settings")
        if not isinstance(settings, dict) or "appearance" not in settings:
            raise HarnessError(f"settings missing appearance: {settings!r}")

        # 2-4 parsers
        self._read("02_parse_quick_entry", "parse_quick_entry", {"input": QUICK_ENTRY_INPUT})
        self._read("03_parse_filter", "parse_filter", {"input": FILTER_INPUT})
        self._read("04_parse_text_import", "parse_text_import", {"input": TEXT_IMPORT_INPUT})

        # 5-9 organization
        self._mutation(
            "05_create_project",
            "create_project",
            {
                "name": "Automation Project",
                "color": "#3b82f6",
                "view": "list",
                "favorite": True,
            },
            bind_alias="project:automation",
        )
        self._mutation(
            "06_create_section",
            "create_section",
            {"project_id": self.aliases.get("project:automation"), "name": "Doing"},
            bind_alias="section:doing",
        )
        self._mutation(
            "07_create_tag",
            "create_tag",
            {"name": "agent", "color": "#10b981"},
            bind_alias="tag:agent",
        )
        self._mutation(
            "08_create_template",
            "create_template",
            {
                "name": "Weekly check",
                "title": "Review weekly goals",
                "priority": 2,
                "tag_names": ["agent"],
                "project_id": self.aliases.get("project:automation"),
                "recurrence_rule": "weekly",
            },
            bind_alias="template:weekly-check",
        )
        self._mutation(
            "09_create_saved_filter",
            "create_saved_filter",
            {
                "name": "Important",
                "query": "priority:2 #agent",
                "color": "#ef4444",
            },
            bind_alias="filter:important",
        )

        # 10-11 tasks
        self._mutation(
            "10_create_task_root",
            "create_task",
            {
                "title": "Conformance root",
                "description": "Across every native surface",
                "priority": 2,
                "due_date": "2030-01-15",
                "due_time": {"time": "09:30:00", "time_zone": "UTC"},
                "deadline": "2030-01-14T12:00:00Z",
                "estimated_minutes": 45,
                "dread": 2,
                "project_id": self.aliases.get("project:automation"),
                "section_id": self.aliases.get("section:doing"),
                "tag_ids": [self.aliases.get("tag:agent")],
                "recurrence_rule": "weekly",
            },
            bind_alias="task:root",
        )
        self._mutation(
            "11_create_task_dependency",
            "create_task",
            {"title": "Conformance dependency", "estimated_minutes": 15},
            bind_alias="task:dependency",
        )

        # 12 reminder create-or-reschedule
        self._mutation(
            "12_reschedule_reminder",
            "reschedule_reminder",
            {
                "task_id": self.aliases.get("task:root"),
                "remind_at": "2030-01-14T11:30:00Z",
            },
        )

        # 13-14 relation + comment
        self._mutation(
            "13_add_relation",
            "add_relation",
            {
                "task_id": self.aliases.get("task:root"),
                "to_task_id": self.aliases.get("task:dependency"),
                "kind": "blocks",
            },
        )
        self._mutation(
            "14_create_comment",
            "create_comment",
            {
                "task_id": self.aliases.get("task:root"),
                "content": "Conformance comment",
            },
            bind_alias="comment:conformance",
        )

        # 15-17 timeblocking
        self._mutation(
            "15_create_time_slot",
            "create_time_slot",
            {
                "title": "Deep work",
                "date": "2030-01-15",
                "start": "09:00:00",
                "end": "11:00:00",
                "time_zone": "UTC",
                "project_id": self.aliases.get("project:automation"),
                "color": "#3b82f6",
            },
            bind_alias="slot:deep-work",
        )
        self._mutation(
            "16_append_time_slot_task",
            "append_time_slot_task",
            {
                "time_slot_id": self.aliases.get("slot:deep-work"),
                "task_id": self.aliases.get("task:root"),
            },
        )
        self._mutation(
            "17_create_time_block",
            "create_time_block",
            {
                "title": "Root block",
                "date": "2030-01-15",
                "start": "09:30:00",
                "end": "10:15:00",
                "time_zone": "UTC",
                "task_id": self.aliases.get("task:root"),
                "slot_id": self.aliases.get("slot:deep-work"),
                "locked": True,
                "color": "#3b82f6",
            },
            bind_alias="block:root",
        )

        # 18 settings
        self._mutation(
            "18_patch_settings",
            "patch_settings",
            {
                "appearance": {
                    "theme": "dark",
                    "accent": "#10b981",
                    "density": "compact",
                    "font_size": "medium",
                    "font_family": "inter",
                    "reduced_motion": True,
                }
            },
        )

        # 19 complete recurring root
        complete = self._mutation(
            "19_complete_task",
            "complete_task",
            {"task_id": self.aliases.get("task:root")},
        )
        self.complete_operation_id = extract_operation_id(complete)
        affected = complete["event"].get("affected") or {}
        task_ids = list(affected.get("task_ids") or [])
        root_id = self.aliases.get("task:root")
        next_ids = [tid for tid in task_ids if tid != root_id]
        if len(next_ids) != 1:
            raise HarnessError(
                f"complete_task should affect root + one next occurrence, got {task_ids}"
            )
        self.next_occurrence_id = next_ids[0]
        self.aliases.bind("task:root-next", self.next_occurrence_id)

        # Verify via list_tasks
        listed = self._read("19_list_tasks_after_complete", "list_tasks", {"limit": 100})
        tasks = listed.get("tasks") if isinstance(listed, dict) else None
        if not isinstance(tasks, list):
            raise HarnessError("list_tasks after complete malformed")
        by_id = {t["id"]: t for t in tasks if isinstance(t, dict)}
        if by_id.get(root_id, {}).get("status") != "completed":
            raise HarnessError("root task not completed after complete_task")
        nxt = by_id.get(self.next_occurrence_id)
        if not nxt or nxt.get("status") != "pending" or nxt.get("title") != "Conformance root":
            raise HarnessError(f"next occurrence missing/invalid: {nxt!r}")
        root_reminders = self._read(
            "19_root_reminders_after_complete",
            "list_task_reminders",
            {"task_id": root_id},
        )
        next_reminders = self._read(
            "19_next_reminders_after_complete",
            "list_task_reminders",
            {"task_id": self.next_occurrence_id},
        )
        root_rem = (root_reminders or {}).get("reminders") or []
        next_rem = (next_reminders or {}).get("reminders") or []
        if not root_rem or root_rem[0].get("state") != "cancelled":
            raise HarnessError(f"root reminder not cancelled: {root_rem!r}")
        if not next_rem or next_rem[0].get("state") != "pending":
            raise HarnessError(f"next reminder not pending: {next_rem!r}")
        if next_rem[0].get("remind_at") != "2030-01-21T11:30:00Z":
            raise HarnessError(f"next reminder time unexpected: {next_rem[0]!r}")

        # 20 undo completion
        undo = self._mutation(
            "20_undo_operation",
            "undo_operation",
            {"source_operation_id": self.complete_operation_id},
        )
        listed = self._read("20_list_tasks_after_undo", "list_tasks", {"limit": 100})
        tasks = listed.get("tasks") if isinstance(listed, dict) else None
        if not isinstance(tasks, list):
            raise HarnessError("list_tasks after undo malformed")
        titles = sorted(t.get("title") for t in tasks)
        if titles != sorted(
            ["Conformance root", "Conformance dependency"]
        ):
            raise HarnessError(f"after undo unexpected tasks: {titles}")
        by_id = {t["id"]: t for t in tasks}
        if by_id[root_id].get("status") != "pending":
            raise HarnessError("root not pending after undo")
        if by_id[root_id].get("remind_at") != "2030-01-14T11:30:00Z":
            raise HarnessError("root remind_at not restored after undo")
        if self.next_occurrence_id in by_id:
            raise HarnessError("next occurrence still present after undo")

        # 21-22 import preview/apply
        preview = self._read(
            "21_preview_import",
            "preview_import",
            {"format": "markdown", "content": IMPORT_CONTENT},
        )
        if not isinstance(preview, dict) or not preview.get("content_fingerprint"):
            raise HarnessError(f"preview_import missing fingerprint: {preview!r}")
        self.fingerprint = str(preview["content_fingerprint"])
        apply = self._mutation(
            "22_apply_import",
            "apply_import",
            {
                "format": "markdown",
                "content": IMPORT_CONTENT,
                "fingerprint": self.fingerprint,
                "project_name_mapping": [],
                "tag_name_mapping": [],
            },
        )
        affected = apply["event"].get("affected") or {}
        imported_ids = list(affected.get("task_ids") or [])
        if len(imported_ids) != 1:
            raise HarnessError(f"apply_import affected tasks {imported_ids}")
        self.aliases.bind("task:imported", imported_ids[0])

        if self.expected_revision != EXPECTED_FINAL_REVISION:
            raise HarnessError(
                f"final mutation revision counter {self.expected_revision} "
                f"!= {EXPECTED_FINAL_REVISION}"
            )

        # 23 reads
        self._read("23_get_catalog", "get_catalog")
        self._read("23_get_task_root", "get_task", {"task_id": root_id})
        self._read("23_list_comments", "list_comments", {"task_id": root_id})
        self._read("23_list_relations", "list_relations", {"task_id": root_id})
        self._read("23_list_task_reminders", "list_task_reminders", {"task_id": root_id})
        self._read("23_list_task_activity", "list_task_activity", {"task_id": root_id})
        self._read("23_list_tasks", "list_tasks", {"limit": 100})
        self._read("23_list_time_slots", "list_time_slots", {"date": "2030-01-15"})
        self._read(
            "23_list_time_blocks",
            "list_time_blocks",
            {"from": "2030-01-01", "to": "2030-01-31"},
        )
        self._read(
            "23_planning_daily",
            "planning_daily",
            {"date": "2030-01-15", "capacity_minutes": 480},
        )
        self._read(
            "23_planning_weekly",
            "planning_weekly",
            {"date": "2030-01-15", "week_start": "sunday"},
        )
        self._read(
            "23_calendar_tasks",
            "calendar_tasks",
            {"from": "2030-01-01", "to": "2030-01-31"},
        )
        self._read("23_stats", "stats", {"from": "2030-01-01", "to": "2030-01-31"})
        final_sync = self._read("23_get_sync_state", "get_sync_state")
        if int(final_sync.get("revision", -1)) != EXPECTED_FINAL_REVISION:
            raise HarnessError(f"final sync revision {final_sync}")

        # 24 exports
        for fmt in ("json", "csv", "markdown"):
            out = self.artifact_dir / f"export.{fmt if fmt != 'markdown' else 'md'}"
            if out.exists():
                out.unlink()
            result = self._call_ok(
                f"24_export_{fmt}",
                "export_tasks",
                {"format": fmt, "output_path": str(out)},
            )
            self.success_steps.append(
                StepOutcome(
                    step=f"24_export_{fmt}",
                    tool="export_tasks",
                    ok=True,
                    raw=result,
                    normalized=None,
                )
            )
            if not out.is_file():
                raise HarnessError(f"export {fmt} did not create {out}")
            if fmt == "json":
                self.export_inventories["json"] = validate_json_export(out)
            elif fmt == "csv":
                self.export_inventories["csv"] = validate_csv_export(out)
            else:
                self.export_inventories["markdown"] = validate_markdown_export(out)

        # 25 backup
        backup_path = self.artifact_dir / "profile.junban-backup"
        if backup_path.exists():
            backup_path.unlink()
        result = self._call_ok(
            "25_create_backup",
            "create_backup",
            {"output_path": str(backup_path)},
        )
        self.success_steps.append(
            StepOutcome(
                step="25_create_backup",
                tool="create_backup",
                ok=True,
                raw=result,
                normalized=None,
            )
        )
        self.backup_inventory = validate_backup_artifact(backup_path)
        if int(self.backup_inventory["revision"]) != EXPECTED_FINAL_REVISION:
            raise HarnessError(
                f"backup revision {self.backup_inventory['revision']} != "
                f"{EXPECTED_FINAL_REVISION}"
            )
        if int(self.backup_inventory["event_count"]) != EXPECTED_EVENT_COUNT:
            raise HarnessError(
                f"backup event_count {self.backup_inventory['event_count']} != "
                f"{EXPECTED_EVENT_COUNT}"
            )

    def run_error_corpus(self) -> None:
        root_id = self.aliases.get("task:root")
        if not self.fingerprint:
            raise HarnessError("fingerprint missing before error corpus")

        cases = [
            (
                "E1_get_task_missing",
                "get_task",
                {"task_id": MISSING_TASK_ID},
                {"not_found"},
                {404},
            ),
            (
                "E2_create_task_blank_title",
                "create_task",
                {"title": "   "},
                {"validation_error"},
                {422},
            ),
            (
                "E3_add_relation_self",
                "add_relation",
                {"task_id": root_id, "to_task_id": root_id, "kind": "blocks"},
                {"validation_error"},
                {422},
            ),
            (
                "E4_apply_import_bad_fingerprint",
                "apply_import",
                {
                    "format": "markdown",
                    "content": IMPORT_CONTENT_CHANGED,
                    "fingerprint": self.fingerprint,
                    "project_name_mapping": [],
                    "tag_name_mapping": [],
                },
                {"conflict"},
                {409},
            ),
        ]
        for step, tool, arguments, codes, statuses in cases:
            result = self._call_err(step, tool, arguments)
            if result.http_status is not None and result.http_status not in statuses:
                raise HarnessError(
                    f"{step}: http status {result.http_status} not in {statuses}"
                )
            # Omit transport status from normalized digest so HTTP/CLI/MCP match.
            env = normalize_error_envelope(result.value, http_status=None)
            if env["code"] not in codes:
                raise HarnessError(f"{step}: code {env['code']!r} not in {codes}")
            # Ensure revision unchanged after each error.
            sync = self._call_ok(f"{step}_sync", "get_sync_state", {})
            if int(sync.get("revision", -1)) != EXPECTED_FINAL_REVISION:
                raise HarnessError(f"{step} changed revision: {sync}")
            self.error_steps.append(
                StepOutcome(
                    step=step,
                    tool=tool,
                    ok=False,
                    raw=result.value,
                    normalized=env,
                    revision_after=EXPECTED_FINAL_REVISION,
                )
            )


def collect_final_observation(
    server: OwnedServer,
    bearer: str,
    aliases: AliasRegistry,
) -> dict[str, Any]:
    """Authoritative final observation through authenticated HTTP only."""

    def get(path: str) -> Any:
        payload, status, _ = http_json(
            "GET",
            server.base_url,
            path,
            host=server.host,
            token=bearer,
        )
        if status != 200:
            raise HarnessError(f"observe GET {path} -> {status} {payload}")
        return payload

    root = aliases.get("task:root")
    sync = get("/api/v1/sync-state")
    epoch = str(sync["event_epoch"])
    events = sse_catchup_events(
        server.base_url,
        host=server.host,
        token=bearer,
        event_epoch=epoch,
        expected_count=EXPECTED_EVENT_COUNT,
    )
    state = {
        "profile": get("/api/v1/profile"),
        "sync_state": sync,
        "settings": get("/api/v1/settings"),
        "catalog": get("/api/v1/catalog"),
        "tasks": get("/api/v1/tasks?limit=100"),
        "task_root": get(f"/api/v1/tasks/{root}"),
        "task_root_comments": get(f"/api/v1/tasks/{root}/comments"),
        "task_root_relations": get(f"/api/v1/tasks/{root}/relations"),
        "task_root_reminders": get(f"/api/v1/tasks/{root}/reminders"),
        "task_root_activity": get(f"/api/v1/tasks/{root}/activity"),
        "time_slots": get("/api/v1/time-slots?date=2030-01-15"),
        "time_blocks": get("/api/v1/time-blocks?from=2030-01-01&to=2030-01-31"),
        "planning_daily": get(
            "/api/v1/planning/daily?date=2030-01-15&capacity_minutes=480"
        ),
        "planning_weekly": get(
            "/api/v1/planning/weekly?date=2030-01-15&week_start=sunday"
        ),
        "calendar_tasks": get("/api/v1/calendar/tasks?from=2030-01-01&to=2030-01-31"),
        "stats": get("/api/v1/stats?from=2030-01-01&to=2030-01-31"),
        "events": events,
    }
    if int(state["profile"]["revision"]) != EXPECTED_FINAL_REVISION:
        raise HarnessError(f"observe profile revision {state['profile']}")
    if int(state["sync_state"]["revision"]) != EXPECTED_FINAL_REVISION:
        raise HarnessError(f"observe sync revision {state['sync_state']}")
    if int(state["catalog"]["revision"]) != EXPECTED_FINAL_REVISION:
        raise HarnessError(f"observe catalog revision {state['catalog']}")
    if len(state["events"]) != EXPECTED_EVENT_COUNT:
        raise HarnessError(f"observe event count {len(state['events'])}")
    # Ensure event revisions are 1..17 contiguous.
    revs = [int(ev["revision"]) for ev in state["events"]]
    if revs != list(range(1, EXPECTED_EVENT_COUNT + 1)):
        raise HarnessError(f"observe event revisions not contiguous: {revs}")
    return state


def normalize_surface_bundle(
    *,
    driver: CorpusDriver,
    final_state: dict[str, Any],
) -> dict[str, Any]:
    aliases = driver.aliases
    # Ensure final-state aliases are complete (also fills op:rev-N).
    aliases.learn_from_final_state(final_state)

    normalized_steps = []
    for step in driver.success_steps:
        normalized_steps.append(
            {
                "step": step.step,
                "tool": step.tool,
                "ok": True,
                "revision_after": step.revision_after,
                "value": normalize_value(step.raw, aliases),
            }
        )
    normalized_errors = []
    for step in driver.error_steps:
        # Re-normalize details through alias mapper in case fields embed ids.
        env = deepcopy(step.normalized)
        env = normalize_value(env, aliases)
        normalized_errors.append(
            {
                "step": step.step,
                "tool": step.tool,
                "ok": False,
                "error": env,
            }
        )

    # Export inventories: drop absolute sha of file bytes that include unstable
    # timestamps inside JSON export. Compare semantic inventory only.
    export_norm = {}
    for fmt, inv in driver.export_inventories.items():
        item = dict(inv)
        # JSON export embeds created_at timestamps → sha differs across surfaces.
        item.pop("sha256", None)
        item.pop("size_bytes", None)
        export_norm[fmt] = normalize_value(item, aliases)

    backup_raw = dict(driver.backup_inventory or {})
    backup_raw.pop("_framing", None)  # surface-local framing lengths
    backup_norm = normalize_value(backup_raw, aliases)
    final_norm = normalize_value(final_state, aliases)

    bundle = {
        "success_steps": normalized_steps,
        "error_steps": normalized_errors,
        "final_state": final_norm,
        "export_inventories": export_norm,
        "backup_inventory": backup_norm,
        "final_revision": EXPECTED_FINAL_REVISION,
        "event_count": EXPECTED_EVENT_COUNT,
    }
    return bundle


# ── Surface orchestration ────────────────────────────────────────────────────


@dataclass
class SurfaceResult:
    surface: str
    accepted: bool
    digest: str
    bundle: dict[str, Any]
    assertions: dict[str, bool]
    error: str | None = None
    duration_ms: float = 0.0


def lock_is_free(profile: Path) -> bool:
    """True when no live owner holds the exclusive profile flock.

    The lock *file* may remain on disk after a clean shutdown; authority is the
    flock, matching process-lifecycle regressions in the Rust suite.
    """
    lock_path = profile / LOCK_FILE
    if not lock_path.exists():
        return True
    try:
        import fcntl

        fd = os.open(str(lock_path), os.O_RDWR)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    finally:
        os.close(fd)


def assert_lock_clean(profile: Path, *, label: str) -> None:
    if (profile / RUNTIME_FILE).exists():
        raise HarnessError(f"{label}: runtime.json retained")
    if not lock_is_free(profile):
        raise HarnessError(f"{label}: profile lock still held")


def start_server_keep_profile(
    binaries: Binaries,
    profile: Path,
    operator_token: str,
    *,
    label: str,
    work_root: Path,
) -> OwnedServer:
    """Start server on an existing profile without wiping data."""
    if not profile.is_dir():
        raise HarnessError(f"profile missing for observe: {profile}")
    token_path = profile / TOKEN_FILE
    if not token_path.is_file():
        write_private_file(token_path, operator_token)
    stderr_path = work_root / f"{label}.stderr.log"
    stderr_handle = stderr_path.open("wb")
    process = subprocess.Popen(
        [
            str(binaries.server),
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            str(profile),
            "--web-dir",
            str(binaries.web_dir),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=stderr_handle,
        cwd=str(binaries.web_dir),
    )
    stderr_handle.close()
    runtime_path = profile / RUNTIME_FILE
    holder: dict[str, Any] = {}

    def runtime_ready() -> bool:
        if process.poll() is not None:
            tail = stderr_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise HarnessError(f"{label}: server exited early ({process.returncode}): {tail}")
        if not runtime_path.is_file():
            return False
        try:
            data = json.loads(runtime_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        address = data.get("address")
        if not isinstance(address, str) or not address.startswith("127.0.0.1:"):
            return False
        holder["runtime"] = data
        return True

    try:
        poll_until(READY_TIMEOUT_SECONDS, runtime_ready, f"{label}: runtime.json not ready")
    except Exception:
        if process.poll() is None:
            process.kill()
        raise
    address = str(holder["runtime"]["address"])
    base_url = f"http://{address}"

    def health_ready() -> bool:
        try:
            payload, status, _ = http_json("GET", base_url, "/api/v1/health", host=address)
        except HarnessError:
            return False
        return status == 200 and isinstance(payload, dict) and bool(payload.get("status"))

    poll_until(READY_TIMEOUT_SECONDS, health_ready, f"{label}: health not ready")
    return OwnedServer(
        profile=profile,
        process=process,
        base_url=base_url,
        host=address,
        operator_token=operator_token,
        stderr_path=stderr_path,
        unit_label=label,
    )


def run_surface_fixed(
    surface: str,
    *,
    binaries: Binaries,
    work_root: Path,
    secrets_acc: set[str],
) -> SurfaceResult:
    """Correct surface runner (cli_local observe does not wipe)."""
    t0 = time.perf_counter()
    profile = work_root / f"{surface}-profile"
    artifacts = work_root / f"{surface}-artifacts"
    ensure_mode700(artifacts)
    operator_token = mint_operator_token()
    secrets_acc.add(operator_token)
    server: OwnedServer | None = None
    runner: SurfaceRunner | None = None
    cred_path = work_root / f"{surface}.credential"
    automation_token: str | None = None

    assertions = {
        "corpus_ok": False,
        "errors_ok": False,
        "final_revision_ok": False,
        "events_ok": False,
        "backup_ok": False,
        "exports_ok": False,
        "cleanup_ok": False,
        "no_secret_leak": False,
    }
    try:
        aliases = AliasRegistry()

        if surface == "cli_local":
            prepare_profile(profile, operator_token)
            runner = CliRunner(
                binaries,
                name="cli_local",
                data_dir=profile,
                server_url=None,
                credential_file=None,
                secrets=secrets_acc,
            )
            driver = CorpusDriver(runner, aliases=aliases, artifact_dir=artifacts)
            driver.run_success_corpus()
            assertions["corpus_ok"] = True
            driver.run_error_corpus()
            assertions["errors_ok"] = True
            runner.close()
            runner = None
            assert_lock_clean(profile, label="cli_local post-corpus")

            server = start_server_keep_profile(
                binaries,
                profile,
                operator_token,
                label=f"{surface}-observe",
                work_root=work_root,
            )
            # Observation may use operator credential.
            final_state = collect_final_observation(server, operator_token, aliases)
        else:
            server = start_server(
                binaries,
                profile,
                operator_token,
                label=surface,
                work_root=work_root,
            )
            automation_token = create_automation_credential(server, cred_path)
            secrets_acc.add(automation_token)

            if surface == "http":
                runner = HttpRunner(server, automation_token, artifacts)
            elif surface == "cli_remote":
                runner = CliRunner(
                    binaries,
                    name="cli_remote",
                    data_dir=profile,
                    server_url=server.base_url,
                    credential_file=cred_path,
                    secrets=secrets_acc,
                )
            elif surface == "mcp":
                runner = McpRunner(
                    binaries,
                    data_dir=profile,
                    server_url=server.base_url,
                    credential_file=cred_path,
                    secrets=secrets_acc,
                )
            else:
                raise HarnessError(f"unknown surface {surface}")

            driver = CorpusDriver(runner, aliases=aliases, artifact_dir=artifacts)
            driver.run_success_corpus()
            assertions["corpus_ok"] = True
            driver.run_error_corpus()
            assertions["errors_ok"] = True
            runner.close()
            runner = None
            final_state = collect_final_observation(server, automation_token, aliases)

        assertions["final_revision_ok"] = (
            int(final_state["sync_state"]["revision"]) == EXPECTED_FINAL_REVISION
        )
        assertions["events_ok"] = len(final_state["events"]) == EXPECTED_EVENT_COUNT
        assertions["backup_ok"] = driver.backup_inventory is not None
        assertions["exports_ok"] = set(driver.export_inventories) == {
            "json",
            "csv",
            "markdown",
        }

        bundle = normalize_surface_bundle(driver=driver, final_state=final_state)
        digest = digest_value(bundle)

        server.stop()
        server = None
        assert_lock_clean(profile, label=f"{surface} final")
        assertions["cleanup_ok"] = True

        blob = canonical_json(bundle)
        assert_no_secrets(blob, secrets_acc, where=f"{surface} normalized bundle")
        assertions["no_secret_leak"] = True

        return SurfaceResult(
            surface=surface,
            accepted=all(assertions.values()),
            digest=digest,
            bundle=bundle,
            assertions=assertions,
            duration_ms=(time.perf_counter() - t0) * 1000.0,
        )
    except Exception as error:
        err = f"{type(error).__name__}: {error}"
        # Include brief traceback on stderr for diagnosis; not in retained JSON secrets.
        eprint(f"[{surface}] {err}")
        eprint(traceback.format_exc(limit=20))
        return SurfaceResult(
            surface=surface,
            accepted=False,
            digest="",
            bundle={},
            assertions=assertions,
            error=err,
            duration_ms=(time.perf_counter() - t0) * 1000.0,
        )
    finally:
        if runner is not None:
            try:
                runner.close()
            except Exception:
                pass
        if server is not None:
            try:
                server.stop()
            except Exception:
                pass


# ── Self-check ───────────────────────────────────────────────────────────────


def run_self_check() -> int:
    """Validate harness rejection helpers without requiring full product run."""
    failures = 0

    def check(name: str, cond: bool) -> None:
        nonlocal failures
        if cond:
            print(f"self-check PASS {name}")
        else:
            print(f"self-check FAIL {name}")
            failures += 1

    # Secret detection
    secrets_set = {"super-secret-token-value"}
    check(
        "detects bearer",
        secret_leak_in("Authorization: Bearer abcdefghijklmnop.token", set())
        is not None,
    )
    check(
        "ignores bearer prose",
        secret_leak_in('never echo bearer tokens.', set()) is None,
    )
    check(
        "detects known secret",
        secret_leak_in("x super-secret-token-value y", secrets_set) is not None,
    )
    check("clean text", secret_leak_in("revision 17", secrets_set) is None)

    # Alias unknown UUID rejection
    aliases = AliasRegistry()
    aliases.bind("task:root", "11111111-1111-1111-1111-111111111111")
    try:
        normalize_value(
            {"id": "22222222-2222-2222-2222-222222222222"},
            aliases,
            path="$.id",
        )
        check("reject unknown uuid", False)
    except HarnessError:
        check("reject unknown uuid", True)

    # Canonical digest stability
    a = digest_value({"z": 1, "a": [2, 3]})
    b = digest_value({"a": [2, 3], "z": 1})
    check("canonical digest", a == b)

    # Error envelope unification
    http_err = {
        "error": {
            "code": "not_found",
            "message": "resource was not found",
            "retryable": False,
        },
        "request_id": "abc",
    }
    cli_err = {
        "error": {
            "code": "not_found",
            "message": "resource was not found",
            "retryable": False,
            "request_id": "abc",
        }
    }
    n1 = normalize_error_envelope(http_err)
    n2 = normalize_error_envelope(cli_err)
    check("error unify", n1 == n2)

    # Backup validator rejects bad magic
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "bad.junban-backup"
        bad.write_bytes(b"XXXX" + b"\x00" * 50)
        try:
            validate_backup_artifact(bad)
            check("backup bad magic", False)
        except HarnessError:
            check("backup bad magic", True)

    return 1 if failures else 0


# ── Main ─────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Junban Phase 5 cross-surface conformance harness",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=None,
        help="Repository root (default: parent of scripts/)",
    )
    parser.add_argument("--server", type=Path, default=None, help="Path to junban-server")
    parser.add_argument("--cli", type=Path, default=None, help="Path to junban")
    parser.add_argument("--mcp", type=Path, default=None, help="Path to junban-mcp")
    parser.add_argument(
        "--web-dir",
        type=Path,
        default=None,
        help="Static web dir for junban-server (default: repo root)",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="Run cargo build --release for server/cli/mcp before the run",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Write deterministic detailed JSON evidence (no secrets)",
    )
    parser.add_argument(
        "--surface",
        action="append",
        choices=list(SURFACES),
        default=None,
        help="Limit to one or more surfaces (default: all four)",
    )
    parser.add_argument(
        "--keep-work",
        action="store_true",
        help="Retain temporary profiles/artifacts for debugging",
    )
    parser.add_argument(
        "--authoritative",
        action="store_true",
        help="Require a clean git tree and record commit/binary hashes",
    )
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run harness unit self-checks only (not acceptance evidence)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_check:
        return run_self_check()

    repo = (args.repo or default_repo_root()).resolve()
    if not (repo / "Cargo.toml").is_file():
        eprint(f"error: {repo} does not look like the Junban repo")
        return 2

    if args.authoritative and git_dirty(repo):
        eprint("error: authoritative mode requires a clean git working tree")
        return 2

    try:
        binaries = resolve_binaries(
            repo,
            server=args.server,
            cli=args.cli,
            mcp=args.mcp,
            web_dir=args.web_dir,
            build=args.build,
        )
    except HarnessError as error:
        eprint(f"error: {error}")
        return 2

    surfaces = args.surface or list(SURFACES)
    commit = git_head(repo)
    work_root = Path(tempfile.mkdtemp(prefix="junban-phase5-conformance-"))
    os.chmod(work_root, 0o700)
    secrets_acc: set[str] = set()
    results: list[SurfaceResult] = []

    print(
        json.dumps(
            {
                "protocol": PROTOCOL_NAME,
                "version": PROTOCOL_VERSION,
                "commit": commit,
                "surfaces": surfaces,
                "work_root": str(work_root) if args.keep_work else "<ephemeral>",
            },
            sort_keys=True,
        )
    )

    try:
        for surface in surfaces:
            eprint(f"running surface {surface} ...")
            result = run_surface_fixed(
                surface,
                binaries=binaries,
                work_root=work_root,
                secrets_acc=secrets_acc,
            )
            results.append(result)
            status = "PASS" if result.accepted and not result.error else "FAIL"
            eprint(
                f"  {surface}: {status} digest={result.digest[:16] or '-'} "
                f"ms={result.duration_ms:.1f}"
                + (f" error={result.error}" if result.error else "")
            )
    finally:
        if not args.keep_work:
            shutil.rmtree(work_root, ignore_errors=True)

    # Cross-surface comparison
    accepted_results = [r for r in results if r.accepted and r.digest]
    digests = {r.surface: r.digest for r in accepted_results}
    unique_digests = set(digests.values())
    cross_match = (
        len(accepted_results) == len(surfaces)
        and len(unique_digests) == 1
        and all(r.error is None for r in results)
    )

    # If digests differ, compute first mismatch path for diagnosis.
    mismatch_note = None
    if len(unique_digests) > 1 and len(accepted_results) >= 2:
        base = accepted_results[0]
        for other in accepted_results[1:]:
            if other.digest != base.digest:
                mismatch_note = first_mismatch(base.bundle, other.bundle, base.surface, other.surface)
                break

    overall = cross_match and all(r.accepted for r in results)

    summary = {
        "protocol": PROTOCOL_NAME,
        "protocol_version": PROTOCOL_VERSION,
        "commit": commit,
        "authoritative": bool(args.authoritative),
        "binaries": {
            "server": binary_record(binaries.server),
            "cli": binary_record(binaries.cli),
            "mcp": binary_record(binaries.mcp),
        },
        "surfaces": {
            r.surface: {
                "accepted": r.accepted,
                "digest": r.digest,
                "assertions": r.assertions,
                "duration_ms": round(r.duration_ms, 3),
                "error": r.error,
            }
            for r in results
        },
        "cross_surface_digest_match": cross_match,
        "reference_digest": next(iter(unique_digests), None) if len(unique_digests) == 1 else None,
        "mismatch": mismatch_note,
        "accepted": overall,
        "generated_at": utc_now_iso(),
    }

    # Concise stdout summary (no secrets).
    print(canonical_json(summary))
    if not overall:
        eprint("CONFORMANCE FAILED")
        if mismatch_note:
            eprint(f"mismatch: {mismatch_note}")
        for r in results:
            if r.error:
                eprint(f"  {r.surface}: {r.error}")
    else:
        eprint("CONFORMANCE PASSED")

    if args.output:
        # Detailed evidence without secrets: include normalized bundles.
        detailed = {
            **summary,
            "normalized_bundles": {r.surface: r.bundle for r in results if r.bundle},
        }
        out_text = canonical_json(detailed) + "\n"
        assert_no_secrets(out_text, secrets_acc, where="--output evidence")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(out_text, encoding="utf-8")
        eprint(f"wrote {args.output}")

    return 0 if overall else 1


def first_mismatch(a: Any, b: Any, a_name: str, b_name: str, path: str = "$") -> str:
    if type(a) is not type(b):
        return f"{path}: type {type(a).__name__} ({a_name}) != {type(b).__name__} ({b_name})"
    if isinstance(a, dict):
        a_keys = set(a)
        b_keys = set(b)
        if a_keys != b_keys:
            only_a = sorted(a_keys - b_keys)
            only_b = sorted(b_keys - a_keys)
            return f"{path}: keys only in {a_name}={only_a[:8]} only in {b_name}={only_b[:8]}"
        for key in sorted(a_keys):
            note = first_mismatch(a[key], b[key], a_name, b_name, f"{path}.{key}")
            if note:
                return note
        return ""
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: len {len(a)} ({a_name}) != {len(b)} ({b_name})"
        for idx, (av, bv) in enumerate(zip(a, b)):
            note = first_mismatch(av, bv, a_name, b_name, f"{path}[{idx}]")
            if note:
                return note
        return ""
    if a != b:
        return f"{path}: {a!r} ({a_name}) != {b!r} ({b_name})"
    return ""


if __name__ == "__main__":
    sys.exit(main())
