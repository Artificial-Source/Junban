#!/usr/bin/env python3
"""Optimized-product Phase 7 plugin dogfood harness.

This Linux, Python-standard-library runtime authority starts the real release
server and its adjacent plugin host, drives only authenticated production HTTP
routes, constructs disposable externally signed packages outside the checkout,
and writes a bounded JSON result outside the checkout. Browser UI evidence stays
separately owned by the immutable Phase 7 visual authority.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, NoReturn

ROOT = Path(__file__).resolve().parent.parent
PROTOCOL = "junban-phase7-plugin-dogfood-v3"
PROTOCOL_VERSION = 3
SCHEMA_VERSION = 3
TOKEN_FILE = "access-token"
RUNTIME_FILE = "runtime.json"
LOCK_FILE = "profile.lock"
POLL_INTERVAL = 0.025
REPORT_BYTES_MAX = 256 * 1024
DIAGNOSTIC_BYTES_MAX = 4 * 1024
PACKAGE_UPLOAD_BYTES_MAX = 34_603_008
DOGFOOD_BACKUP_BYTES_MAX = 64 * 1024 * 1024
NODE_NAMES = frozenset(
    {"node", "nodejs", "npm", "pnpm", "npx", "vite", "playwright", "chromium", "chrome", "firefox"}
)
PUBLISHER_KEY_ID = "35ab9815a29650c2985186daa06eef9362ff0312b89df0b080517ddcf18b8595"
REGISTRY_AUTHORITY = (
    ("automation", "14457dc76c42c23178ec56fa5e4fcb9fa27dd1996a795db70cf64adf07e48ee1", "rust"),
    ("import-typescript", "69daf8a5346a7d9e213f8d4e49aaa11f12014ebfa1252082750e1597d1805085", "typescript"),
    ("pomodoro", "829723f49e2ec911f93d40dfcc2664ee08f495f9e710d227434f07456e0d103b", "rust"),
)
REFERENCE_FILES = (
    "plugins/reference/automation-rust/plugin-source.json",
    "plugins/reference/automation-rust/reference-authority.json",
    "plugins/reference/automation-rust/artifacts/automation.wasm",
    "plugins/reference/import-typescript/plugin-source.json",
    "plugins/reference/import-typescript/component-provenance.json",
    "plugins/reference/import-typescript/artifacts/import-typescript.wasm",
    "plugins/reference/pomodoro-rust/plugin-source.json",
    "plugins/reference/pomodoro-rust/reference-authority.json",
    "plugins/reference/pomodoro-rust/artifacts/pomodoro.wasm",
    "plugins/registry/registry-source.json",
    "plugins/registry/root-public-key.bin",
    "plugins/registry/publisher-public-key.bin",
    "plugins/registry/index.jri",
    "crates/junban-server/src/bundled_registry_include.rs",
) + tuple(f"plugins/registry/sha256/{digest}.jbp" for _, digest, _ in REGISTRY_AUTHORITY)
OPERATION_NAMESPACE = uuid.UUID("d0de846d-688a-5b04-8180-d7cd8fca4ac8")
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_.=+/-]{16,}")
AUTH_HEADER_RE = re.compile(r"(?i)authorization\s*:\s*[^\s,}\]]+")
TOKENISH_RE = re.compile(r"\b(?:jba_[0-9a-f-]{36}_[0-9a-f]{64}|[0-9a-f]{64,})\b", re.I)
OPTIMIZED_BINARY_DIR = Path("target/release")
BROWSER_UI_AUTHORITY = "tests/e2e/visual-phase-7.spec.ts"
HOSTILE_RUNTIME_AUTHORITY = {
    "id": "P7-W2-HOSTILE-RUNTIME-651cf753",
    "commit": "651cf7530c951302be0e135143360706a42a9eac",
    "review": "goals/rust-rewrite/evidence/phase-7-review-ledger.md",
    "tests": [
        "hostile_guest_limits_are_stable_and_do_not_leak_guest_diagnostics",
        "eof_and_malformed_input_abort_active_callbacks_without_orphans",
        "multi_entry_eof_and_malformed_input_join_every_worker",
        "timeout_epoch_and_trap_replacement_are_isolated_per_plugin",
    ],
}
HOSTILE_RUNTIME_TEST_FILES = (
    "crates/junban-plugin-host/src/lib.rs",
    "crates/junban-plugin-host/tests/child_process.rs",
    "crates/junban-plugin-host/tests/containment.rs",
    "crates/junban-plugin-host/tests/process_host.rs",
)
AUTHORITATIVE_BUILD_COMMANDS = (
    ("cargo", "clean", "--release"),
    ("cargo", "build", "--locked", "--release", "--workspace", "--all-features"),
    ("pnpm", "build"),
)
REQUIRED_CORPUS_SEGMENTS = (
    "owner_isolation",
    "dormant",
    "typescript",
    "pomodoro",
    "automation",
    "local_signer",
    "altered_authority",
    "community_policy",
    "dependencies",
    "backup_restore_restart",
    "cleanup_corpus",
)
REQUIRED_CLEANUP_CHECKS = (
    "temporary_root_removed",
    "runtime_removed",
    "profile_lock_reacquired",
    "descendants_gone",
    "no_host_orphan",
    "restore_owner_start_passed",
    "second_owner_start_passed",
    "seed_removed",
    "seed_memory_cleared",
    "generated_fixture_root_removed",
    "backup_artifact_removed",
)


class HarnessError(RuntimeError):
    """A fail-closed precondition, corpus, or cleanup failure."""


def fail(message: str) -> NoReturn:
    raise HarnessError(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_identity(path: Path, name: str) -> dict[str, Any]:
    return {"name": name, "sha256": sha256_file(path), "size_bytes": path.stat().st_size}


def tree_identity(root: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    count = 0
    size = 0
    files = (value for value in root.rglob("*") if value.is_file())
    for path in sorted(files, key=lambda value: value.as_posix()):
        if path.is_symlink():
            fail("production web tree contains a symbolic link")
        relative = path.relative_to(root).as_posix().encode("utf-8")
        content_digest = sha256_file(path)
        file_size = path.stat().st_size
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(content_digest))
        digest.update(file_size.to_bytes(8, "big"))
        count += 1
        size += file_size
    if count == 0:
        fail("production web tree is empty")
    return {"tree_sha256": digest.hexdigest(), "file_count": count, "total_bytes": size}


def response_identity(raw: bytes) -> dict[str, Any]:
    return {"sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}


def hostile_runtime_tests_identity() -> str:
    digest = hashlib.sha256()
    for relative in HOSTILE_RUNTIME_TEST_FILES:
        committed = run_command(
            ["git", "-C", str(ROOT), "show", f'{HOSTILE_RUNTIME_AUTHORITY["commit"]}:{relative}'],
            timeout=10,
        )
        if committed.returncode != 0 or not committed.stdout:
            fail("accepted hostile-runtime test authority is unavailable")
        encoded_relative = relative.encode("utf-8")
        digest.update(len(encoded_relative).to_bytes(4, "big"))
        digest.update(encoded_relative)
        digest.update(len(committed.stdout).to_bytes(8, "big"))
        digest.update(committed.stdout)
    return digest.hexdigest()


def package_object_path(profile: Path, digest: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        fail("package object digest was malformed")
    return profile / "plugins" / "packages" / "sha256" / f"{digest}.jbp"


def remove_candidate_outputs(release_dir: Path, dist: Path) -> None:
    shutil.rmtree(release_dir, ignore_errors=True)
    shutil.rmtree(dist, ignore_errors=True)


def authoritative_rebuild() -> dict[str, Any]:
    before = candidate_snapshot()
    if before["dirty"]:
        fail("authoritative mode requires a clean candidate before rebuilding outputs")
    remove_candidate_outputs(ROOT / "target/release", ROOT / "dist")
    for command in AUTHORITATIVE_BUILD_COMMANDS:
        result = run_command(list(command), timeout=3600)
        if result.returncode != 0:
            fail(f"authoritative candidate build failed: {command[0]} {command[1]}")
    after = candidate_snapshot()
    if before != after or after["dirty"]:
        fail("candidate source identity changed during authoritative rebuild")
    return {
        "mode": "clean_in_place_rebuild",
        "commands": [" ".join(command) for command in AUTHORITATIVE_BUILD_COMMANDS],
        "source_before": before,
        "source_after": after,
    }


def run_command(
    arguments: list[str], *, timeout: float, cwd: Path = ROOT
) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(arguments, cwd=cwd, capture_output=True, check=False, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HarnessError(f"command could not complete: {Path(arguments[0]).name}") from error


def git_value(*arguments: str) -> str:
    result = run_command(["git", "-C", str(ROOT), *arguments], timeout=10)
    if result.returncode != 0:
        fail("git candidate identity could not be read")
    return result.stdout.decode("utf-8", errors="strict").strip()


def git_dirty() -> bool:
    result = run_command(["git", "-C", str(ROOT), "status", "--porcelain"], timeout=10)
    if result.returncode != 0:
        fail("git dirtiness could not be read")
    return bool(result.stdout.strip())


def candidate_snapshot() -> dict[str, Any]:
    status = run_command(
        [
            "git",
            "-C",
            str(ROOT),
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
        timeout=10,
    )
    diff = run_command(
        ["git", "-C", str(ROOT), "diff", "--no-ext-diff", "--binary", "HEAD"], timeout=30
    )
    if status.returncode != 0 or diff.returncode != 0:
        fail("git working-state identity could not be read")
    state = hashlib.sha256()
    state.update(status.stdout)
    state.update(diff.stdout)
    for entry in status.stdout.split(b"\0"):
        if len(entry) < 4 or not entry.startswith(b"?? "):
            continue
        relative = entry[3:].decode("utf-8", errors="strict")
        path = ROOT / relative
        if path.is_file() and not path.is_symlink():
            state.update(relative.encode("utf-8"))
            state.update(bytes.fromhex(sha256_file(path)))
            state.update(path.stat().st_size.to_bytes(8, "big"))
    return {
        "commit": git_value("rev-parse", "HEAD"),
        "commit_tree": git_value("rev-parse", "HEAD^{tree}"),
        "index_tree": git_value("write-tree"),
        "working_state_sha256": state.hexdigest(),
        "dirty": bool(status.stdout),
    }


def within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_regular(path: Path, label: str, *, executable: bool = False) -> Path:
    expanded = path.expanduser()
    try:
        metadata = expanded.lstat()
        resolved = expanded.resolve(strict=True)
    except OSError as error:
        raise HarnessError(f"required {label} is missing") from error
    if stat.S_ISLNK(metadata.st_mode) or not resolved.is_file():
        fail(f"required {label} must be a regular non-link file")
    if executable and not os.access(resolved, os.X_OK):
        fail(f"required {label} is not executable")
    return resolved


def validate_output(path: Path) -> Path:
    expanded = path.expanduser()
    parent = expanded.parent.resolve(strict=True)
    resolved = parent / expanded.name
    if within(resolved, ROOT.resolve()):
        fail("--output must be outside the checkout")
    if expanded.exists():
        if expanded.is_symlink():
            fail("--output must not be a symbolic link")
        fail("--output must not already exist")
    return resolved


def validate_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path, Path, Path]:
    if sys.platform != "linux" or not Path("/proc/self/status").is_file():
        fail("the plugin dogfood harness requires Linux /proc")
    server = resolve_regular(args.server, "junban-server", executable=True)
    host = resolve_regular(args.host, "junban-plugin-host", executable=True)
    artifact_tool = resolve_regular(args.artifact_tool, "junban-plugin-artifact", executable=True)
    if server.name != "junban-server" or host.name != "junban-plugin-host":
        fail("product executables must use their canonical names")
    discovered = resolve_regular(
        server.parent / "junban-plugin-host", "discovered sibling host", executable=True
    )
    if host != discovered or server.parent != host.parent:
        fail("--host must be the exact real adjacent sibling discovered by junban-server")
    supplied_web_dir = args.web_dir.expanduser()
    if supplied_web_dir.is_symlink():
        fail("--web-dir must not be a symbolic link")
    web_dir = supplied_web_dir.resolve(strict=True)
    if not web_dir.is_dir() or not (web_dir / "index.html").is_file():
        fail("--web-dir must be a real built production dist containing index.html")
    output = validate_output(args.output)
    if args.authoritative:
        expected_directory = (ROOT / OPTIMIZED_BINARY_DIR).resolve(strict=True)
        expected_web = (ROOT / "dist").resolve(strict=True)
        if (
            server != expected_directory / "junban-server"
            or host != expected_directory / "junban-plugin-host"
            or artifact_tool != expected_directory / "junban-plugin-artifact"
        ):
            fail("authoritative mode requires exact product binaries from target/release")
        if web_dir != expected_web:
            fail("authoritative mode requires the exact freshly rebuilt production dist")
    return server, host, artifact_tool, web_dir, output


def operation(label: str) -> str:
    return str(uuid.uuid5(OPERATION_NAMESPACE, label))


def poll_until(timeout: float, predicate: Callable[[], bool], message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(POLL_INTERVAL)
    fail(message)


def redact(text: str, secrets: set[str], private_root: Path | None) -> str:
    value = text
    if private_root is not None:
        value = value.replace(str(private_root), "<private-run-root>")
    for secret in sorted((item for item in secrets if item), key=len, reverse=True):
        value = value.replace(secret, "<redacted>")
    value = BEARER_RE.sub("Bearer <redacted>", value)
    value = AUTH_HEADER_RE.sub("Authorization: <redacted>", value)
    if len(value.encode("utf-8", errors="replace")) > DIAGNOSTIC_BYTES_MAX:
        value = value.encode("utf-8", errors="replace")[-DIAGNOSTIC_BYTES_MAX:].decode("utf-8", errors="replace")
        value = "[diagnostic tail truncated]\n" + value
    return value


def assert_report_safe(encoded: str, secrets: set[str], private_root: Path | None) -> None:
    if BEARER_RE.search(encoded) or AUTH_HEADER_RE.search(encoded):
        fail("result contains an authorization marker")
    if private_root is not None and str(private_root) in encoded:
        fail("result contains the private run path")
    for secret in secrets:
        if secret and secret in encoded:
            fail("result contains known secret material")
    if len(encoded.encode("utf-8")) > REPORT_BYTES_MAX:
        fail("result exceeds the bounded JSON size")


def write_report(
    path: Path,
    report: dict[str, Any],
    secrets: set[str],
    private_root: Path | None,
) -> None:
    encoded = json.dumps(report, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    assert_report_safe(encoded, secrets, private_root)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        # The destination was rejected if present during preflight; link is
        # no-clobber so a later competing writer cannot be overwritten.
        os.link(temporary, path, follow_symlinks=False)
        os.chmod(path, 0o600)
        temporary.unlink()
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def proc_children(pid: int) -> list[int]:
    # Linux accounts a child under the thread that spawned it, not necessarily
    # the thread-group leader. Union every task's children file.
    result: set[int] = set()
    try:
        children_files = list(Path(f"/proc/{pid}/task").glob("*/children"))
    except OSError:
        return []
    for path in children_files:
        try:
            result.update(int(value) for value in path.read_text(encoding="ascii").split())
        except (OSError, ValueError):
            continue
    return sorted(result)


def descendants(pid: int) -> list[int]:
    result: list[int] = []
    pending = proc_children(pid)
    seen: set[int] = set()
    while pending:
        child = pending.pop()
        if child in seen or not Path(f"/proc/{child}").exists():
            continue
        seen.add(child)
        result.append(child)
        pending.extend(proc_children(child))
    return sorted(result)


def proc_exe(pid: int) -> Path | None:
    try:
        return Path(os.readlink(f"/proc/{pid}/exe")).resolve(strict=True)
    except OSError:
        return None


def proc_name(pid: int) -> str:
    executable = proc_exe(pid)
    if executable is not None:
        return executable.name
    try:
        return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()
    except OSError:
        return "unavailable"


def process_observation(
    server_pid: int,
    expected_server: Path,
    expected_host: Path,
    label: str,
    *,
    active: bool,
) -> tuple[dict[str, Any], set[int]]:
    if proc_exe(server_pid) != expected_server:
        fail(f"{label}: exact server process is unavailable")
    child_pids = descendants(server_pid)
    names = [proc_name(pid) for pid in child_pids]
    lowered = {name.lower() for name in names}
    forbidden = sorted(lowered.intersection(NODE_NAMES))
    if forbidden:
        fail(f"{label}: forbidden runtime descendant observed ({','.join(forbidden)})")
    host_pids = [pid for pid in child_pids if proc_exe(pid) == expected_host]
    unexpected = [pid for pid in child_pids if pid not in host_pids]
    if active:
        if len(host_pids) != 1 or unexpected:
            fail(f"{label}: active runtime must have exactly one plugin-host descendant")
    elif child_pids:
        fail(f"{label}: dormant runtime retained descendants")
    return (
        {
            "label": label,
            "server_count": 1,
            "descendant_count": len(child_pids),
            "descendant_names": sorted(names),
        },
        set(child_pids),
    )


def exact_host_processes(expected_host: Path) -> list[int]:
    matches: list[int] = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and proc_exe(int(entry.name)) == expected_host:
            matches.append(int(entry.name))
    return matches


def lock_is_free(profile: Path) -> bool:
    lock_path = profile / LOCK_FILE
    if not lock_path.exists():
        return True
    try:
        import fcntl

        descriptor = os.open(lock_path, os.O_RDWR)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return True
    finally:
        os.close(descriptor)


class ProductServer:
    def __init__(
        self,
        server: Path,
        host: Path,
        web_dir: Path,
        profile: Path,
        private_root: Path,
        secrets: set[str],
        startup_timeout: float,
        call_timeout: float,
        shutdown_timeout: float,
        label: str,
    ) -> None:
        self.server_path = server
        self.host_path = host
        self.web_dir = web_dir
        self.profile = profile
        self.private_root = private_root
        self.secrets = secrets
        self.startup_timeout = startup_timeout
        self.call_timeout = call_timeout
        self.shutdown_timeout = shutdown_timeout
        self.label = label
        self.process: subprocess.Popen[bytes] | None = None
        self.stderr_path = private_root / f"{label}.stderr"
        self.base_url = ""
        self.address = ""
        self.token = ""
        self.observed_descendants: set[int] = set()
        self.preexisting_host_pids: set[int] = set()
        self.forced_kill = False

    def diagnostic(self) -> str:
        try:
            raw = self.stderr_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "private server diagnostics unavailable"
        return redact(raw, self.secrets, self.private_root)

    def start(self, *, existing_profile: bool = False) -> None:
        self.preexisting_host_pids = set(exact_host_processes(self.host_path))
        if existing_profile:
            if not self.profile.is_dir() or self.profile.is_symlink():
                fail(f"{self.label}: existing profile is unavailable")
        else:
            self.profile.mkdir(mode=0o700, parents=True, exist_ok=False)
        os.chmod(self.profile, 0o700)
        stderr_handle = self.stderr_path.open("wb")
        try:
            self.process = subprocess.Popen(
                [
                    str(self.server_path),
                    "--bind",
                    "127.0.0.1:0",
                    "--data-dir",
                    str(self.profile),
                    "--web-dir",
                    str(self.web_dir),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=stderr_handle,
                cwd=self.web_dir,
                start_new_session=True,
                umask=0o077,
            )
        finally:
            stderr_handle.close()
        runtime_path = self.profile / RUNTIME_FILE
        holder: dict[str, Any] = {}

        def runtime_ready() -> bool:
            assert self.process is not None
            if self.process.poll() is not None:
                fail(f"{self.label}: server exited during startup: {self.diagnostic()}")
            try:
                value = json.loads(runtime_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            if set(value) != {"version", "address", "pid", "instance_id"} or value.get("version") != 1:
                return False
            address = value.get("address")
            if not isinstance(address, str) or not address.startswith("127.0.0.1:"):
                return False
            if value.get("pid") != self.process.pid or not isinstance(value.get("instance_id"), str):
                return False
            holder.update(value)
            return True

        poll_until(self.startup_timeout, runtime_ready, f"{self.label}: runtime publication timed out")
        token_path = self.profile / TOKEN_FILE
        try:
            token = token_path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise HarnessError(f"{self.label}: server token publication failed") from error
        if len(token) < 64 or any(character.isspace() for character in token):
            fail(f"{self.label}: server token publication was invalid")
        self.token = token
        self.secrets.add(token)
        self.address = holder["address"]
        self.base_url = f"http://{self.address}"

        def health_ready() -> bool:
            try:
                _, status, _ = self.request("GET", "/api/v1/health", authenticated=False)
                return status == 200
            except HarnessError:
                return False

        poll_until(self.startup_timeout, health_ready, f"{self.label}: health readiness timed out")

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        operation_id: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Any, int, bytes]:
        headers = {"Host": self.address, "Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.token}"
        data: bytes | None = None
        if body is not None:
            data = canonical_json(body)
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["Origin"] = self.base_url
        if operation_id is not None:
            try:
                uuid.UUID(operation_id)
            except ValueError as error:
                raise HarnessError("invalid harness operation identity") from error
            headers["Idempotency-Key"] = operation_id
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.call_timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            raw = error.read(2 * 1024 * 1024 + 1)
            status = int(error.code)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            raise HarnessError(f"HTTP {method} {path} did not complete") from error
        if len(raw) > 2 * 1024 * 1024:
            fail(f"HTTP {method} {path} exceeded response bound")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError(f"HTTP {method} {path} returned malformed JSON") from error
        return payload, status, raw

    def request_octets(
        self,
        method: str,
        path: str,
        source: Path,
        *,
        operation_id: str | None = None,
        maximum_bytes: int = PACKAGE_UPLOAD_BYTES_MAX,
    ) -> tuple[Any, int, bytes]:
        try:
            metadata = source.stat()
        except OSError as error:
            raise HarnessError("private upload artifact is unavailable") from error
        if (
            source.is_symlink()
            or not source.is_file()
            or metadata.st_size <= 0
            or metadata.st_size > maximum_bytes
        ):
            fail("private upload artifact violated its size or file bound")
        try:
            data = source.read_bytes()
        except OSError as error:
            raise HarnessError("private upload artifact could not be read") from error
        if len(data) != metadata.st_size:
            fail("private upload artifact changed while being read")
        headers = {
            "Host": self.address,
            "Accept": "application/json",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(data)),
            "Origin": self.base_url,
        }
        if operation_id is not None:
            try:
                uuid.UUID(operation_id)
            except ValueError as error:
                raise HarnessError("invalid harness operation identity") from error
            headers["Idempotency-Key"] = operation_id
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self.call_timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            raw = error.read(2 * 1024 * 1024 + 1)
            status = int(error.code)
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            raise HarnessError(f"HTTP {method} {path} did not complete") from error
        if len(raw) > 2 * 1024 * 1024:
            fail(f"HTTP {method} {path} exceeded response bound")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError(f"HTTP {method} {path} returned malformed JSON") from error
        return payload, status, raw

    def expect_octets(
        self,
        method: str,
        path: str,
        status_expected: int,
        source: Path,
        *,
        operation_id: str | None = None,
        maximum_bytes: int = PACKAGE_UPLOAD_BYTES_MAX,
    ) -> tuple[Any, bytes]:
        payload, status, raw = self.request_octets(
            method,
            path,
            source,
            operation_id=operation_id,
            maximum_bytes=maximum_bytes,
        )
        if status != status_expected:
            error_value = payload.get("error", {}) if isinstance(payload, dict) else {}
            code = error_value.get("code") if isinstance(error_value, dict) else None
            fail(
                f"HTTP {method} {path} returned {status}, expected {status_expected} "
                f"(code={code or 'none'})"
            )
        return payload, raw

    def download_backup(self, destination: Path) -> None:
        if destination.exists() or destination.is_symlink():
            fail("private backup destination already exists")
        headers = {
            "Host": self.address,
            "Accept": "application/octet-stream",
            "Authorization": f"Bearer {self.token}",
        }
        request = urllib.request.Request(
            self.base_url + "/api/v1/backup", headers=headers, method="GET"
        )
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        total = 0
        try:
            with os.fdopen(descriptor, "wb") as output_handle:
                try:
                    response = urllib.request.urlopen(request, timeout=self.call_timeout)
                except urllib.error.HTTPError as error:
                    raw = error.read(2 * 1024 * 1024 + 1)
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except (UnicodeError, json.JSONDecodeError):
                        payload = None
                    code = (
                        payload.get("error", {}).get("code")
                        if isinstance(payload, dict)
                        else None
                    )
                    fail(f"backup download returned HTTP {error.code} (code={code or 'none'})")
                except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
                    raise HarnessError("backup download did not complete") from error
                with response:
                    if response.status != 200:
                        fail("backup download returned an unexpected status")
                    if response.headers.get_content_type() != "application/octet-stream":
                        fail("backup download returned an unexpected content type")
                    declared = response.headers.get("Content-Length")
                    if declared is not None:
                        try:
                            declared_length = int(declared)
                        except ValueError as error:
                            raise HarnessError("backup content length was invalid") from error
                        if not 0 < declared_length <= DOGFOOD_BACKUP_BYTES_MAX:
                            fail("backup content length exceeded the dogfood bound")
                    else:
                        declared_length = None
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > DOGFOOD_BACKUP_BYTES_MAX:
                            fail("backup download exceeded the dogfood bound")
                        output_handle.write(chunk)
                    if total == 0 or (
                        declared_length is not None and total != declared_length
                    ):
                        fail("backup download was empty or truncated")
                    output_handle.flush()
                    os.fsync(output_handle.fileno())
        except Exception:
            try:
                destination.unlink()
            except FileNotFoundError:
                pass
            raise

    def expect(
        self,
        method: str,
        path: str,
        status_expected: int,
        *,
        body: Any | None = None,
        operation_id: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Any, bytes]:
        payload, status, raw = self.request(
            method, path, body=body, operation_id=operation_id, authenticated=authenticated
        )
        if status != status_expected:
            error_value = payload.get("error", {}) if isinstance(payload, dict) else {}
            code = error_value.get("code") if isinstance(error_value, dict) else None
            message = error_value.get("message") if isinstance(error_value, dict) else None
            detail = f", message={message}" if isinstance(message, str) and len(message) <= 256 else ""
            fail(
                f"HTTP {method} {path} returned {status}, expected {status_expected} "
                f"(code={code or 'none'}{detail})"
            )
        return payload, raw

    def observe(self, label: str, *, active: bool) -> dict[str, Any]:
        assert self.process is not None
        observation, pids = process_observation(
            self.process.pid, self.server_path, self.host_path, label, active=active
        )
        self.observed_descendants.update(pids)
        return observation

    def sse_through(self, event_epoch: str, since: int, through: int) -> list[dict[str, Any]]:
        parsed = urllib.parse.urlparse(self.base_url)
        if parsed.hostname is None or parsed.port is None:
            fail("private runtime address was invalid")
        path = "/api/v1/events?" + urllib.parse.urlencode({"event_epoch": event_epoch, "since": since})
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=self.call_timeout)
        events: list[dict[str, Any]] = []
        try:
            connection.request(
                "GET",
                path,
                headers={"Host": self.address, "Authorization": f"Bearer {self.token}", "Accept": "text/event-stream"},
            )
            response = connection.getresponse()
            if response.status != 200:
                fail(f"event catch-up returned HTTP {response.status}")
            data_lines: list[str] = []
            while not events or events[-1].get("revision", -1) < through:
                line = response.readline(512 * 1024)
                if not line:
                    fail("event catch-up ended before the target revision")
                if len(line) >= 512 * 1024:
                    fail("event catch-up line exceeded bound")
                decoded = line.decode("utf-8", errors="strict").rstrip("\r\n")
                if decoded.startswith("data:"):
                    data_lines.append(decoded[5:].lstrip())
                elif decoded == "" and data_lines:
                    value = json.loads("\n".join(data_lines))
                    data_lines.clear()
                    if isinstance(value, dict) and isinstance(value.get("revision"), int):
                        events.append(value)
                if len(events) > 2048:
                    fail("event catch-up exceeded retained-event bound")
            return events
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError("event catch-up could not be decoded") from error
        finally:
            connection.close()

    def sse_during(
        self,
        event_epoch: str,
        since: int,
        action: Callable[[], tuple[int, Any]],
    ) -> tuple[list[dict[str, Any]], Any]:
        """Open the live stream before action and retain through its returned revision."""
        parsed = urllib.parse.urlparse(self.base_url)
        if parsed.hostname is None or parsed.port is None:
            fail("private runtime address was invalid")
        path = "/api/v1/events?" + urllib.parse.urlencode(
            {"event_epoch": event_epoch, "since": since}
        )
        connection = http.client.HTTPConnection(
            parsed.hostname, parsed.port, timeout=self.call_timeout
        )
        events: list[dict[str, Any]] = []
        try:
            connection.request(
                "GET",
                path,
                headers={
                    "Host": self.address,
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "text/event-stream",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                fail(f"live event request returned HTTP {response.status}")
            through, result = action()
            data_lines: list[str] = []
            while not events or events[-1].get("revision", -1) < through:
                line = response.readline(512 * 1024)
                if not line:
                    fail("live event stream ended before the target revision")
                decoded = line.decode("utf-8", errors="strict").rstrip("\r\n")
                if decoded.startswith("data:"):
                    data_lines.append(decoded[5:].lstrip())
                elif decoded == "" and data_lines:
                    value = json.loads("\n".join(data_lines))
                    data_lines.clear()
                    if isinstance(value, dict) and isinstance(value.get("revision"), int):
                        events.append(value)
                if len(events) > 2048:
                    fail("live event stream exceeded retained-event bound")
            return events, result
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError("live event stream could not be decoded") from error
        finally:
            connection.close()

    def stop(self, *, require_graceful: bool = True) -> dict[str, bool]:
        if self.process is None:
            return {"sigterm_sent": False, "graceful_exit": False, "runtime_removed": False, "lock_reacquired": False, "descendants_gone": False, "no_host_orphan": False}
        sigterm_sent = False
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            sigterm_sent = True
            try:
                self.process.wait(timeout=self.shutdown_timeout)
            except subprocess.TimeoutExpired:
                self.forced_kill = True
                self.process.kill()
                self.process.wait(timeout=min(5.0, self.shutdown_timeout))
        graceful = not self.forced_kill

        def cleaned() -> bool:
            return not (self.profile / RUNTIME_FILE).exists() and lock_is_free(self.profile)

        try:
            poll_until(self.shutdown_timeout, cleaned, f"{self.label}: runtime or profile lock retained")
        except HarnessError:
            if require_graceful:
                raise
        descendants_gone = all(not Path(f"/proc/{pid}").exists() for pid in self.observed_descendants)
        no_host_orphan = set(exact_host_processes(self.host_path)).issubset(
            self.preexisting_host_pids
        )
        result = {
            "sigterm_sent": sigterm_sent,
            "graceful_exit": graceful,
            "runtime_removed": not (self.profile / RUNTIME_FILE).exists(),
            "lock_reacquired": lock_is_free(self.profile),
            "descendants_gone": descendants_gone,
            "no_host_orphan": no_host_orphan,
        }
        if require_graceful and not all(result.values()):
            fail(f"{self.label}: fail-closed shutdown checks did not all pass")
        return result


def assert_competing_owner_rejected(
    primary: ProductServer,
    server_path: Path,
    web_dir: Path,
    private_root: Path,
    timeout: float,
) -> dict[str, Any]:
    runtime_path = primary.profile / RUNTIME_FILE
    try:
        runtime_before = runtime_path.read_bytes()
    except OSError as error:
        raise HarnessError("primary runtime authority was unavailable") from error
    contender_stderr = private_root / "competing-owner.stderr"
    stderr_handle = contender_stderr.open("wb")
    contender: subprocess.Popen[bytes] | None = None
    try:
        contender = subprocess.Popen(
            [
                str(server_path),
                "--bind",
                "127.0.0.1:0",
                "--data-dir",
                str(primary.profile),
                "--web-dir",
                str(web_dir),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_handle,
            cwd=web_dir,
            start_new_session=True,
            umask=0o077,
        )
    finally:
        stderr_handle.close()
    try:
        poll_until(
            timeout,
            lambda: contender.poll() is not None,
            "competing profile owner did not reject within the bound",
        )
        if contender.returncode == 0:
            fail("competing profile owner unexpectedly started successfully")
        if runtime_path.read_bytes() != runtime_before:
            fail("competing profile owner changed primary runtime authority")
        health, _ = primary.expect("GET", "/api/v1/health", 200, authenticated=False)
        if health.get("status") != "ok":
            fail("primary owner was not healthy after competing owner rejection")
        primary.observe("competing-owner-rejected", active=False)
        return {
            "passed": True,
            "competing_owner_rejected": True,
            "primary_runtime_authority_unchanged": True,
            "primary_remained_healthy": True,
            "contender_runtime_children": 0,
        }
    finally:
        if contender.poll() is None:
            contender.kill()
            contender.wait(timeout=min(5.0, timeout))


def extract_primary_id(mutation: Any) -> str:
    if not isinstance(mutation, dict) or not isinstance(mutation.get("event"), dict):
        fail("mutation response omitted its event")
    event = mutation["event"]
    snapshot = event.get("snapshot")
    if isinstance(snapshot, dict):
        task = snapshot.get("task")
        if isinstance(task, dict) and isinstance(task.get("id"), str):
            return task["id"]
    primary = event.get("primary")
    if isinstance(primary, dict) and isinstance(primary.get("id"), str):
        return primary["id"]
    fail("mutation response omitted its primary identity")


def sync_state(server: ProductServer) -> dict[str, Any]:
    value, _ = server.expect("GET", "/api/v1/sync-state", 200)
    if not isinstance(value, dict) or not isinstance(value.get("revision"), int) or not isinstance(value.get("event_epoch"), str):
        fail("sync state response was invalid")
    return value


def installed(server: ProductServer, plugin_id: str) -> dict[str, Any]:
    value, _ = server.expect("GET", f"/api/v1/plugins/{plugin_id}", 200)
    if not isinstance(value, dict) or value.get("plugin_id") != plugin_id:
        fail(f"installed plugin response was invalid for {plugin_id}")
    return value


def error_code(payload: Any) -> str | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("error"), dict):
        return None
    value = payload["error"].get("code")
    return value if isinstance(value, str) else None


def require_rejection(
    payload: Any,
    status: int,
    *,
    expected_status: int,
    expected_codes: set[str],
    label: str,
) -> None:
    code = error_code(payload)
    if status != expected_status or code not in expected_codes:
        fail(
            f"{label} returned HTTP {status} code={code or 'none'}, expected "
            f"HTTP {expected_status} and a closed product error"
        )


def install_registry(
    server: ProductServer,
    plugin_id: str,
    digest: str,
    label: str,
    *,
    replace_existing: bool = False,
) -> dict[str, Any]:
    body = {
        "version": "0.1.0",
        "expected_package_sha256": digest,
        "replace_existing": replace_existing,
    }
    key = operation(f"{label}:install")
    first, first_raw = server.expect(
        "POST", f"/api/v1/plugins/registry/{plugin_id}/install", 200, body=body, operation_id=key
    )
    state = installed(server, plugin_id)
    if state.get("version") != "0.1.0" or state.get("package_sha256") != digest:
        fail(f"installed authority mismatch for {plugin_id}")
    generation = state.get("package_generation")
    if not isinstance(generation, int) or generation < 1:
        fail(f"invalid package generation for {plugin_id}")
    before_replay = sync_state(server)["revision"]
    replay, replay_raw = server.expect(
        "POST", f"/api/v1/plugins/registry/{plugin_id}/install", 200, body=body, operation_id=key
    )
    after_replay = sync_state(server)["revision"]
    listed, _ = server.expect("GET", "/api/v1/plugins", 200)
    matching = [item for item in listed.get("plugins", []) if item.get("plugin_id") == plugin_id]
    if first_raw != replay_raw or first != replay or before_replay != after_replay or len(matching) != 1:
        fail(f"registry install replay was not byte-stable and effect-free for {plugin_id}")
    if matching[0].get("package_generation") != generation:
        fail(f"registry install replay changed package generation for {plugin_id}")
    return state


def package_confirmation(
    preview: dict[str, Any], *, replace_existing: bool = False, allow_downgrade: bool = False
) -> dict[str, str]:
    required = {
        "expected_plugin_id": "plugin_id",
        "expected_version": "version",
        "expected_package_sha256": "package_sha256",
        "expected_publisher_key_id": "publisher_key_id",
        "expected_permission_hash": "permission_hash",
        "expected_compatibility": "junban_compatibility",
    }
    confirmation: dict[str, str] = {}
    for query_name, preview_name in required.items():
        value = preview.get(preview_name)
        if not isinstance(value, str) or not value:
            fail("package preview omitted exact install confirmation authority")
        confirmation[query_name] = value
    confirmation["replace_existing"] = "true" if replace_existing else "false"
    confirmation["allow_downgrade"] = "true" if allow_downgrade else "false"
    return confirmation


def package_install_path(confirmation: dict[str, str]) -> str:
    return "/api/v1/plugins/packages/install?" + urllib.parse.urlencode(confirmation)


def install_package(
    server: ProductServer,
    package: Path,
    preview: dict[str, Any],
    label: str,
    *,
    replace_existing: bool = False,
    allow_downgrade: bool = False,
) -> dict[str, Any]:
    confirmation = package_confirmation(
        preview,
        replace_existing=replace_existing,
        allow_downgrade=allow_downgrade,
    )
    server.expect_octets(
        "POST",
        package_install_path(confirmation),
        200,
        package,
        operation_id=operation(f"{label}:install"),
    )
    return installed(server, preview["plugin_id"])


def inspect_package(
    server: ProductServer,
    package: Path,
    source: dict[str, Any],
    component: Path,
    public_key: bytes,
    expected_trust: str,
) -> dict[str, Any]:
    preview, _ = server.expect_octets(
        "POST", "/api/v1/plugins/packages/inspect", 200, package
    )
    if not isinstance(preview, dict):
        fail("package inspection response was invalid")
    expected_key_id = hashlib.sha256(public_key).hexdigest()
    exact = {
        "plugin_id": source["id"],
        "name": source["name"],
        "description": source["description"],
        "version": source["version"],
        "junban_compatibility": source["junban_compatibility"],
        "runtime_profile": source["runtime_profile"],
        "package_sha256": sha256_file(package),
        "package_size": package.stat().st_size,
        "component_sha256": sha256_file(component),
        "component_size": component.stat().st_size,
        "publisher_key_id": expected_key_id,
        "publisher_public_key_base64": base64.b64encode(public_key).decode("ascii"),
        "publisher_trust": expected_trust,
        "permissions": source["permissions"],
        "dependencies": source["dependencies"],
        "commands": source["commands"],
        "surfaces": source["surfaces"],
        "settings": source["settings"],
        "services": source["services"],
    }
    for key, expected in exact.items():
        if preview.get(key) != expected:
            fail(f"package inspection preview mismatched exact {key} authority")
    permission_hash = preview.get("permission_hash")
    if not isinstance(permission_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", permission_hash):
        fail("package inspection preview omitted its exact permission hash")
    return preview


def grant_exact(server: ProductServer, plugin: dict[str, Any], label: str) -> None:
    permissions = plugin.get("requested_permissions")
    generation = plugin.get("package_generation")
    if not isinstance(permissions, list) or not permissions or not isinstance(generation, int):
        fail("installed plugin omitted requested permission authority")
    server.expect(
        "PUT",
        f"/api/v1/plugins/{plugin['plugin_id']}/grants",
        200,
        body={"package_generation": generation, "permissions": permissions},
        operation_id=operation(f"{label}:grants"),
    )
    current = installed(server, plugin["plugin_id"])
    if current.get("granted_permissions") != permissions:
        fail(f"exact requested grants were not retained for {plugin['plugin_id']}")


def enable(server: ProductServer, plugin_id: str, label: str) -> dict[str, Any]:
    server.expect("POST", f"/api/v1/plugins/{plugin_id}/enable", 200, operation_id=operation(f"{label}:enable"))

    def active() -> bool:
        value = installed(server, plugin_id)
        return value.get("desired_enabled") is True and value.get("runtime_state") == "active"

    poll_until(server.call_timeout, active, f"{plugin_id} did not become active")
    return installed(server, plugin_id)


def disable(server: ProductServer, plugin_id: str, label: str) -> dict[str, Any]:
    server.expect("POST", f"/api/v1/plugins/{plugin_id}/disable", 200, operation_id=operation(f"{label}:disable"))
    current = installed(server, plugin_id)
    if current.get("desired_enabled") is not False or current.get("runtime_state") != "disabled":
        fail(f"{plugin_id} did not become disabled")
    contributions, _ = server.expect("GET", "/api/v1/plugins/contributions", 200)
    if any(value.get("plugin_id") == plugin_id for value in contributions.get("contributions", [])):
        fail(f"disabled {plugin_id} retained contributions")
    return current


def contribution_fence(value: dict[str, Any]) -> dict[str, Any]:
    fence = {key: value.get(key) for key in ("package_generation", "activation_epoch", "host_session_id")}
    if not isinstance(fence["package_generation"], int) or not isinstance(fence["activation_epoch"], int):
        fail("contribution omitted generation fence")
    try:
        uuid.UUID(str(fence["host_session_id"]))
    except ValueError as error:
        raise HarnessError("contribution omitted host-session fence") from error
    return fence


def wait_contributions(server: ProductServer, plugin_id: str, expected: set[tuple[str, str]]) -> list[dict[str, Any]]:
    holder: dict[str, Any] = {}

    def ready() -> bool:
        value, status, _ = server.request("GET", "/api/v1/plugins/contributions")
        if status != 200 or not isinstance(value, dict):
            return False
        selected = [item for item in value.get("contributions", []) if item.get("plugin_id") == plugin_id]
        if {(item.get("kind"), item.get("local_id")) for item in selected} != expected:
            return False
        holder["values"] = selected
        return True

    poll_until(server.call_timeout, ready, f"{plugin_id} contributions did not become active")
    values = holder["values"]
    fence = contribution_fence(values[0])
    if any(contribution_fence(item) != fence for item in values):
        fail(f"{plugin_id} contributions did not share one exact fence")
    current = installed(server, plugin_id)
    if fence["package_generation"] != current.get("package_generation") or fence["activation_epoch"] != current.get("activation_epoch"):
        fail(f"{plugin_id} contribution fence disagreed with installed DTO")
    return values


def create_task(server: ProductServer, label: str, title: str, *, replay: bool = False) -> tuple[str, bytes]:
    key = operation(f"task:{label}")
    body = {"title": title}
    value, raw = server.expect("POST", "/api/v1/tasks", 201, body=body, operation_id=key)
    task_id = extract_primary_id(value)
    if replay:
        replay_value, replay_raw = server.expect(
            "POST", "/api/v1/tasks", 201, body=body, operation_id=key
        )
        # A live automation plugin may commit its separate completion between
        # these two calls, so global revision is not a valid replay fence here.
        # Byte-stable receipt identity plus the later exact created/completed
        # event counts prove this create itself had no second effect.
        if replay_raw != raw or replay_value != value or extract_primary_id(replay_value) != task_id:
            fail("task-create replay was not byte-stable")
    return task_id, raw


def task(server: ProductServer, task_id: str) -> dict[str, Any]:
    value, _ = server.expect("GET", f"/api/v1/tasks/{task_id}", 200)
    if not isinstance(value, dict) or value.get("id") != task_id:
        fail("task response identity mismatch")
    return value


def wait_task_status(
    server: ProductServer,
    task_ids: list[str],
    status: str,
    timeout: float,
    *,
    label: str,
) -> None:
    deadline = time.monotonic() + timeout
    observed: dict[str, Any] = {}
    while time.monotonic() < deadline:
        observed = {task_id: task(server, task_id).get("status") for task_id in task_ids}
        if all(value == status for value in observed.values()):
            return
        time.sleep(POLL_INTERVAL)
    fail(f"{label} tasks did not reach {status}; observed statuses: {observed}")


def affected_task_ids(event: dict[str, Any]) -> list[str]:
    affected = event.get("affected")
    if isinstance(affected, dict) and isinstance(affected.get("task_ids"), list):
        return [value for value in affected["task_ids"] if isinstance(value, str)]
    primary = event.get("primary")
    if isinstance(primary, dict) and isinstance(primary.get("id"), str):
        return [primary["id"]]
    return []


def surface_metric(rendered: dict[str, Any], node_id: str) -> dict[str, Any]:
    surface = rendered.get("surface")
    if not isinstance(surface, dict) or not isinstance(surface.get("nodes"), list):
        fail("rendered surface shape was invalid")
    for node in surface["nodes"]:
        if isinstance(node, dict) and node.get("id") == node_id:
            content = node.get("content")
            if isinstance(content, dict) and content.get("tag") == "metric" and isinstance(content.get("val"), dict):
                return content["val"]
    fail("rendered surface omitted its product-visible metric")


def run_artifact_check(tool: Path, timeout: float) -> None:
    result = run_command(
        [sys.executable, str(ROOT / "scripts/check-phase7-plugin-artifacts.py"), "--tool", str(tool)],
        timeout=timeout,
    )
    if result.returncode != 0:
        output = (result.stdout + result.stderr)[-DIAGNOSTIC_BYTES_MAX:].decode("utf-8", errors="replace").strip()
        fail("public plugin artifact verification failed" + (f": {output}" if output else ""))


def write_owner_private(path: Path, content: bytes | bytearray) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise


def run_private_artifact_command(
    artifact_tool: Path,
    arguments: list[str],
    *,
    timeout: float,
    label: str,
    secrets: set[str],
    private_root: Path,
) -> None:
    result = run_command([str(artifact_tool), *arguments], timeout=timeout)
    if result.returncode != 0:
        diagnostic = redact(
            (result.stdout + result.stderr)[-DIAGNOSTIC_BYTES_MAX:].decode(
                "utf-8", errors="replace"
            ),
            secrets,
            private_root,
        ).strip()
        fail(
            f"artifact tool failed while creating {label}"
            + (f": {diagnostic}" if diagnostic else "")
        )


def create_external_plugin_fixtures(
    artifact_tool: Path,
    private_root: Path,
    secrets: set[str],
    timeout: float,
) -> dict[str, Any]:
    fixture_root = private_root / "external-fixtures"
    fixture_root.mkdir(mode=0o700)
    seed_path = fixture_root / "disposable-signer.seed"
    seed = bytearray(os.urandom(32))
    secrets.update(
        {
            seed.hex(),
            seed.hex().upper(),
            base64.b64encode(seed).decode("ascii"),
            base64.urlsafe_b64encode(seed).decode("ascii"),
            base64.b32encode(seed).decode("ascii"),
        }
    )
    try:
        write_owner_private(seed_path, seed)
    finally:
        seed[:] = b"\0" * len(seed)
    seed_memory_cleared = not any(seed)
    if not seed_memory_cleared:
        fail("disposable signer seed memory was not cleared")
    public_key_path = fixture_root / "disposable-publisher.bin"
    run_private_artifact_command(
        artifact_tool,
        [
            "key",
            "public",
            "--key-file",
            str(seed_path),
            "--output",
            str(public_key_path),
        ],
        timeout=timeout,
        label="disposable publisher public key",
        secrets=secrets,
        private_root=private_root,
    )
    public_key = public_key_path.read_bytes()
    if len(public_key) != 32:
        fail("artifact tool produced an invalid disposable public key")

    package_specs = {
        "local": {
            "base": "import-typescript",
            "id": "dogfood-local",
            "name": "Dogfood Local Package",
            "version": "1.0.0",
            "dependencies": [],
        },
        "provider": {
            "base": "pomodoro-rust",
            "id": "dogfood-provider",
            "name": "Dogfood Dependency Provider",
            "version": "1.0.0",
            "dependencies": [],
        },
        "dependent": {
            "base": "pomodoro-rust",
            "id": "dogfood-dependent",
            "name": "Dogfood Dependency Consumer",
            "version": "1.0.0",
            "dependencies": [
                {"id": "dogfood-provider", "requirement": "^1.0", "services": []}
            ],
        },
        "missing": {
            "base": "pomodoro-rust",
            "id": "dogfood-missing",
            "name": "Dogfood Missing Dependency",
            "version": "1.0.0",
            "dependencies": [
                {"id": "dogfood-absent", "requirement": "^1.0", "services": []}
            ],
        },
        "incompatible": {
            "base": "pomodoro-rust",
            "id": "dogfood-incompatible",
            "name": "Dogfood Incompatible Dependency",
            "version": "1.0.0",
            "dependencies": [
                {"id": "dogfood-provider", "requirement": "^2.0", "services": []}
            ],
        },
        "cycle": {
            "base": "pomodoro-rust",
            "id": "dogfood-provider",
            "name": "Dogfood Dependency Provider Cycle",
            "version": "1.1.0",
            "dependencies": [
                {"id": "dogfood-dependent", "requirement": "^1.0", "services": []}
            ],
        },
    }
    packages: dict[str, dict[str, Any]] = {}
    for label, spec in package_specs.items():
        base = str(spec["base"])
        source_authority = ROOT / "plugins/reference" / base / "plugin-source.json"
        component_name = (
            "import-typescript.wasm" if base == "import-typescript" else "pomodoro.wasm"
        )
        component_authority = (
            ROOT / "plugins/reference" / base / "artifacts" / component_name
        )
        source_path = fixture_root / f"{label}-source.json"
        component_path = fixture_root / f"{label}.wasm"
        package_path = fixture_root / f"{label}.jbp"
        try:
            source = json.loads(source_authority.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError("retained fixture source could not be copied") from error
        source["id"] = spec["id"]
        source["name"] = spec["name"]
        source["description"] = "Disposable external Phase 7 product dogfood fixture."
        source["publisher"] = {
            "id": "dogfood-public-fixture",
            "name": "Dogfood Public Fixture",
        }
        source["version"] = spec["version"]
        source["dependencies"] = spec["dependencies"]
        write_owner_private(
            source_path,
            (json.dumps(source, sort_keys=True, indent=2) + "\n").encode("utf-8"),
        )
        if component_authority.is_symlink() or not component_authority.is_file():
            fail("retained fixture component authority was unavailable")
        write_owner_private(component_path, component_authority.read_bytes())
        run_private_artifact_command(
            artifact_tool,
            [
                "package",
                "sign",
                "--source",
                str(source_path),
                "--component",
                str(component_path),
                "--key-file",
                str(seed_path),
                "--output",
                str(package_path),
            ],
            timeout=timeout,
            label=f"{label} package",
            secrets=secrets,
            private_root=private_root,
        )
        run_private_artifact_command(
            artifact_tool,
            [
                "package",
                "verify",
                "--source",
                str(source_path),
                "--component",
                str(component_path),
                "--package",
                str(package_path),
            ],
            timeout=timeout,
            label=f"{label} package public verification",
            secrets=secrets,
            private_root=private_root,
        )
        packages[label] = {
            "source": source,
            "source_path": source_path,
            "component": component_path,
            "package": package_path,
        }

    registry_packages = fixture_root / "registry-packages"
    registry_packages.mkdir(mode=0o700)
    metadata_entries: list[dict[str, Any]] = []
    for fixture in packages.values():
        digest = sha256_file(fixture["package"])
        write_owner_private(
            registry_packages / f"{digest}.jbp", fixture["package"].read_bytes()
        )
        metadata_entries.append(
            {
                "plugin_id": fixture["source"]["id"],
                "version": fixture["source"]["version"],
                "search_tags": [],
            }
        )
    metadata_entries.sort(key=lambda value: (value["plugin_id"], value["version"]))
    registry_metadata = fixture_root / "registry-source.json"
    write_owner_private(
        registry_metadata,
        (
            json.dumps(
                {
                    "schema_version": 1,
                    "generated_at": utc_now(),
                    "entries": metadata_entries,
                },
                sort_keys=True,
                indent=2,
            )
            + "\n"
        ).encode("utf-8"),
    )
    registry_root_public_key = fixture_root / "registry-root-public-key.bin"
    registry_index = fixture_root / "disposable-registry.jri"
    run_private_artifact_command(
        artifact_tool,
        [
            "index",
            "sign",
            "--packages",
            str(registry_packages),
            "--metadata",
            str(registry_metadata),
            "--publisher-public-key",
            str(public_key_path),
            "--key-file",
            str(seed_path),
            "--root-public-key-output",
            str(registry_root_public_key),
            "--output",
            str(registry_index),
        ],
        timeout=timeout,
        label="disposable registry index",
        secrets=secrets,
        private_root=private_root,
    )
    registry_include = fixture_root / "disposable-registry-include.rs"
    run_private_artifact_command(
        artifact_tool,
        [
            "registry",
            "include-table",
            "--root-public-key",
            str(registry_root_public_key),
            "--publisher-public-key",
            str(public_key_path),
            "--index",
            str(registry_index),
            "--packages",
            str(registry_packages),
            "--output",
            str(registry_include),
        ],
        timeout=timeout,
        label="disposable registry public verification",
        secrets=secrets,
        private_root=private_root,
    )
    altered_registry = fixture_root / "altered-registry.jri"
    altered_registry_bytes = bytearray(registry_index.read_bytes())
    if not altered_registry_bytes:
        fail("disposable registry index was unexpectedly empty")
    altered_registry_bytes[-1] ^= 0x01
    write_owner_private(altered_registry, altered_registry_bytes)
    altered_include = fixture_root / "altered-registry-include.rs"
    altered_result = run_command(
        [
            str(artifact_tool),
            "registry",
            "include-table",
            "--root-public-key",
            str(registry_root_public_key),
            "--publisher-public-key",
            str(public_key_path),
            "--index",
            str(altered_registry),
            "--packages",
            str(registry_packages),
            "--output",
            str(altered_include),
        ],
        timeout=timeout,
    )
    if altered_result.returncode == 0 or altered_include.exists():
        fail("public artifact verifier accepted an altered disposable registry")

    return {
        "root": fixture_root,
        "seed": seed_path,
        "public_key_path": public_key_path,
        "public_key": public_key,
        "seed_memory_cleared": seed_memory_cleared,
        "packages": packages,
        "registry": {
            "index_sha256": sha256_file(registry_index),
            "root_key_id": hashlib.sha256(registry_root_public_key.read_bytes()).hexdigest(),
            "entry_count": len(metadata_entries),
            "altered_rejected": True,
        },
    }


def destroy_external_plugin_fixtures(fixtures: dict[str, Any]) -> dict[str, bool]:
    seed_path = fixtures["seed"]
    root = fixtures["root"]
    try:
        seed_path.unlink()
    except FileNotFoundError:
        pass
    seed_removed = not seed_path.exists()
    shutil.rmtree(root)
    return {
        "seed_removed": seed_removed and not seed_path.exists(),
        "seed_memory_cleared": fixtures.get("seed_memory_cleared") is True,
        "generated_fixture_root_removed": not root.exists(),
    }


def trust_publisher(
    server: ProductServer, public_key: bytes, key_id: str, label: str
) -> None:
    if len(public_key) != 32 or hashlib.sha256(public_key).hexdigest() != key_id:
        fail("publisher public key did not match its exact fingerprint")
    server.expect(
        "PUT",
        f"/api/v1/plugins/publishers/{key_id}",
        200,
        body={"public_key_base64": base64.b64encode(public_key).decode("ascii")},
        operation_id=operation(f"publisher:{label}:trust"),
    )
    trusted, _ = server.expect("GET", "/api/v1/plugins/publishers", 200)
    matches = [
        value
        for value in trusted.get("publishers", [])
        if value.get("key_id") == key_id and value.get("status") == "active"
    ]
    if len(matches) != 1:
        fail("publisher trust was not established exactly once")


def trust_bundled_publisher(server: ProductServer) -> None:
    public_key = (ROOT / "plugins/registry/publisher-public-key.bin").read_bytes()
    if len(public_key) != 32 or hashlib.sha256(public_key).hexdigest() != PUBLISHER_KEY_ID:
        fail("bundled publisher public key did not match its exact authority")
    trust_publisher(server, public_key, PUBLISHER_KEY_ID, "bundled")


def exact_registry(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("index_sha256"), str):
        fail("registry response shape was invalid")
    entries = value.get("entries")
    if not isinstance(entries, list) or len(entries) != len(REGISTRY_AUTHORITY):
        fail("registry did not contain exactly three entries")
    summary = []
    for entry, (plugin_id, digest, runtime) in zip(entries, REGISTRY_AUTHORITY, strict=True):
        if (
            entry.get("plugin_id") != plugin_id
            or entry.get("version") != "0.1.0"
            or entry.get("package_sha256") != digest
            or entry.get("runtime_profile") != runtime
            or entry.get("publisher_key_id") != PUBLISHER_KEY_ID
        ):
            fail("registry order or exact signed authority mismatched")
        summary.append(
            {
                "plugin_id": plugin_id,
                "version": "0.1.0",
                "package_sha256": digest,
                "runtime_profile": runtime,
                "publisher_key_id": PUBLISHER_KEY_ID,
            }
        )
    # The product exposes the signed index payload digest, while the public-file
    # identity records the complete signed container bytes. The artifact checker
    # proves those two authorities agree before startup.
    return {"index_payload_sha256": value["index_sha256"], "entries": summary}


def run_external_package_corpus(
    server: ProductServer,
    fixtures: dict[str, Any],
    poll_timeout: float,
    process_observations: list[dict[str, Any]],
    outcomes: dict[str, Any],
) -> None:
    packages = fixtures["packages"]
    public_key = fixtures["public_key"]
    key_id = hashlib.sha256(public_key).hexdigest()
    local = packages["local"]

    policy, _ = server.expect("GET", "/api/v1/plugins/community-policy", 200)
    if policy.get("enabled") is not False:
        fail("community package policy was not disabled by default")

    local_preview = inspect_package(
        server,
        local["package"],
        local["source"],
        local["component"],
        public_key,
        "unknown",
    )
    altered_path = fixtures["root"] / "altered-local.jbp"
    altered = bytearray(local["package"].read_bytes())
    if not altered:
        fail("disposable package was unexpectedly empty")
    altered[-1] ^= 0x01
    write_owner_private(altered_path, bytes(altered))
    altered_payload, altered_status, _ = server.request_octets(
        "POST", "/api/v1/plugins/packages/inspect", altered_path
    )
    require_rejection(
        altered_payload,
        altered_status,
        expected_status=409,
        expected_codes={"conflict"},
        label="altered package inspection",
    )
    altered_path.unlink()

    wrong_registry, wrong_registry_status, _ = server.request(
        "POST",
        "/api/v1/plugins/registry/automation/install",
        body={"version": "0.1.0", "expected_package_sha256": "0" * 64},
        operation_id=operation("altered-authority:wrong-registry-digest"),
    )
    require_rejection(
        wrong_registry,
        wrong_registry_status,
        expected_status=409,
        expected_codes={"registry_confirmation_mismatch"},
        label="wrong registry digest confirmation",
    )
    registry_fixture = fixtures["registry"]
    if registry_fixture.get("altered_rejected") is not True:
        fail("disposable altered registry rejection authority was missing")
    outcomes["altered_authority"] = {
        "passed": True,
        "altered_package_upload_rejected": True,
        "altered_external_registry_rejected": True,
        "wrong_bundled_registry_digest_rejected": True,
        "external_registry_index_sha256": registry_fixture["index_sha256"],
        "external_registry_root_key_id": registry_fixture["root_key_id"],
        "external_registry_entry_count": registry_fixture["entry_count"],
        "tracked_registry_mutated": False,
    }

    policy_key = operation("community-policy:enable")
    policy_body = {"enabled": True}
    policy_first, policy_first_raw = server.expect(
        "PUT",
        "/api/v1/plugins/community-policy",
        200,
        body=policy_body,
        operation_id=policy_key,
    )
    policy_revision = sync_state(server)["revision"]
    policy_replay, policy_replay_raw = server.expect(
        "PUT",
        "/api/v1/plugins/community-policy",
        200,
        body=policy_body,
        operation_id=policy_key,
    )
    if (
        policy_first != policy_replay
        or policy_first_raw != policy_replay_raw
        or sync_state(server)["revision"] != policy_revision
    ):
        fail("community policy replay was not byte-stable and effect-free")
    policy, _ = server.expect("GET", "/api/v1/plugins/community-policy", 200)
    if policy.get("enabled") is not True:
        fail("community package policy did not persist enabled state")

    unknown_install, unknown_status, _ = server.request_octets(
        "POST",
        package_install_path(package_confirmation(local_preview)),
        local["package"],
        operation_id=operation("local:unknown-publisher-install"),
    )
    require_rejection(
        unknown_install,
        unknown_status,
        expected_status=409,
        expected_codes={"conflict"},
        label="unknown publisher local install",
    )

    trust_publisher(server, public_key, key_id, "disposable-first")
    installed_list, _ = server.expect("GET", "/api/v1/plugins", 200)
    if any(item.get("plugin_id") == "dogfood-local" for item in installed_list.get("plugins", [])):
        fail("trusting a publisher installed or enabled its package")
    process_observations.append(server.observe("local-publisher-trusted-no-runtime", active=False))

    trusted_preview = inspect_package(
        server,
        local["package"],
        local["source"],
        local["component"],
        public_key,
        "trusted",
    )
    changed_confirmation = package_confirmation(trusted_preview)
    changed_confirmation["expected_permission_hash"] = "0" * 64
    if changed_confirmation["expected_permission_hash"] == trusted_preview["permission_hash"]:
        changed_confirmation["expected_permission_hash"] = "1" * 64
    changed_payload, changed_status, _ = server.request_octets(
        "POST",
        package_install_path(changed_confirmation),
        local["package"],
        operation_id=operation("local:changed-confirmation"),
    )
    require_rejection(
        changed_payload,
        changed_status,
        expected_status=409,
        expected_codes={"plugin_confirmation_mismatch"},
        label="changed local install confirmation",
    )

    local_installed = install_package(server, local["package"], trusted_preview, "local")
    grant_exact(server, local_installed, "local")
    enable(server, "dogfood-local", "local:first")
    local_contributions = wait_contributions(
        server, "dogfood-local", {("command", "bulk-complete")}
    )
    local_fence = contribution_fence(local_contributions[0])
    process_observations.append(server.observe("local-package-active", active=True))
    first_task, _ = create_task(server, "local:first", "Phase 7 local package task")
    local_call = {
        **local_fence,
        "values": [
            {"name": "task-ids", "value": {"tag": "task-id-list", "val": [first_task]}}
        ],
    }
    local_result, _ = server.expect(
        "POST",
        "/api/v1/plugins/dogfood-local/commands/bulk-complete",
        200,
        body=local_call,
        operation_id=operation("local:first-command"),
    )
    if local_result.get("status") != "completed":
        fail("local package command did not complete")
    wait_task_status(
        server, [first_task], "completed", poll_timeout, label="local package command"
    )
    epoch_before_revoke = installed(server, "dogfood-local")["activation_epoch"]

    server.expect(
        "DELETE",
        f"/api/v1/plugins/publishers/{key_id}",
        200,
        operation_id=operation("publisher:disposable:revoke"),
    )
    revoked = installed(server, "dogfood-local")
    if (
        revoked.get("desired_enabled") is not False
        or revoked.get("runtime_state") != "disabled"
        or revoked.get("activation_epoch") != epoch_before_revoke + 1
    ):
        fail("publisher revocation did not fence and disable local package authority")
    process_observations.append(server.observe("local-publisher-revoked", active=False))
    contributions, _ = server.expect("GET", "/api/v1/plugins/contributions", 200)
    if any(
        item.get("plugin_id") == "dogfood-local"
        for item in contributions.get("contributions", [])
    ):
        fail("publisher revocation retained local package contributions")
    stale_payload, stale_status, _ = server.request(
        "POST",
        "/api/v1/plugins/dogfood-local/commands/bulk-complete",
        body=local_call,
        operation_id=operation("local:revoked-stale-fence"),
    )
    require_rejection(
        stale_payload,
        stale_status,
        expected_status=409,
        expected_codes={"stale_plugin_authority", "plugin_not_active"},
        label="revoked local stale authority",
    )
    revoked_enable, revoked_enable_status, _ = server.request(
        "POST",
        "/api/v1/plugins/dogfood-local/enable",
        operation_id=operation("local:revoked-enable"),
    )
    require_rejection(
        revoked_enable,
        revoked_enable_status,
        expected_status=409,
        expected_codes={"conflict"},
        label="revoked publisher enable",
    )

    trust_publisher(server, public_key, key_id, "disposable-second")
    enable(server, "dogfood-local", "local:second")
    fresh_contributions = wait_contributions(
        server, "dogfood-local", {("command", "bulk-complete")}
    )
    fresh_fence = contribution_fence(fresh_contributions[0])
    if fresh_fence == local_fence:
        fail("publisher retrust did not produce fresh local package authority")
    disable(server, "dogfood-local", "local:second")
    server.expect(
        "DELETE",
        "/api/v1/plugins/dogfood-local",
        200,
        operation_id=operation("local:uninstall"),
    )
    process_observations.append(server.observe("local-package-uninstalled", active=False))
    outcomes["local_signer"] = {
        "passed": True,
        "external_os_rng_seed": True,
        "owner_private_seed_file": True,
        "in_process_seed_memory_cleared": fixtures.get("seed_memory_cleared") is True,
        "raw_key_argument_or_environment": False,
        "artifact_tool_release_binary": True,
        "publisher_key_id": key_id,
        "package_sha256": trusted_preview["package_sha256"],
        "component_sha256": trusted_preview["component_sha256"],
        "permission_hash": trusted_preview["permission_hash"],
        "permission_count": len(trusted_preview["permissions"]),
        "dependency_count": len(trusted_preview["dependencies"]),
        "unknown_preview_exact": True,
        "trust_without_install_or_enable": True,
        "changed_confirmation_rejected": True,
        "exact_package_installed": True,
        "grant_and_enable_passed": True,
        "tasks_created": 1,
        "tasks_completed": 1,
        "publisher_revoke_drained_and_disabled": True,
        "revoked_fence_rejected": True,
        "revoked_enable_rejected": True,
        "retrust_fresh_authority": True,
        "reported_command_template": "junban-plugin-artifact package sign <private-inputs>",
    }

    dependency_previews: dict[str, dict[str, Any]] = {}
    for label in ("provider", "dependent", "missing", "incompatible", "cycle"):
        fixture = packages[label]
        dependency_previews[label] = inspect_package(
            server,
            fixture["package"],
            fixture["source"],
            fixture["component"],
            public_key,
            "trusted",
        )

    missing_payload, missing_status, _ = server.request_octets(
        "POST",
        package_install_path(package_confirmation(dependency_previews["missing"])),
        packages["missing"]["package"],
        operation_id=operation("dependencies:missing-install"),
    )
    require_rejection(
        missing_payload,
        missing_status,
        expected_status=409,
        expected_codes={"plugin_graph_rejected"},
        label="missing dependency install",
    )

    provider = install_package(
        server, packages["provider"]["package"], dependency_previews["provider"], "provider"
    )
    grant_exact(server, provider, "provider")
    incompatible_payload, incompatible_status, _ = server.request_octets(
        "POST",
        package_install_path(package_confirmation(dependency_previews["incompatible"])),
        packages["incompatible"]["package"],
        operation_id=operation("dependencies:incompatible-install"),
    )
    require_rejection(
        incompatible_payload,
        incompatible_status,
        expected_status=409,
        expected_codes={"plugin_graph_rejected"},
        label="incompatible dependency install",
    )
    dependent = install_package(
        server,
        packages["dependent"]["package"],
        dependency_previews["dependent"],
        "dependent",
    )
    grant_exact(server, dependent, "dependent")

    out_of_order, out_of_order_status, _ = server.request(
        "POST",
        "/api/v1/plugins/dogfood-dependent/enable",
        operation_id=operation("dependencies:dependent-before-provider"),
    )
    require_rejection(
        out_of_order,
        out_of_order_status,
        expected_status=409,
        expected_codes={"conflict"},
        label="dependent-before-provider activation",
    )
    enable(server, "dogfood-provider", "dependencies:provider")
    wait_contributions(
        server,
        "dogfood-provider",
        {("command", value) for value in ("pause", "reset", "skip", "start")}
        | {("status", "status"), ("view", "timer")},
    )
    enable(server, "dogfood-dependent", "dependencies:dependent")
    wait_contributions(
        server,
        "dogfood-dependent",
        {("command", value) for value in ("pause", "reset", "skip", "start")}
        | {("status", "status"), ("view", "timer")},
    )
    process_observations.append(server.observe("dependency-pair-active", active=True))

    cycle_payload, cycle_status, _ = server.request_octets(
        "POST",
        package_install_path(
            package_confirmation(dependency_previews["cycle"], replace_existing=True)
        ),
        packages["cycle"]["package"],
        operation_id=operation("dependencies:cycle-replacement"),
    )
    require_rejection(
        cycle_payload,
        cycle_status,
        expected_status=409,
        expected_codes={"plugin_graph_rejected"},
        label="cycle replacement install",
    )
    provider_after_cycle = installed(server, "dogfood-provider")
    if (
        provider_after_cycle.get("version") != "1.0.0"
        or provider_after_cycle.get("package_sha256")
        != dependency_previews["provider"]["package_sha256"]
    ):
        fail("cycle rejection changed installed provider authority")

    blocked_disable, blocked_disable_status, _ = server.request(
        "POST",
        "/api/v1/plugins/dogfood-provider/disable",
        operation_id=operation("dependencies:blocked-disable"),
    )
    require_rejection(
        blocked_disable,
        blocked_disable_status,
        expected_status=409,
        expected_codes={"plugin_has_dependents"},
        label="provider disable with enabled dependent",
    )
    blocked_uninstall, blocked_uninstall_status, _ = server.request(
        "DELETE",
        "/api/v1/plugins/dogfood-provider",
        operation_id=operation("dependencies:blocked-uninstall"),
    )
    require_rejection(
        blocked_uninstall,
        blocked_uninstall_status,
        expected_status=409,
        expected_codes={"plugin_has_dependents"},
        label="provider uninstall with dependent",
    )
    disable(server, "dogfood-dependent", "dependencies:dependent")
    disable(server, "dogfood-provider", "dependencies:provider")
    process_observations.append(server.observe("dependency-pair-disabled", active=False))
    server.expect(
        "DELETE",
        "/api/v1/plugins/dogfood-dependent",
        200,
        operation_id=operation("dependencies:dependent-uninstall"),
    )
    server.expect(
        "DELETE",
        "/api/v1/plugins/dogfood-provider",
        200,
        operation_id=operation("dependencies:provider-uninstall"),
    )
    outcomes["dependencies"] = {
        "passed": True,
        "external_signed_packages": 5,
        "provider_installed_first": True,
        "dependent_before_provider_rejected": True,
        "dependency_first_activation": True,
        "dependent_aware_disable_rejected": True,
        "dependent_aware_uninstall_rejected": True,
        "missing_install_rejected": True,
        "incompatible_install_rejected": True,
        "cycle_replacement_rejected": True,
        "installed_graph_remaining": 0,
    }

    policy_key = operation("community-policy:disable")
    server.expect(
        "PUT",
        "/api/v1/plugins/community-policy",
        200,
        body={"enabled": False},
        operation_id=policy_key,
    )
    policy, _ = server.expect("GET", "/api/v1/plugins/community-policy", 200)
    if policy.get("enabled") is not False:
        fail("community package policy did not return to disabled")
    restricted_payload, restricted_status, _ = server.request_octets(
        "POST",
        package_install_path(package_confirmation(trusted_preview)),
        local["package"],
        operation_id=operation("community-policy:restricted-local-install"),
    )
    require_rejection(
        restricted_payload,
        restricted_status,
        expected_status=409,
        expected_codes={"conflict"},
        label="community-restricted exact local install",
    )
    server.expect(
        "DELETE",
        f"/api/v1/plugins/publishers/{key_id}",
        200,
        operation_id=operation("publisher:disposable:final-revoke"),
    )
    publishers, _ = server.expect("GET", "/api/v1/plugins/publishers", 200)
    if not any(
        value.get("key_id") == key_id and value.get("status") == "revoked"
        for value in publishers.get("publishers", [])
    ):
        fail("disposable publisher did not finish revoked")
    outcomes["community_policy"] = {
        "passed": True,
        "default_disabled": True,
        "enable_exact_replay": True,
        "enabled_readback": True,
        "unknown_publisher_install_rejected": True,
        "explicit_inspection_confirmation_required": True,
        "disabled_readback": True,
        "restricted_exact_install_rejected": True,
        "network_registry_route_claimed": False,
        "final_publisher_revoked": True,
    }


def run_pre_restore_corpus(
    server: ProductServer,
    fixtures: dict[str, Any],
    backup_path: Path,
    poll_timeout: float,
    process_observations: list[dict[str, Any]],
    outcomes: dict[str, Any],
) -> dict[str, Any]:

    # 1. Dormant real product routes and exact bundled registry.
    health, _ = server.expect("GET", "/api/v1/health", 200)
    if health.get("status") != "ok":
        fail("authenticated health response was not healthy")
    dormant_task, _ = create_task(server, "dormant", "Phase 7 dormant product task")
    listed, _ = server.expect("GET", "/api/v1/tasks", 200)
    if dormant_task not in [value.get("id") for value in listed.get("tasks", [])]:
        fail("dormant task was absent from production task listing")
    registry, registry_raw = server.expect("GET", "/api/v1/plugins/registry", 200)
    registry_summary = exact_registry(registry)
    trust_bundled_publisher(server)
    process_observations.append(server.observe("dormant", active=False))
    outcomes["dormant"] = {"passed": True, "task_count": 1, "registry_entry_count": 3}

    # 2. TypeScript component: one typed command and exact durable replay.
    typescript_tasks = [
        create_task(server, f"typescript:{index}", f"Phase 7 TypeScript task {index}")[0]
        for index in range(3)
    ]
    typescript = install_registry(
        server, "import-typescript", REGISTRY_AUTHORITY[1][1], "import-typescript"
    )
    grant_exact(server, typescript, "import-typescript")
    enable(server, "import-typescript", "import-typescript:first")
    contributions = wait_contributions(server, "import-typescript", {("command", "bulk-complete")})
    process_observations.append(server.observe("typescript-active", active=True))
    typescript_fence = contribution_fence(contributions[0])
    command_body = {
        **typescript_fence,
        "values": [{"name": "task-ids", "value": {"tag": "task-id-list", "val": typescript_tasks}}],
    }
    command_value, command_raw = server.expect(
        "POST",
        "/api/v1/plugins/import-typescript/commands/bulk-complete",
        200,
        body=command_body,
        operation_id=operation("import-typescript:bulk-complete"),
    )
    if command_value.get("status") != "completed":
        fail("TypeScript bulk-complete invocation did not complete")
    wait_task_status(
        server, typescript_tasks, "completed", poll_timeout, label="TypeScript command"
    )
    revisions = {task_id: task(server, task_id)["revision"] for task_id in typescript_tasks}
    replay_value, replay_raw = server.expect(
        "POST",
        "/api/v1/plugins/import-typescript/commands/bulk-complete",
        200,
        body=command_body,
        operation_id=operation("import-typescript:bulk-complete"),
    )
    if replay_value != command_value or replay_raw != command_raw:
        fail("TypeScript command replay was not byte-stable")
    if revisions != {task_id: task(server, task_id)["revision"] for task_id in typescript_tasks}:
        fail("TypeScript command replay produced second task effects")
    disable(server, "import-typescript", "import-typescript:first")
    process_observations.append(server.observe("typescript-disabled", active=False))
    enable(server, "import-typescript", "import-typescript:second")
    fresh = wait_contributions(server, "import-typescript", {("command", "bulk-complete")})
    if contribution_fence(fresh[0]) == typescript_fence:
        fail("TypeScript re-enable did not advance contribution authority")
    stale, stale_status, _ = server.request(
        "POST",
        "/api/v1/plugins/import-typescript/commands/bulk-complete",
        body=command_body,
        operation_id=operation("import-typescript:stale-fence"),
    )
    if stale_status != 409 or stale.get("error", {}).get("code") != "stale_plugin_authority":
        fail("TypeScript stale contribution fence was not rejected")
    disable(server, "import-typescript", "import-typescript:second")
    process_observations.append(server.observe("typescript-final-disabled", active=False))
    outcomes["typescript"] = {
        "passed": True,
        "tasks_created": 3,
        "tasks_completed": 3,
        "typed_task_ids": 3,
        "command_replays": 1,
        "stale_fences_rejected": 1,
    }

    # 3. Rust Pomodoro: typed settings plus KV transitions observed through real output.
    pomodoro = install_registry(server, "pomodoro", REGISTRY_AUTHORITY[2][1], "pomodoro")
    pomodoro_path = package_object_path(server.profile, REGISTRY_AUTHORITY[2][1])
    if not pomodoro_path.is_file() or pomodoro_path.is_symlink():
        fail("Pomodoro content-addressed installed object was absent")
    grant_exact(server, pomodoro, "pomodoro")
    pomodoro = enable(server, "pomodoro", "pomodoro:first")
    expected_settings = {
        "break-minutes": 7,
        "long-break-minutes": 20,
        "sessions-before-long-break": 3,
        "work-minutes": 30,
    }
    setting_receipts: dict[str, dict[str, Any]] = {}
    for key, value in expected_settings.items():
        current = installed(server, "pomodoro")
        _, raw = server.expect(
            "PUT",
            f"/api/v1/plugins/pomodoro/settings/{key}",
            200,
            body={"package_generation": current["package_generation"], "value": value},
            operation_id=operation(f"pomodoro:setting:{key}"),
        )
        setting_receipts[key] = response_identity(raw)
    settings_value, settings_raw = server.expect(
        "GET", "/api/v1/plugins/pomodoro/settings", 200
    )
    persisted_settings = {
        item.get("key"): item.get("value") for item in settings_value.get("settings", [])
        if isinstance(item, dict)
    }
    if persisted_settings != expected_settings:
        fail("Pomodoro typed settings readback was not exact")
    contributions = wait_contributions(
        server,
        "pomodoro",
        {("command", value) for value in ("pause", "reset", "skip", "start")}
        | {("status", "status"), ("view", "timer")},
    )
    process_observations.append(server.observe("pomodoro-active", active=True))
    fence = contribution_fence(contributions[0])
    timer, timer_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fence
    )
    status_surface, status_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/status/render", 200, body=fence
    )
    if (
        surface_metric(timer, "timer-value").get("value") != "30:00"
        or surface_metric(status_surface, "status-value").get("tone") != "neutral"
    ):
        fail("Pomodoro settings were not reflected in initial rendered KV state")
    invoke_body = {**fence, "values": []}
    start_value, start_raw = server.expect(
        "POST",
        "/api/v1/plugins/pomodoro/surfaces/timer/actions/start",
        200,
        body=invoke_body,
        operation_id=operation("pomodoro:action:start"),
    )
    start_replay, start_replay_raw = server.expect(
        "POST",
        "/api/v1/plugins/pomodoro/surfaces/timer/actions/start",
        200,
        body=invoke_body,
        operation_id=operation("pomodoro:action:start"),
    )
    if start_value != start_replay or start_raw != start_replay_raw:
        fail("Pomodoro invocation replay was not byte-stable")
    running, running_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/status/render", 200, body=fence
    )
    if surface_metric(running, "status-value").get("tone") != "accent":
        fail("Pomodoro start KV transition was not visible")
    _, pause_raw = server.expect(
        "POST",
        "/api/v1/plugins/pomodoro/commands/pause",
        200,
        body=invoke_body,
        operation_id=operation("pomodoro:command:pause"),
    )
    paused, paused_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/status/render", 200, body=fence
    )
    if surface_metric(paused, "status-value").get("tone") != "neutral":
        fail("Pomodoro pause KV transition was not visible")
    _, skip_raw = server.expect(
        "POST",
        "/api/v1/plugins/pomodoro/surfaces/timer/actions/skip",
        200,
        body=invoke_body,
        operation_id=operation("pomodoro:action:skip"),
    )
    skipped, skipped_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fence
    )
    if surface_metric(skipped, "timer-value").get("value") != "07:00":
        fail("Pomodoro skip KV transition/readback did not use typed break settings")
    disable(server, "pomodoro", "pomodoro:first")
    process_observations.append(server.observe("pomodoro-disabled", active=False))
    pomodoro_reenabled = enable(server, "pomodoro", "pomodoro:second")
    fresh = wait_contributions(
        server,
        "pomodoro",
        {("command", value) for value in ("pause", "reset", "skip", "start")}
        | {("status", "status"), ("view", "timer")},
    )
    fresh_fence = contribution_fence(fresh[0])
    if fresh_fence == fence or pomodoro_reenabled.get("activation_epoch") == fence["activation_epoch"]:
        fail("Pomodoro re-enable did not advance contribution authority")
    persisted, persisted_raw = server.expect(
        "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fresh_fence
    )
    if surface_metric(persisted, "timer-value").get("value") != "07:00":
        fail("Pomodoro KV did not survive disable/re-enable")
    stale, stale_status, _ = server.request(
        "POST",
        "/api/v1/plugins/pomodoro/commands/reset",
        body={**fence, "values": []},
        operation_id=operation("pomodoro:stale-fence"),
    )
    if stale_status != 409 or stale.get("error", {}).get("code") != "stale_plugin_authority":
        fail("Pomodoro stale contribution fence was not rejected")
    disable(server, "pomodoro", "pomodoro:second")
    settings_after, settings_after_raw = server.expect(
        "GET", "/api/v1/plugins/pomodoro/settings", 200
    )
    if {item.get("key"): item.get("value") for item in settings_after.get("settings", [])} != expected_settings:
        fail("Pomodoro persisted settings changed across disable/re-enable")
    process_observations.append(server.observe("pomodoro-final-disabled", active=False))
    outcomes["pomodoro"] = {
        "passed": True,
        "typed_settings": expected_settings,
        "setting_receipts": setting_receipts,
        "settings_readback": response_identity(settings_raw),
        "settings_disabled_readback": response_identity(settings_after_raw),
        "kv_observations": {
            "initial_work": {"metric": "30:00", "render": response_identity(timer_raw)},
            "started": {"tone": "accent", "action": response_identity(start_raw), "render": response_identity(running_raw)},
            "paused": {"tone": "neutral", "command": response_identity(pause_raw), "render": response_identity(paused_raw)},
            "skipped_break": {"metric": "07:00", "action": response_identity(skip_raw), "render": response_identity(skipped_raw)},
            "reenabled_readback": {"metric": "07:00", "render": response_identity(persisted_raw)},
        },
        "invocation_replay": {
            "first": response_identity(start_raw),
            "replay": response_identity(start_replay_raw),
        },
        "stale_fences_rejected": 1,
    }

    # 4. Disposable local signer, community policy, altered authority, and dependency graph.
    run_external_package_corpus(
        server, fixtures, poll_timeout, process_observations, outcomes
    )

    # 5. Rust automation: retained and already-open live delivery, exact effects/replay.
    automation = install_registry(server, "automation", REGISTRY_AUTHORITY[0][1], "automation")
    automation_path = package_object_path(server.profile, REGISTRY_AUTHORITY[0][1])
    if not automation_path.is_file() or automation_path.is_symlink():
        fail("Automation content-addressed installed object was absent")
    grant_exact(server, automation, "automation")
    automation = enable(server, "automation", "automation")
    process_observations.append(server.observe("automation-active", active=True))
    assert server.process is not None
    host_pids = [
        pid
        for pid in descendants(server.process.pid)
        if proc_exe(pid) == server.host_path
    ]
    if len(host_pids) != 1:
        fail("automation retained-event setup did not find one exact plugin host")
    retained_before = sync_state(server)
    host_pid = host_pids[0]
    os.kill(host_pid, signal.SIGSTOP)
    try:
        retained_task, retained_raw = create_task(
            server, "automation:retained", "Phase 7 retained automation task", replay=True
        )
        if task(server, retained_task).get("status") != "pending":
            fail("automation retained task completed while plugin execution was paused")
    finally:
        try:
            os.kill(host_pid, signal.SIGCONT)
        except ProcessLookupError:
            pass
    wait_task_status(
        server, [retained_task], "completed", poll_timeout, label="retained automation"
    )
    retained_after = sync_state(server)
    retained_events = server.sse_through(
        retained_before["event_epoch"], retained_before["revision"], retained_after["revision"]
    )

    live_before = sync_state(server)

    def create_live_tasks() -> tuple[int, tuple[list[str], list[bytes]]]:
        task_ids: list[str] = []
        raw_values: list[bytes] = []
        for index in range(2):
            task_id, raw = create_task(
                server, f"automation:live:{index}", f"Phase 7 live automation task {index}"
            )
            task_ids.append(task_id)
            raw_values.append(raw)
        wait_task_status(
            server, task_ids, "completed", poll_timeout, label="live automation"
        )
        return sync_state(server)["revision"], (task_ids, raw_values)

    live_events, live_result = server.sse_during(
        live_before["event_epoch"], live_before["revision"], create_live_tasks
    )
    live_tasks, live_raw = live_result
    automation_tasks = [retained_task, *live_tasks]
    events = [*retained_events, *live_events]
    created_counts = {task_id: 0 for task_id in automation_tasks}
    completed_counts = {task_id: 0 for task_id in automation_tasks}
    created_revisions: dict[str, int] = {}
    completed_revisions: dict[str, int] = {}
    for event in events:
        targets = set(affected_task_ids(event)).intersection(automation_tasks)
        if event.get("event_type") == "task.created":
            for task_id in targets:
                created_counts[task_id] += 1
                created_revisions[task_id] = event["revision"]
        elif event.get("event_type") == "task.completed":
            for task_id in targets:
                completed_counts[task_id] += 1
                completed_revisions[task_id] = event["revision"]
    if set(created_counts.values()) != {1} or set(completed_counts.values()) != {1}:
        fail("automation retained/live corpus contained duplicate or missing effects")
    if not all(created_revisions[task_id] < completed_revisions[task_id] for task_id in automation_tasks):
        fail("automation effect revision did not follow its exact source event")
    automation_dto = installed(server, "automation")
    exposed_progress = {
        key: value
        for key, value in automation_dto.items()
        if "cursor" in key.lower() or "progress" in key.lower()
    }
    if exposed_progress:
        fail("automation DTO unexpectedly exposed an unvalidated cursor contract")

    # Product-level coexistence plus the accepted hostile authority cover sibling survival.
    pomodoro_live = enable(server, "pomodoro", "pomodoro:automation-survival")
    pomodoro_contributions = wait_contributions(
        server,
        "pomodoro",
        {("command", value) for value in ("pause", "reset", "skip", "start")}
        | {("status", "status"), ("view", "timer")},
    )
    coexist_render, coexist_raw = server.expect(
        "POST",
        "/api/v1/plugins/pomodoro/surfaces/timer/render",
        200,
        body=contribution_fence(pomodoro_contributions[0]),
    )
    if surface_metric(coexist_render, "timer-value").get("value") != "07:00":
        fail("unrelated Pomodoro runtime did not survive automation activity")
    if pomodoro_live.get("runtime_state") != "active":
        fail("unrelated Pomodoro runtime lost active authority")
    disable(server, "pomodoro", "pomodoro:automation-survival")

    authority_commit = run_command(
        ["git", "-C", str(ROOT), "cat-file", "-e", HOSTILE_RUNTIME_AUTHORITY["commit"] + "^{commit}"],
        timeout=10,
    )
    if authority_commit.returncode != 0:
        fail("accepted hostile-runtime authority commit is unavailable")
    hostile_authority = {
        **HOSTILE_RUNTIME_AUTHORITY,
        "review_sha256": sha256_file(ROOT / HOSTILE_RUNTIME_AUTHORITY["review"]),
        "runtime_tests_sha256": hostile_runtime_tests_identity(),
    }
    automation_before_backup = installed(server, "automation")
    automation_task_revisions = {
        task_id: task(server, task_id)["revision"] for task_id in automation_tasks
    }
    outcomes["automation"] = {
        "passed": True,
        "retained": {
            "task_id": retained_task,
            "source_response": response_identity(retained_raw),
            "created_revision": created_revisions[retained_task],
            "effect_revision": completed_revisions[retained_task],
            "host_execution_paused_before_commit": True,
            "pending_before_resume": True,
        },
        "live": [
            {
                "task_id": task_id,
                "source_response": response_identity(raw),
                "created_revision": created_revisions[task_id],
                "effect_revision": completed_revisions[task_id],
            }
            for task_id, raw in zip(live_tasks, live_raw, strict=True)
        ],
        "cursor_observation": {
            "mode": "api_observable_no_duplicate_effect",
            "installed_progress_fields": {},
            "technical_limitation": "raw delivery cursor is not exposed by the product HTTP DTO",
        },
        "source_create_replays": 1,
        "duplicate_effects": 0,
        "unrelated_plugin_survival": {
            "plugin_id": "pomodoro",
            "render": response_identity(coexist_raw),
        },
        "hostile_runtime_authority": hostile_authority,
    }

    # 6. Real complete backup and restore while exact bundled event automation is active.
    if (
        automation_before_backup.get("desired_enabled") is not True
        or automation_before_backup.get("runtime_state") != "active"
        or automation_before_backup.get("package_sha256") != REGISTRY_AUTHORITY[0][1]
    ):
        fail("exact bundled automation was not active at backup cutover")
    final_registry, final_registry_raw = server.expect("GET", "/api/v1/plugins/registry", 200)
    if final_registry_raw != registry_raw or exact_registry(final_registry) != registry_summary:
        fail("public bundled registry changed before backup/restore")
    original_state = {
        task_id: {
            "status": task(server, task_id).get("status"),
            "revision": task(server, task_id).get("revision"),
        }
        for task_id in automation_tasks
    }
    server.download_backup(backup_path)
    if backup_path.stat().st_size > DOGFOOD_BACKUP_BYTES_MAX:
        fail("private backup artifact exceeded the dogfood bound")
    divergence_task, divergence_raw = create_task(
        server, "restore:divergence", "Phase 7 post-backup divergence"
    )
    wait_task_status(
        server, [divergence_task], "completed", poll_timeout, label="restore divergence"
    )
    divergence_revision = task(server, divergence_task)["revision"]
    restored, _ = server.expect_octets(
        "POST",
        "/api/v1/backup/restore",
        200,
        backup_path,
        maximum_bytes=DOGFOOD_BACKUP_BYTES_MAX,
    )
    if restored.get("restart_required") is not True:
        fail("restore did not require a real server restart")
    drained, drained_status, _ = server.request("GET", "/api/v1/tasks")
    require_rejection(
        drained,
        drained_status,
        expected_status=503,
        expected_codes={"restart_required"},
        label="ordinary traffic after restore",
    )
    health, _ = server.expect("GET", "/api/v1/health", 200, authenticated=False)
    if health.get("status") != "ok":
        fail("health route was unavailable after restore drain")
    process_observations.append(server.observe("restore-restart-required", active=False))
    backup_path.unlink()
    if backup_path.exists():
        fail("private backup artifact remained after restore upload")
    outcomes["backup_restore_restart"] = {
        "passed": False,
        "private_backup_bounded": True,
        "private_backup_bytes_reported": False,
        "exact_bundled_plugin_enabled_at_backup": True,
        "event_automation_exercised_before_backup": True,
        "divergence_created_after_backup": {
            "task_id": divergence_task,
            "response": response_identity(divergence_raw),
            "revision": divergence_revision,
        },
        "restore_restart_required": True,
        "normal_traffic_drained": True,
        "health_remained_available": True,
        "same_profile_restart": False,
        "disabled_after_restart": False,
        "reverification_fence_observed": False,
        "resync_before_fresh_activation": False,
        "pre_restore_hook_replays": None,
        "current_event_behavior_restored": False,
    }
    outcomes["counts"] = {
        "bundled_components_executed": 3,
        "external_components_activated": 3,
        "tasks_in_backup": 7,
        "post_backup_divergence_tasks": 1,
        "plugin_invocation_replays": 2,
        "stale_fences_rejected": 2,
        "revoked_authority_rejections": 1,
        "external_plugins_uninstalled": 3,
        "bundled_plugins_uninstalled": 0,
        "plugins_uninstalled_total": 3,
    }
    outcomes["registry"] = registry_summary
    return {
        "automation_before": automation_before_backup,
        "automation_task_revisions": automation_task_revisions,
        "automation_tasks": automation_tasks,
        "registry_raw": registry_raw,
        "registry_summary": registry_summary,
        "original_state": original_state,
        "divergence_task": divergence_task,
    }


def run_post_restore_corpus(
    server: ProductServer,
    restore_context: dict[str, Any],
    poll_timeout: float,
    process_observations: list[dict[str, Any]],
    outcomes: dict[str, Any],
) -> None:
    divergence, divergence_status, _ = server.request(
        "GET", f"/api/v1/tasks/{restore_context['divergence_task']}"
    )
    if divergence_status != 404 or not isinstance(divergence, dict):
        fail("restore retained post-backup divergence")
    restored_original_state = {
        task_id: {
            "status": task(server, task_id).get("status"),
            "revision": task(server, task_id).get("revision"),
        }
        for task_id in restore_context["automation_tasks"]
    }
    if restored_original_state != restore_context["original_state"]:
        fail("restore did not recover the exact pre-backup original state")

    plugins, _ = server.expect("GET", "/api/v1/plugins", 200)
    installed_plugins = plugins.get("plugins") if isinstance(plugins, dict) else None
    if not isinstance(installed_plugins, list) or {
        item.get("plugin_id") for item in installed_plugins
    } != {"automation", "import-typescript", "pomodoro"}:
        fail("restored installed plugin inventory was not exact")
    automation_before = restore_context["automation_before"]
    automation_after = installed(server, "automation")
    if (
        automation_after.get("desired_enabled") is not False
        or automation_after.get("runtime_state") != "disabled"
        or automation_after.get("activation_epoch")
        != automation_before.get("activation_epoch") + 1
        or automation_after.get("package_generation")
        != automation_before.get("package_generation")
        or automation_after.get("package_sha256")
        != automation_before.get("package_sha256")
    ):
        fail("restored plugin did not expose its disabled reverification fence")
    contributions, _ = server.expect("GET", "/api/v1/plugins/contributions", 200)
    if contributions.get("contributions") != []:
        fail("restored disabled plugins exposed contributions before explicit enable")
    process_observations.append(server.observe("post-restore-disabled", active=False))

    before_revisions = restore_context["automation_task_revisions"]
    if before_revisions != {
        task_id: task(server, task_id)["revision"]
        for task_id in restore_context["automation_tasks"]
    }:
        fail("restore changed pre-backup automation task revisions")
    reenabled = enable(server, "automation", "automation:post-restore")
    if (
        reenabled.get("activation_epoch") != automation_after.get("activation_epoch") + 1
        or reenabled.get("package_generation")
        != automation_after.get("package_generation")
        or reenabled.get("package_sha256") != automation_after.get("package_sha256")
    ):
        fail("post-restore explicit enable did not issue fresh exact authority")
    process_observations.append(server.observe("post-restore-automation-active", active=True))
    if before_revisions != {
        task_id: task(server, task_id)["revision"]
        for task_id in restore_context["automation_tasks"]
    }:
        fail("plugin resync replayed pre-restore event hooks")

    before = sync_state(server)
    fresh_task, _ = create_task(
        server, "automation:post-restore", "Phase 7 post-restore automation task"
    )
    wait_task_status(
        server, [fresh_task], "completed", poll_timeout, label="post-restore automation"
    )
    after = sync_state(server)
    events = server.sse_through(before["event_epoch"], before["revision"], after["revision"])
    created = sum(
        event.get("event_type") == "task.created"
        and fresh_task in affected_task_ids(event)
        for event in events
    )
    completed = sum(
        event.get("event_type") == "task.completed"
        and fresh_task in affected_task_ids(event)
        for event in events
    )
    if created != 1 or completed != 1:
        fail("post-restore current event behavior was duplicated or missing")
    disable(server, "automation", "automation:post-restore")
    process_observations.append(server.observe("post-restore-automation-disabled", active=False))

    installed_paths = {
        plugin_id: package_object_path(server.profile, digest)
        for plugin_id, digest, _ in REGISTRY_AUTHORITY
    }
    if not all(path.is_file() and not path.is_symlink() for path in installed_paths.values()):
        fail("content-addressed package objects were absent before uninstall")
    removed_objects: dict[str, str] = {}
    for plugin_id in ("automation", "import-typescript", "pomodoro"):
        server.expect(
            "DELETE",
            f"/api/v1/plugins/{plugin_id}",
            200,
            operation_id=operation(f"uninstall:{plugin_id}"),
        )
        if installed_paths[plugin_id].exists():
            fail(f"content-addressed package object remained after uninstall: {plugin_id}")
        removed_objects[plugin_id] = installed_paths[plugin_id].name
    final_plugins, _ = server.expect("GET", "/api/v1/plugins", 200)
    if final_plugins.get("plugins") != []:
        fail("installed plugin list was not empty after final uninstall")
    final_contributions, _ = server.expect("GET", "/api/v1/plugins/contributions", 200)
    if final_contributions.get("contributions") != []:
        fail("final uninstall retained plugin contributions")
    final_registry, final_registry_raw = server.expect("GET", "/api/v1/plugins/registry", 200)
    if (
        final_registry_raw != restore_context["registry_raw"]
        or exact_registry(final_registry) != restore_context["registry_summary"]
    ):
        fail("public bundled registry changed across backup/restore")
    process_observations.append(server.observe("all-uninstalled", active=False))

    outcomes["backup_restore_restart"].update(
        {
            "passed": True,
            "same_profile_restart": True,
            "disabled_after_restart": True,
            "reverification_fence_observed": True,
            "restored_runtime_state": "disabled",
            "startup_package_reverification_outcome_observed": True,
            "raw_reverify_required_state_exposed_by_http": False,
            "fresh_activation_epoch": True,
            "package_generation_preserved": True,
            "exact_package_hash_preserved": True,
            "grants_preserved": True,
            "raw_resync_flag_exposed_by_http": False,
            "resync_before_fresh_activation": True,
            "pre_restore_hook_replays": 0,
            "current_event_behavior_restored": True,
            "current_tasks_completed": 1,
            "divergence_removed": True,
            "original_state_restored": True,
            "original_state_sha256": hashlib.sha256(
                canonical_json(restored_original_state)
            ).hexdigest(),
        }
    )
    outcomes["cleanup_corpus"] = {
        "passed": True,
        "bundled_plugins_uninstalled": 3,
        "installed_remaining": 0,
        "contributions_remaining": 0,
        "registry_unchanged": True,
        "content_addressed_objects_removed": removed_objects,
    }
    outcomes["counts"].update(
        {
            "tasks_restored_plus_current_total": 8,
            "bundled_plugins_uninstalled": 3,
            "plugins_uninstalled_total": 6,
            "post_restore_current_tasks": 1,
        }
    )


def validate_response_identity(value: Any, label: str) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"sha256", "size_bytes"}
        or not isinstance(value.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])
        or type(value.get("size_bytes")) is not int
        or value["size_bytes"] <= 0
    ):
        fail(f"{label} response identity was malformed")


def validate_completed_report(report: dict[str, Any]) -> None:
    if (
        report.get("protocol") != PROTOCOL
        or report.get("protocol_version") != PROTOCOL_VERSION
        or report.get("schema_version") != SCHEMA_VERSION
        or report.get("pass") is not True
    ):
        fail("completed report protocol or pass marker was invalid")
    scope = report.get("scope")
    if (
        not isinstance(scope, dict)
        or scope.get("excluded") != []
        or scope.get("browser_ui", {}).get("status") != "outside_http_harness"
        or scope.get("browser_ui", {}).get("overall_acceptance")
        != "required_separate_authority"
        or scope.get("browser_ui", {}).get("authority") != BROWSER_UI_AUTHORITY
    ):
        fail("completed report scope was incomplete")
    limitations = report.get("technical_limitations")
    expected_limitations = {
        "external_registry_artifact_or_network_community_registry_ingestion",
        "raw_restore_reverify_or_resync_flags_over_http",
        "raw_plugin_event_cursor_over_http",
    }
    if (
        not isinstance(limitations, list)
        or {value.get("contract") for value in limitations if isinstance(value, dict)}
        != expected_limitations
        or any(
            not isinstance(value, dict)
            or value.get("available") is not False
            or not isinstance(value.get("covered_product_authority"), str)
            or not value["covered_product_authority"]
            for value in limitations
        )
    ):
        fail("completed report did not state exact product contract limitations")
    candidate = report.get("candidate")
    if not isinstance(candidate, dict) or candidate.get("identity_stable") is not True:
        fail("completed report candidate identity was not stable")
    build = report.get("build_attestation")
    if not isinstance(build, dict) or build.get("mode") not in {
        "clean_in_place_rebuild", "supplied_preliminary_outputs"
    }:
        fail("completed report omitted its build attestation")
    if report.get("authoritative") is True:
        if build.get("mode") != "clean_in_place_rebuild" or build.get("commands") != [
            " ".join(command) for command in AUTHORITATIVE_BUILD_COMMANDS
        ]:
            fail("authoritative report did not use the exact fresh build plan")
        if build.get("source_before") != build.get("source_after"):
            fail("authoritative build source identity was not stable")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict) or artifacts.get("public_check_passed") is not True:
        fail("completed report omitted permanent artifact verification")
    corpus = report.get("corpus")
    if not isinstance(corpus, dict):
        fail("completed report omitted product corpus")
    for segment in REQUIRED_CORPUS_SEGMENTS:
        value = corpus.get(segment)
        if not isinstance(value, dict) or value.get("passed") is not True:
            fail(f"completed report did not pass required corpus segment {segment}")
    local = corpus["local_signer"]
    if not all(
        local.get(field) is True
        for field in (
            "unknown_preview_exact",
            "trust_without_install_or_enable",
            "changed_confirmation_rejected",
            "exact_package_installed",
            "publisher_revoke_drained_and_disabled",
            "retrust_fresh_authority",
        )
    ):
        fail("completed report did not pass local signer authority checks")
    dependencies = corpus["dependencies"]
    if not all(
        dependencies.get(field) is True
        for field in (
            "dependency_first_activation",
            "dependent_aware_disable_rejected",
            "dependent_aware_uninstall_rejected",
            "missing_install_rejected",
            "incompatible_install_rejected",
            "cycle_replacement_rejected",
        )
    ):
        fail("completed report did not pass dependency graph checks")
    pomodoro = corpus["pomodoro"]
    if pomodoro.get("typed_settings") != {
        "break-minutes": 7,
        "long-break-minutes": 20,
        "sessions-before-long-break": 3,
        "work-minutes": 30,
    } or set(pomodoro.get("setting_receipts", {})) != {
        "break-minutes", "long-break-minutes", "sessions-before-long-break", "work-minutes"
    }:
        fail("completed report did not retain exact typed Pomodoro settings evidence")
    for key, identity in pomodoro["setting_receipts"].items():
        validate_response_identity(identity, f"pomodoro setting {key}")
    for key in ("settings_readback", "settings_disabled_readback"):
        validate_response_identity(pomodoro.get(key), f"pomodoro {key}")
    expected_kv = {
        "initial_work": ("metric", "30:00"),
        "started": ("tone", "accent"),
        "paused": ("tone", "neutral"),
        "skipped_break": ("metric", "07:00"),
        "reenabled_readback": ("metric", "07:00"),
    }
    for name, (field, expected) in expected_kv.items():
        observation = pomodoro.get("kv_observations", {}).get(name)
        if not isinstance(observation, dict) or observation.get(field) != expected:
            fail(f"Pomodoro KV observation {name} was not exact")
        validate_response_identity(observation.get("render"), f"pomodoro {name} render")
    if pomodoro.get("invocation_replay", {}).get("first") != pomodoro.get("invocation_replay", {}).get("replay"):
        fail("Pomodoro invocation replay identities differed")

    automation = corpus["automation"]
    retained = automation.get("retained")
    live = automation.get("live")
    if not isinstance(retained, dict) or not isinstance(live, list) or len(live) != 2:
        fail("automation retained/live evidence was incomplete")
    if (
        retained.get("host_execution_paused_before_commit") is not True
        or retained.get("pending_before_resume") is not True
    ):
        fail("automation retained-event execution pause was not proven")
    for item in [retained, *live]:
        try:
            uuid.UUID(item["task_id"])
        except (KeyError, ValueError, TypeError) as error:
            raise HarnessError("automation task identity was malformed") from error
        validate_response_identity(item.get("source_response"), "automation source response")
        if type(item.get("created_revision")) is not int or type(item.get("effect_revision")) is not int or item["created_revision"] >= item["effect_revision"]:
            fail("automation source/effect revision progression was invalid")
    cursor = automation.get("cursor_observation")
    if cursor != {
        "mode": "api_observable_no_duplicate_effect",
        "installed_progress_fields": {},
        "technical_limitation": "raw delivery cursor is not exposed by the product HTTP DTO",
    } or automation.get("duplicate_effects") != 0:
        fail("automation cursor limitation or no-duplicate proof was inaccurate")
    hostile = automation.get("hostile_runtime_authority")
    if not isinstance(hostile, dict) or any(
        hostile.get(key) != value for key, value in HOSTILE_RUNTIME_AUTHORITY.items()
    ):
        fail("accepted hostile-runtime authority identity drifted")
    for key in ("review_sha256", "runtime_tests_sha256"):
        if not isinstance(hostile.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", hostile[key]):
            fail("hostile-runtime public hash was malformed")
    review_path = ROOT / HOSTILE_RUNTIME_AUTHORITY["review"]
    if review_path.is_file() and hostile["review_sha256"] != sha256_file(review_path):
        fail("hostile-runtime review hash did not match the current tracked authority")
    if hostile["runtime_tests_sha256"] != hostile_runtime_tests_identity():
        fail("hostile-runtime committed test hash did not match exact authority")

    restored = corpus["backup_restore_restart"]
    if not all(
        restored.get(field) is True
        for field in (
            "restore_restart_required",
            "normal_traffic_drained",
            "same_profile_restart",
            "disabled_after_restart",
            "reverification_fence_observed",
            "startup_package_reverification_outcome_observed",
            "fresh_activation_epoch",
            "package_generation_preserved",
            "exact_package_hash_preserved",
            "grants_preserved",
            "resync_before_fresh_activation",
            "current_event_behavior_restored",
            "divergence_removed",
            "original_state_restored",
        )
    ) or (
        restored.get("restored_runtime_state") != "disabled"
        or restored.get("raw_reverify_required_state_exposed_by_http") is not False
        or restored.get("raw_resync_flag_exposed_by_http") is not False
        or restored.get("pre_restore_hook_replays") != 0
        or not isinstance(restored.get("original_state_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", restored["original_state_sha256"])
    ):
        fail("completed report did not pass backup/restore authority checks")
    cleanup_corpus = corpus["cleanup_corpus"]
    removed = cleanup_corpus.get("content_addressed_objects_removed")
    if not isinstance(removed, dict) or set(removed) != {"automation", "import-typescript", "pomodoro"} or any(
        not re.fullmatch(r"[0-9a-f]{64}\.jbp", value) for value in removed.values()
    ):
        fail("completed report did not prove content-addressed filesystem removal")
    cleanup = report.get("cleanup")
    if not isinstance(cleanup, dict) or not all(
        cleanup.get(field) is True for field in REQUIRED_CLEANUP_CHECKS
    ):
        fail("completed report did not pass every required cleanup check")
    observations = report.get("process_observations")
    if not isinstance(observations, list) or not observations:
        fail("completed report omitted process observations")
    if any(
        not isinstance(value, dict)
        or any(name.lower() in NODE_NAMES for name in value.get("descendant_names", []))
        for value in observations
    ):
        fail("completed report contained an invalid runtime process observation")


def self_check() -> None:
    secret = "phase7-self-check-secret-" + "a" * 64
    seed = bytes(range(32))
    seed_representations = {
        seed.hex(),
        seed.hex().upper(),
        base64.b64encode(seed).decode("ascii"),
        base64.urlsafe_b64encode(seed).decode("ascii"),
        base64.b32encode(seed).decode("ascii"),
    }
    secrets = {secret, *seed_representations}
    private = Path("/tmp/phase7-private-self-check")
    sample = f"Authorization: Bearer {secret} at {private}"
    cleaned = redact(sample, secrets, private)
    assert secret not in cleaned and str(private) not in cleaned
    unsafe_values = [
        f'{{"token":"{secret}"}}',
        f'{{"header":"Bearer {secret}"}}',
        f'{{"path":"{private}"}}',
        *(f'{{"seed":"{value}"}}' for value in seed_representations),
    ]
    for unsafe in unsafe_values:
        try:
            assert_report_safe(unsafe, secrets, private)
        except HarnessError:
            pass
        else:
            raise AssertionError("secret marker scan accepted unsafe report")
    corpus = {segment: {"passed": True} for segment in REQUIRED_CORPUS_SEGMENTS}
    corpus["local_signer"].update(
        {
            "unknown_preview_exact": True,
            "trust_without_install_or_enable": True,
            "changed_confirmation_rejected": True,
            "exact_package_installed": True,
            "publisher_revoke_drained_and_disabled": True,
            "retrust_fresh_authority": True,
        }
    )
    corpus["dependencies"].update(
        {
            "dependency_first_activation": True,
            "dependent_aware_disable_rejected": True,
            "dependent_aware_uninstall_rejected": True,
            "missing_install_rejected": True,
            "incompatible_install_rejected": True,
            "cycle_replacement_rejected": True,
        }
    )
    identity = {"sha256": "a" * 64, "size_bytes": 1}
    corpus["pomodoro"].update(
        {
            "typed_settings": {
                "break-minutes": 7,
                "long-break-minutes": 20,
                "sessions-before-long-break": 3,
                "work-minutes": 30,
            },
            "setting_receipts": {
                key: dict(identity)
                for key in (
                    "break-minutes", "long-break-minutes",
                    "sessions-before-long-break", "work-minutes"
                )
            },
            "settings_readback": dict(identity),
            "settings_disabled_readback": dict(identity),
            "kv_observations": {
                "initial_work": {"metric": "30:00", "render": dict(identity)},
                "started": {"tone": "accent", "render": dict(identity)},
                "paused": {"tone": "neutral", "render": dict(identity)},
                "skipped_break": {"metric": "07:00", "render": dict(identity)},
                "reenabled_readback": {"metric": "07:00", "render": dict(identity)},
            },
            "invocation_replay": {"first": dict(identity), "replay": dict(identity)},
        }
    )
    automation_items = [
        {
            "task_id": str(uuid.uuid5(OPERATION_NAMESPACE, f"self:{index}")),
            "source_response": dict(identity),
            "created_revision": index * 2 + 1,
            "effect_revision": index * 2 + 2,
        }
        for index in range(3)
    ]
    automation_items[0].update(
        {
            "host_execution_paused_before_commit": True,
            "pending_before_resume": True,
        }
    )
    corpus["automation"].update(
        {
            "retained": automation_items[0],
            "live": automation_items[1:],
            "cursor_observation": {
                "mode": "api_observable_no_duplicate_effect",
                "installed_progress_fields": {},
                "technical_limitation": "raw delivery cursor is not exposed by the product HTTP DTO",
            },
            "duplicate_effects": 0,
            "hostile_runtime_authority": {
                **HOSTILE_RUNTIME_AUTHORITY,
                "review_sha256": sha256_file(ROOT / HOSTILE_RUNTIME_AUTHORITY["review"]),
                "runtime_tests_sha256": hostile_runtime_tests_identity(),
            },
        }
    )
    corpus["backup_restore_restart"].update(
        {
            "restore_restart_required": True,
            "normal_traffic_drained": True,
            "same_profile_restart": True,
            "disabled_after_restart": True,
            "reverification_fence_observed": True,
            "restored_runtime_state": "disabled",
            "startup_package_reverification_outcome_observed": True,
            "raw_reverify_required_state_exposed_by_http": False,
            "fresh_activation_epoch": True,
            "package_generation_preserved": True,
            "exact_package_hash_preserved": True,
            "grants_preserved": True,
            "raw_resync_flag_exposed_by_http": False,
            "resync_before_fresh_activation": True,
            "current_event_behavior_restored": True,
            "divergence_removed": True,
            "original_state_restored": True,
            "original_state_sha256": "d" * 64,
            "pre_restore_hook_replays": 0,
        }
    )
    corpus["cleanup_corpus"]["content_addressed_objects_removed"] = {
        plugin_id: f"{digest}.jbp" for plugin_id, digest, _ in REGISTRY_AUTHORITY
    }
    sample_report = {
        "protocol": PROTOCOL,
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "pass": True,
        "scope": {
            "excluded": [],
            "browser_ui": {
                "status": "outside_http_harness",
                "overall_acceptance": "required_separate_authority",
                "authority": BROWSER_UI_AUTHORITY,
            },
        },
        "technical_limitations": [
            {
                "contract": "external_registry_artifact_or_network_community_registry_ingestion",
                "available": False,
                "covered_product_authority": "bounded product rejection",
            },
            {
                "contract": "raw_restore_reverify_or_resync_flags_over_http",
                "available": False,
                "covered_product_authority": "bounded product recovery",
            },
            {
                "contract": "raw_plugin_event_cursor_over_http",
                "available": False,
                "covered_product_authority": "bounded observable delivery",
            },
        ],
        "authoritative": False,
        "candidate": {"identity_stable": True},
        "build_attestation": {"mode": "supplied_preliminary_outputs"},
        "artifacts": {"public_check_passed": True},
        "corpus": corpus,
        "cleanup": {field: True for field in REQUIRED_CLEANUP_CHECKS},
        "process_observations": [{"descendant_names": []}],
    }
    validate_completed_report(sample_report)
    missing = dict(sample_report)
    missing["corpus"] = dict(corpus)
    missing["corpus"].pop("dependencies")
    try:
        validate_completed_report(missing)
    except HarnessError:
        pass
    else:
        raise AssertionError("completed report validator accepted a missing corpus segment")
    assert operation("same") == operation("same") and operation("same") != operation("other")
    assert canonical_json({"b": 2, "a": 1}) == b'{"a":1,"b":2}'
    assert within(ROOT / "scripts", ROOT) and not within(Path("/tmp"), ROOT)
    assert TOKENISH_RE.search("a" * 64)
    with tempfile.TemporaryDirectory(prefix="junban-p7-dogfood-stale-") as temporary:
        temporary_root = Path(temporary)
        stale_release = temporary_root / "release"
        stale_dist = temporary_root / "dist"
        stale_release.mkdir()
        stale_dist.mkdir()
        (stale_release / "junban-server").write_bytes(b"stale supplied binary")
        (stale_dist / "index.html").write_text("stale", encoding="utf-8")
        remove_candidate_outputs(stale_release, stale_dist)
        assert not stale_release.exists() and not stale_dist.exists()
    assert AUTHORITATIVE_BUILD_COMMANDS == (
        ("cargo", "clean", "--release"),
        ("cargo", "build", "--locked", "--release", "--workspace", "--all-features"),
        ("pnpm", "build"),
    )
    tampered = json.loads(json.dumps(sample_report))
    tampered["corpus"]["pomodoro"]["kv_observations"]["skipped_break"]["metric"] = "25:00"
    try:
        validate_completed_report(tampered)
    except HarnessError:
        pass
    else:
        raise AssertionError("completed report validator accepted fabricated KV evidence")
    tampered = json.loads(json.dumps(sample_report))
    tampered["corpus"]["automation"]["hostile_runtime_authority"][
        "runtime_tests_sha256"
    ] = "e" * 64
    try:
        validate_completed_report(tampered)
    except HarnessError:
        pass
    else:
        raise AssertionError("completed report validator accepted fabricated runtime authority")
    tampered = json.loads(json.dumps(sample_report))
    tampered["corpus"]["backup_restore_restart"].pop("package_generation_preserved")
    try:
        validate_completed_report(tampered)
    except HarnessError:
        pass
    else:
        raise AssertionError("completed report validator accepted missing restore authority")
    print("Phase 7 plugin dogfood self-check passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, default=Path("target/release/junban-server"))
    parser.add_argument("--host", type=Path, default=Path("target/release/junban-plugin-host"))
    parser.add_argument(
        "--artifact-tool", type=Path, default=Path("target/release/junban-plugin-artifact")
    )
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    parser.add_argument("--output", type=Path, help="required JSON path outside the checkout")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--authoritative-run",
        dest="authoritative",
        action="store_true",
        default=True,
        help="require a clean stable candidate and optimized binaries (default)",
    )
    mode.add_argument(
        "--non-authoritative",
        dest="authoritative",
        action="store_false",
        help="explicitly permit a dirty development candidate",
    )
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--call-timeout", type=float, default=60.0)
    parser.add_argument("--poll-timeout", type=float, default=30.0)
    parser.add_argument("--shutdown-timeout", type=float, default=20.0)
    parser.add_argument("--artifact-timeout", type=float, default=600.0)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        return args
    if args.output is None:
        parser.error("--output is required")
    for name in ("startup_timeout", "call_timeout", "poll_timeout", "shutdown_timeout", "artifact_timeout"):
        value = getattr(args, name)
        if not 0.5 <= value <= 900.0:
            parser.error(f"--{name.replace('_', '-')} must be between 0.5 and 900 seconds")
    return args


def main() -> int:
    args = parse_args()
    if args.self_check:
        self_check()
        return 0

    started_at = utc_now()
    started = time.monotonic()
    secrets: set[str] = set()
    private_root: Path | None = None
    output: Path | None = None
    report: dict[str, Any] = {
        "protocol": PROTOCOL,
        "protocol_version": PROTOCOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "scope": {
            "included": "optimized server, adjacent plugin host, authenticated production HTTP, signed bundled and disposable external packages, dependency policy, backup/restore/restart",
            "excluded": [],
            "browser_ui": {
                "status": "outside_http_harness",
                "overall_acceptance": "required_separate_authority",
                "authority": BROWSER_UI_AUTHORITY,
            },
        },
        "technical_limitations": [
            {
                "contract": "external_registry_artifact_or_network_community_registry_ingestion",
                "available": False,
                "covered_product_authority": "community-policy-gated signed local packages, altered disposable registry rejection, and exact bundled digest mismatch rejection",
            },
            {
                "contract": "raw_restore_reverify_or_resync_flags_over_http",
                "available": False,
                "covered_product_authority": "post-startup disabled state, advanced fence, zero historical replay, fresh current behavior",
            },
            {
                "contract": "raw_plugin_event_cursor_over_http",
                "available": False,
                "covered_product_authority": "retained and already-open live SSE source/effect revisions with exact no-duplicate task effects",
            },
        ],
        "started_at": started_at,
        "finished_at": None,
        "duration_seconds": None,
        "pass": False,
        "authoritative": False,
        "candidate": {},
        "build_attestation": {},
        "binaries": {},
        "artifacts": {},
        "registry": {},
        "corpus": {},
        "process_observations": [],
        "cleanup": {field: False for field in REQUIRED_CLEANUP_CHECKS},
    }
    server_owner: ProductServer | None = None
    restore_owner: ProductServer | None = None
    second_owner: ProductServer | None = None
    owners: list[ProductServer] = []
    shutdown_results: list[dict[str, bool]] = []
    temporary: tempfile.TemporaryDirectory[str] | None = None
    fixtures: dict[str, Any] | None = None
    backup_path: Path | None = None
    failure: str | None = None
    candidate_start: dict[str, Any] | None = None

    try:
        if args.authoritative:
            report["build_attestation"] = authoritative_rebuild()
        else:
            report["build_attestation"] = {"mode": "supplied_preliminary_outputs"}
        server_path, host_path, artifact_tool, web_dir, output = validate_inputs(args)
        candidate_start = candidate_snapshot()
        report["candidate"] = {"start": candidate_start, "end": None, "identity_stable": False}
        if args.authoritative and candidate_start["dirty"]:
            fail("authoritative mode requires a clean candidate at start")

        run_artifact_check(artifact_tool, args.artifact_timeout)
        report["binaries"] = {
            "junban-server": file_identity(server_path, "junban-server"),
            "junban-plugin-host": file_identity(host_path, "junban-plugin-host"),
            "junban-plugin-artifact": file_identity(artifact_tool, "junban-plugin-artifact"),
        }
        report["artifacts"] = {
            "public_checker": file_identity(
                ROOT / "scripts/check-phase7-plugin-artifacts.py",
                "scripts/check-phase7-plugin-artifacts.py",
            ),
            "dogfood_harness": file_identity(
                ROOT / "scripts/run-phase7-plugin-dogfood.py",
                "scripts/run-phase7-plugin-dogfood.py",
            ),
            "public_files": [file_identity(ROOT / relative, relative) for relative in REFERENCE_FILES],
            "production_web": tree_identity(web_dir),
            "public_check_passed": True,
        }

        temporary = tempfile.TemporaryDirectory(prefix="junban-phase7-plugin-dogfood-")
        private_root = Path(temporary.name).resolve(strict=True)
        if within(private_root, ROOT.resolve()):
            fail("private temporary root must be outside the checkout")
        os.chmod(private_root, 0o700)
        profile = private_root / "profile"
        backup_path = private_root / "complete-backup.junban-backup"
        fixtures = create_external_plugin_fixtures(
            artifact_tool, private_root, secrets, args.artifact_timeout
        )

        server_owner = ProductServer(
            server_path,
            host_path,
            web_dir,
            profile,
            private_root,
            secrets,
            args.startup_timeout,
            args.call_timeout,
            args.shutdown_timeout,
            "primary-owner",
        )
        owners.append(server_owner)
        server_owner.start()
        report["corpus"]["owner_isolation"] = assert_competing_owner_rejected(
            server_owner,
            server_path,
            web_dir,
            private_root,
            args.startup_timeout,
        )
        report["process_observations"].append(
            server_owner.observe("primary-after-owner-isolation", active=False)
        )
        restore_context = run_pre_restore_corpus(
            server_owner,
            fixtures,
            backup_path,
            args.poll_timeout,
            report["process_observations"],
            report["corpus"],
        )
        report["registry"] = report["corpus"].pop("registry")
        report["cleanup"]["backup_artifact_removed"] = not backup_path.exists()
        fixture_cleanup = destroy_external_plugin_fixtures(fixtures)
        report["cleanup"].update(fixture_cleanup)
        first_cleanup = server_owner.stop()
        shutdown_results.append(first_cleanup)

        restore_owner = ProductServer(
            server_path,
            host_path,
            web_dir,
            profile,
            private_root,
            secrets,
            args.startup_timeout,
            args.call_timeout,
            args.shutdown_timeout,
            "post-restore-owner",
        )
        owners.append(restore_owner)
        restore_owner.start(existing_profile=True)
        report["cleanup"]["restore_owner_start_passed"] = True
        run_post_restore_corpus(
            restore_owner,
            restore_context,
            args.poll_timeout,
            report["process_observations"],
            report["corpus"],
        )
        restore_cleanup = restore_owner.stop()
        shutdown_results.append(restore_cleanup)

        # A bounded final real owner start is stronger than merely observing flock.
        second_owner = ProductServer(
            server_path,
            host_path,
            web_dir,
            profile,
            private_root,
            secrets,
            args.startup_timeout,
            args.call_timeout,
            args.shutdown_timeout,
            "lock-reacquisition-owner",
        )
        owners.append(second_owner)
        second_owner.start(existing_profile=True)
        report["process_observations"].append(
            second_owner.observe("second-owner-dormant", active=False)
        )
        second_cleanup = second_owner.stop()
        shutdown_results.append(second_cleanup)
        report["cleanup"]["second_owner_start_passed"] = True

        candidate_end = candidate_snapshot()
        stable = candidate_start == candidate_end
        report["candidate"].update({"end": candidate_end, "identity_stable": stable})
        if not stable:
            fail("candidate identity changed during dogfood run")
        if args.authoritative and candidate_end["dirty"]:
            fail("authoritative mode requires a clean candidate at end")
        report["authoritative"] = bool(args.authoritative)
    except Exception as error:  # failure report is intentionally honest and redacted
        failure = redact(str(error) or error.__class__.__name__, secrets, private_root)
        active_owner = next(
            (
                owner
                for owner in reversed(owners)
                if owner.process is not None and owner.process.poll() is None
            ),
            None,
        )
        if active_owner is not None:
            diagnostic = active_owner.diagnostic().strip()
            if diagnostic:
                failure += f"; redacted server diagnostic: {diagnostic}"
    finally:
        for owner in reversed(owners):
            if owner.process is not None and owner.process.poll() is None:
                try:
                    shutdown_results.append(owner.stop(require_graceful=False))
                except Exception:
                    pass
        if backup_path is not None and backup_path.exists():
            try:
                backup_path.unlink()
            except OSError:
                pass
        if backup_path is not None:
            report["cleanup"]["backup_artifact_removed"] = not backup_path.exists()
        if fixtures is not None and fixtures["root"].exists():
            try:
                report["cleanup"].update(destroy_external_plugin_fixtures(fixtures))
            except Exception:
                pass
        if fixtures is not None:
            report["cleanup"]["seed_removed"] = not fixtures["seed"].exists()
            report["cleanup"]["generated_fixture_root_removed"] = not fixtures["root"].exists()
        if shutdown_results:
            report["cleanup"].update(
                {
                    "runtime_removed": all(
                        result["runtime_removed"] for result in shutdown_results
                    ),
                    "profile_lock_reacquired": all(
                        result["lock_reacquired"] for result in shutdown_results
                    ),
                    "descendants_gone": all(
                        result["descendants_gone"] for result in shutdown_results
                    ),
                    "no_host_orphan": all(
                        result["no_host_orphan"] for result in shutdown_results
                    ),
                }
            )
        if temporary is not None:
            temporary.cleanup()
            report["cleanup"]["temporary_root_removed"] = not Path(temporary.name).exists()
        if candidate_start is not None and report["candidate"].get("end") is None:
            try:
                candidate_end = candidate_snapshot()
                report["candidate"].update(
                    {"end": candidate_end, "identity_stable": candidate_start == candidate_end}
                )
            except Exception:
                report["candidate"]["end_identity_available"] = False
        report["finished_at"] = utc_now()
        report["duration_seconds"] = round(time.monotonic() - started, 3)
        if failure is None:
            try:
                report["pass"] = True
                validate_completed_report(report)
            except Exception as validation_error:
                report["pass"] = False
                failure = redact(
                    str(validation_error) or validation_error.__class__.__name__,
                    secrets,
                    private_root,
                )
        if failure is not None:
            report["pass"] = False
            report["failure"] = failure
        if output is not None:
            try:
                write_report(output, report, secrets, private_root)
            except Exception as write_error:
                print(
                    f"Phase 7 plugin dogfood could not write a safe result: {write_error}",
                    file=sys.stderr,
                )
                return 1

    if failure is not None:
        print(f"Phase 7 plugin dogfood failed: {failure}", file=sys.stderr)
        return 1
    print("Phase 7 plugin dogfood passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
