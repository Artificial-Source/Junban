#!/usr/bin/env python3
"""Collect and verify Phase 7 Wave 5 optimized product performance evidence.

The collector uses fresh systemd --user cgroup-v2 leaves and private profiles.
The evidence checker is deliberately independent of collection: it validates an
exact versioned schema and recomputes every aggregate and gate from raw samples.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import http.client
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, NoReturn

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve()
BENCH_PATH = ROOT / "scripts/bench-hosted-server.py"
DOGFOOD_PATH = ROOT / "scripts/run-phase7-plugin-dogfood.py"
HOST_CHECK_PATH = ROOT / "scripts/check-phase7-sdk-matched-release.py"
ARTIFACT_CHECKER = ROOT / "scripts/check-phase7-plugin-artifacts.py"
PROTOCOL_PATH = ROOT / "goals/rust-rewrite/evidence/phase-7-wave-5-protocol.md"

PROTOCOL = "junban-phase7-wave5-integrated-performance-v1"
SCHEMA_VERSION = 3
CHECKER_VERSION = 3
BASE_COMMIT = "6401108b31e7768048d154c8b14662bb3a2e9bb1"
BASE_TREE = "13edb8869d2a01a3b8a33dc0f57a97bb64cdf94f"
AUTHORITATIVE_BUILD_COMMANDS = (
    ("cargo", "clean", "--release"),
    ("cargo", "build", "--locked", "--release", "--workspace", "--all-features"),
    ("pnpm", "build"),
)
REPORT_NAMES = {
    "default": "phase-7-default-benchmark.json",
    "rust": "phase-7-rust-benchmark.json",
    "typescript": "phase-7-typescript-benchmark.json",
}
SAMPLES = 5
QUICK_SAMPLES = 1
MIB = 1024 * 1024
DEFAULT_CURRENT_BUDGET = 24 * MIB
DEFAULT_PEAK_BUDGET = 32 * MIB
RUST_CURRENT_BUDGET = 91_678_720
RUST_PEAK_BUDGET = 131_328_000
TYPESCRIPT_CURRENT_BUDGET = 692_418_560
TYPESCRIPT_PEAK_BUDGET = 806_824_960
DELTA_FLOOR = MIB
DELTA_PERCENT = 0.15
POLL = 0.025
START_TIMEOUT = 30.0
CALL_TIMEOUT = 60.0
STOP_TIMEOUT = 20.0
ARTIFACT_TIMEOUT = 600.0
HOST_IDLE_TIMEOUT = 15 * 60.0
HOST_IDLE_POLL = 10.0
WASMTIME_MARKERS = (b"wasmtime_runtime", b"wasmtime_wasi", b"wasmtime::runtime", b"cranelift_codegen")
FORBIDDEN_RUNTIME_NAMES = frozenset(
    {"node", "nodejs", "npm", "pnpm", "npx", "vite", "playwright", "chromium", "chrome", "firefox"}
)
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
BEARER_RE = re.compile(r"(?i)\bbearer\s+[a-z0-9_.=+/-]{8,}")
AUTH_RE = re.compile(r"(?i)authorization\s*[:=]")
TOKEN_RE = re.compile(r"(?i)\bjba_[0-9a-f-]{36}_[0-9a-f]{64}\b")
PRIVATE_PATH_RE = re.compile(r"(?:^|[\s\"'])/(?:tmp|home|run/user|sys/fs/cgroup)/")
FORBIDDEN_KEY_RE = re.compile(r"(?i)(?:^|_)(?:pid|token|authorization|bearer|private_key|profile_path|cgroup_path)(?:$|_)")

REGISTRY = (
    ("automation", "14457dc76c42c23178ec56fa5e4fcb9fa27dd1996a795db70cf64adf07e48ee1"),
    ("import-typescript", "69daf8a5346a7d9e213f8d4e49aaa11f12014ebfa1252082750e1597d1805085"),
    ("pomodoro", "829723f49e2ec911f93d40dfcc2664ee08f495f9e710d227434f07456e0d103b"),
)
PUBLISHER_KEY_ID = "35ab9815a29650c2985186daa06eef9362ff0312b89df0b080517ddcf18b8595"

COMMON_KEYS = {
    "artifacts",
    "artifact_check_passed",
    "build_attestation",
    "platform",
    "host",
    "toolchain",
    "command_template",
}
REPORT_KEYS = {
    "schema_version",
    "protocol",
    "report_kind",
    "authority",
    "quick",
    "started_at",
    "finished_at",
    "candidate",
    "common",
    "base",
    "workload",
    "samples",
    "aggregates",
    "budgets",
    "budget_passed",
    "checker",
}
CANDIDATE_KEYS = {
    "commit",
    "tree",
    "index_tree",
    "working_state_sha256",
    "clean_at_start",
    "clean_at_end",
    "identity_stable",
}
IDENTITY_KEYS = {"sha256", "size_bytes"}
MEASUREMENT_KEYS = {
    "label",
    "memory_current_bytes",
    "memory_peak_bytes",
    "memory_swap_current_bytes",
    "memory_swap_peak_bytes",
    "memory_anon_bytes",
    "memory_file_bytes",
    "reclaim_file_bytes",
    "reclaim_result",
    "reclaim_attempts",
    "post_reclaim_memory_current_bytes",
    "post_reclaim_file_bytes",
    "processes",
    "server_count",
    "host_count",
    "unexpected_count",
    "node_count",
}
PROCESS_KEYS = {"name", "rss_bytes", "pss_bytes"}
CLEANUP_KEYS = {
    "runtime_metadata_removed",
    "profile_lock_released",
    "empty_cgroup",
    "cgroup_removed",
    "no_host_orphan",
    "profile_removed",
    "graceful_exit",
}
CHECKER_KEYS = {"version", "sha256", "document_payload_sha256"}


class HarnessError(RuntimeError):
    """A fail-closed collection or evidence error."""


def fail(message: str) -> NoReturn:
    raise HarnessError(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_identity(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        fail(f"required public input is missing or unsafe: {path.name}")
    return {"sha256": sha256_file(path), "size_bytes": path.stat().st_size}


def tree_identity(root: Path) -> dict[str, Any]:
    if root.is_symlink() or not root.is_dir() or not (root / "index.html").is_file():
        fail("production dist is missing or unsafe")
    digest = hashlib.sha256()
    total = count = 0
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.as_posix()):
        if path.is_symlink():
            fail("production dist contains a symbolic link")
        relative = path.relative_to(root).as_posix().encode()
        size = path.stat().st_size
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256_file(path)))
        digest.update(size.to_bytes(8, "big"))
        total += size
        count += 1
    if count == 0:
        fail("production dist is empty")
    return {"sha256": digest.hexdigest(), "size_bytes": total}


def run(
    args: list[str],
    *,
    cwd: Path = ROOT,
    timeout: float = 60.0,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HarnessError(f"command could not complete: {Path(args[0]).name}") from error
    if check and result.returncode != 0:
        tail = (result.stdout + result.stderr)[-4096:].decode("utf-8", errors="replace").strip()
        fail(f"command failed: {Path(args[0]).name}" + (f" ({tail})" if tail else ""))
    return result


def load_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        fail(f"could not load helper {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_regular(path: Path, label: str, *, executable: bool = False) -> Path:
    try:
        metadata = path.expanduser().lstat()
        resolved = path.expanduser().resolve(strict=True)
    except OSError as error:
        raise HarnessError(f"required {label} is missing") from error
    if path.is_symlink() or not resolved.is_file():
        fail(f"required {label} is not a regular non-link file")
    if executable and not os.access(resolved, os.X_OK):
        fail(f"required {label} is not executable")
    return resolved


def within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def git_text(*args: str, cwd: Path = ROOT) -> str:
    return run(["git", "-C", str(cwd), *args], timeout=30).stdout.decode("utf-8", errors="strict").strip()


def candidate_snapshot() -> dict[str, Any]:
    status = run(
        ["git", "-C", str(ROOT), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        timeout=30,
    ).stdout
    diff = run(["git", "-C", str(ROOT), "diff", "--no-ext-diff", "--binary", "HEAD"], timeout=60).stdout
    state = hashlib.sha256(status + diff)
    for entry in status.split(b"\0"):
        if len(entry) < 4 or not entry.startswith(b"?? "):
            continue
        relative = entry[3:].decode("utf-8", errors="strict")
        path = ROOT / relative
        if path.is_file() and not path.is_symlink():
            state.update(relative.encode())
            state.update(bytes.fromhex(sha256_file(path)))
            state.update(path.stat().st_size.to_bytes(8, "big"))
    commit = git_text("rev-parse", "HEAD")
    tree = git_text("rev-parse", "HEAD^{tree}")
    index_tree = git_text("write-tree")
    if not HEX40.fullmatch(commit) or not HEX40.fullmatch(tree) or not HEX40.fullmatch(index_tree):
        fail("candidate git identity is malformed")
    return {
        "commit": commit,
        "tree": tree,
        "index_tree": index_tree,
        "working_state_sha256": state.hexdigest(),
        "clean": not bool(status),
    }


def authoritative_rebuild() -> dict[str, Any]:
    before = candidate_snapshot()
    if not before["clean"]:
        fail("authoritative collection requires a clean candidate before rebuilding outputs")
    shutil.rmtree(ROOT / "target/release", ignore_errors=True)
    shutil.rmtree(ROOT / "dist", ignore_errors=True)
    for command in AUTHORITATIVE_BUILD_COMMANDS:
        run(list(command), timeout=3600)
    after = candidate_snapshot()
    if before != after or not after["clean"]:
        fail("candidate source identity changed during authoritative rebuild")
    return {
        "mode": "clean_in_place_rebuild",
        "commands": [" ".join(command) for command in AUTHORITATIVE_BUILD_COMMANDS],
        "source_before": before,
        "source_after": after,
    }


def candidate_record(start: dict[str, Any], end: dict[str, Any]) -> dict[str, Any]:
    stable = start == end
    return {
        "commit": start["commit"],
        "tree": start["tree"],
        "index_tree": start["index_tree"],
        "working_state_sha256": start["working_state_sha256"],
        "clean_at_start": start["clean"],
        "clean_at_end": end["clean"],
        "identity_stable": stable,
    }


def host_snapshot(host_helper: Any) -> dict[str, Any]:
    raw = host_helper.host_contention(phase="pre")
    swap_used = raw.get("swap_used_mib_informational")
    return {
        "load1": float(raw["load1"]),
        "load5": float(raw["load5"]),
        "load15": float(raw["load15"]),
        "cpu_count": int(raw["cpu_count"]),
        "load1_threshold": float(raw["load1_threshold"]),
        "load5_threshold": float(raw["load5_threshold"]),
        "active_confounder_count": len(raw.get("active_build_confounders") or []),
        "swap_io_active": bool(raw.get("swap_io", {}).get("active")),
        "swap_used_bytes": None if swap_used is None else int(float(swap_used) * MIB),
        "idle": not bool(raw["contended"]) and (swap_used is None or float(swap_used) == 0.0),
    }


def wait_for_idle_host(
    sampler: Callable[[], dict[str, Any]],
    *,
    timeout_seconds: float = HOST_IDLE_TIMEOUT,
    poll_seconds: float = HOST_IDLE_POLL,
    sleep_fn: Callable[[float], None] = time.sleep,
    monotonic_fn: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Return the actual first idle/zero-swap sample, or fail after a bounded wait."""
    if timeout_seconds < 0 or poll_seconds <= 0:
        fail("idle-host wait requires a nonnegative timeout and positive poll interval")
    deadline = monotonic_fn() + timeout_seconds
    announced = False
    while True:
        snapshot = sampler()
        sampled_at = monotonic_fn()
        if snapshot["idle"] and sampled_at <= deadline:
            return snapshot
        remaining = deadline - sampled_at
        if remaining <= 0:
            fail(
                "authoritative collection host did not become idle with zero swap "
                f"within {timeout_seconds:g} seconds after measurement activity; final snapshot: "
                f"load1={snapshot['load1']:.2f}/{snapshot['load1_threshold']:.2f}, "
                f"load5={snapshot['load5']:.2f}/{snapshot['load5_threshold']:.2f}, "
                f"active_build_confounders={snapshot['active_confounder_count']}, "
                f"swap_io_active={snapshot['swap_io_active']}, "
                f"swap_used_bytes={snapshot['swap_used_bytes']}. "
                "Allow build load to settle, stop competing build processes, and disable or "
                "clear swap before retrying"
            )
        if not announced:
            print(
                f"Waiting up to {timeout_seconds:g} seconds for the measurement host "
                "to become idle with zero swap",
                file=sys.stderr,
            )
            announced = True
        sleep_fn(min(poll_seconds, remaining))


def platform_record() -> dict[str, Any]:
    if sys.platform != "linux" or not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        fail("collection requires Linux cgroup v2")
    memory_total = None
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        if line.startswith("MemTotal:"):
            memory_total = int(line.split()[1]) * 1024
            break
    return {
        "system": "Linux",
        "kernel": os.uname().release,
        "machine": os.uname().machine,
        "cpu_count": int(os.cpu_count() or 1),
        "memory_total_bytes": memory_total,
        "cgroup_version": 2,
        "memory_controller": "memory" in Path("/sys/fs/cgroup/cgroup.controllers").read_text().split(),
    }


def tool_version(args: list[str]) -> str:
    result = run(args, timeout=30, check=False)
    if result.returncode != 0:
        return "unavailable"
    value = (result.stdout or result.stderr).decode("utf-8", errors="replace").strip()
    return value[:512]


def toolchain_record() -> dict[str, Any]:
    lock = (ROOT / "Cargo.lock").read_text(encoding="utf-8")
    wasmtime = re.search(r'(?ms)^name = "wasmtime"\nversion = "([^"]+)"', lock)
    return {
        "python": sys.version.split()[0],
        "rustc": tool_version(["rustc", "-Vv"]),
        "cargo": tool_version(["cargo", "-V"]),
        "node": tool_version(["node", "--version"]),
        "pnpm": tool_version(["pnpm", "--version"]),
        "wasmtime": wasmtime.group(1) if wasmtime else "absent",
        "jco": "1.26.1",
        "componentize_js": "0.22.0",
    }


def artifact_identities(server: Path, host: Path, tool: Path, web_dir: Path) -> dict[str, Any]:
    files = {
        "junban_server": server,
        "junban_plugin_host": host,
        "junban_plugin_artifact": tool,
        "artifact_checker": ARTIFACT_CHECKER,
        "performance_harness": SCRIPT,
        "dogfood_harness": DOGFOOD_PATH,
        "hosted_benchmark": BENCH_PATH,
        "protocol": PROTOCOL_PATH,
        "cargo_lock": ROOT / "Cargo.lock",
        "pnpm_lock": ROOT / "pnpm-lock.yaml",
        "rust_toolchain": ROOT / "rust-toolchain.toml",
        "cargo_manifest": ROOT / "Cargo.toml",
        "package_manifest": ROOT / "package.json",
        "openapi": ROOT / "openapi/junban-v1.json",
        "wit_contract": ROOT / "crates/junban-plugin-sdk/wit/plugin.wit",
        "registry_index": ROOT / "plugins/registry/index.jri",
        "registry_root_public_key": ROOT / "plugins/registry/root-public-key.bin",
        "publisher_public_key": ROOT / "plugins/registry/publisher-public-key.bin",
        "include_table": ROOT / "crates/junban-server/src/bundled_registry_include.rs",
        "automation_source": ROOT / "plugins/reference/automation-rust/plugin-source.json",
        "automation_component": ROOT / "plugins/reference/automation-rust/artifacts/automation.wasm",
        "pomodoro_source": ROOT / "plugins/reference/pomodoro-rust/plugin-source.json",
        "pomodoro_component": ROOT / "plugins/reference/pomodoro-rust/artifacts/pomodoro.wasm",
        "typescript_source": ROOT / "plugins/reference/import-typescript/plugin-source.json",
        "typescript_component": ROOT / "plugins/reference/import-typescript/artifacts/import-typescript.wasm",
    }
    for plugin_id, digest in REGISTRY:
        files[f"package_{plugin_id.replace('-', '_')}"] = ROOT / f"plugins/registry/sha256/{digest}.jbp"
    identities = {name: file_identity(path) for name, path in files.items()}
    identities["production_dist"] = tree_identity(web_dir)
    return identities


def public_artifact_check(tool: Path) -> None:
    result = run(
        [sys.executable, str(ARTIFACT_CHECKER), "--tool", str(tool)],
        timeout=ARTIFACT_TIMEOUT,
        check=False,
    )
    if result.returncode != 0:
        fail("permanent public artifact checker rejected candidate inputs")


def require_cgroup_tools() -> None:
    for name in ("systemctl", "systemd-run"):
        if shutil.which(name) is None:
            fail("systemd --user cgroup delegation tools are unavailable")
    result = run(["systemctl", "--user", "is-system-running"], check=False, timeout=10)
    state = result.stdout.decode(errors="replace").strip()
    if result.returncode not in (0, 1) and state not in {"running", "degraded", "starting", "maintenance"}:
        fail(f"systemd --user is unavailable (state={state!r})")


def poll(timeout: float, predicate: Callable[[], bool], message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(POLL)
    fail(message)


def unit_property(unit: str, prop: str, *, allow_failure: bool = False) -> str:
    result = run(
        ["systemctl", "--user", "show", unit, f"--property={prop}", "--value"],
        timeout=10,
        check=False,
    )
    if result.returncode != 0 and not allow_failure:
        fail(f"could not inspect transient cgroup property {prop}")
    return result.stdout.decode(errors="replace").strip()


def lock_is_free(profile: Path) -> bool:
    lock = profile / "profile.lock"
    if not lock.exists():
        return True
    import fcntl

    try:
        fd = os.open(lock, os.O_RDWR)
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


def directory_size(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            total += path.stat().st_size
    return total


def proc_exe(process: int) -> Path | None:
    try:
        return Path(os.readlink(f"/proc/{process}/exe")).resolve(strict=True)
    except OSError:
        return None


def proc_memory(process: int) -> tuple[int, int]:
    try:
        status = Path(f"/proc/{process}/status").read_text(encoding="utf-8")
        rollup = Path(f"/proc/{process}/smaps_rollup").read_text(encoding="utf-8")
        rss = next(int(line.split()[1]) * 1024 for line in status.splitlines() if line.startswith("VmRSS:"))
        pss = next(int(line.split()[1]) * 1024 for line in rollup.splitlines() if line.startswith("Pss:"))
    except (OSError, StopIteration, ValueError) as error:
        raise HarnessError("per-process RSS/PSS was unavailable") from error
    return rss, pss


def exact_host_processes(host: Path) -> set[int]:
    found: set[int] = set()
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and proc_exe(int(entry.name)) == host:
            found.add(int(entry.name))
    return found


class CgroupServer:
    """One release server in one fresh transient cgroup and private profile."""

    def __init__(
        self,
        server: Path,
        host: Path | None,
        web_dir: Path,
        private_root: Path,
        label: str,
        *,
        token: str | None = None,
        require_reclaim: bool = False,
    ) -> None:
        self.server = server
        self.host = host
        self.web_dir = web_dir
        self.profile = private_root / f"profile-{label}"
        self.profile.mkdir(mode=0o700)
        self.label = label
        self.unit = f"junban-p7w5-{uuid.uuid4().hex[:16]}.service"
        self.group: Path | None = None
        self.base_url = ""
        self.address = ""
        self.call_timeout = CALL_TIMEOUT
        self.token = token or ""
        if token is not None:
            token_path = self.profile / "access-token"
            fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                target.write(self.token + "\n")
        self.main_process: int | None = None
        self.preexisting_hosts = exact_host_processes(host) if host is not None else set()
        self.started = False
        self.stopped = False
        self.require_reclaim = require_reclaim

    def start(self) -> float:
        started = time.perf_counter()
        command = [
            "systemd-run",
            "--user",
            f"--unit={self.unit.removesuffix('.service')}",
            "--property=Type=exec",
            "--property=RemainAfterExit=yes",
            "--property=MemoryAccounting=yes",
            "--property=MemorySwapMax=0",
            "--property=TasksAccounting=yes",
            "--property=UMask=0077",
            "--property=StandardOutput=null",
            "--property=StandardError=journal",
            "--",
            str(self.server),
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            str(self.profile),
            "--web-dir",
            str(self.web_dir),
        ]

        run(command, timeout=30)
        self.started = True

        def unit_ready() -> bool:
            value = unit_property(self.unit, "MainPID", allow_failure=True)
            if value.isdigit() and int(value) > 0:
                self.main_process = int(value)
                return True
            state = unit_property(self.unit, "ActiveState", allow_failure=True)
            if state == "failed":
                fail(f"{self.label}: server exited during startup")
            return False

        poll(START_TIMEOUT, unit_ready, f"{self.label}: systemd unit did not publish its server")
        control_group = unit_property(self.unit, "ControlGroup")
        if not control_group.startswith("/"):
            fail("transient unit omitted its cgroup-v2 leaf")
        self.group = Path("/sys/fs/cgroup") / control_group.lstrip("/")
        required = (
            "memory.current",
            "memory.peak",
            "memory.stat",
            "memory.swap.current",
            "memory.swap.peak",
            "memory.swap.max",
            "memory.reclaim",
            "cgroup.procs",
            "cgroup.events",
        )
        if any(not (self.group / name).is_file() for name in required):
            fail("fresh cgroup leaf lacks required memory/swap/reclaim/process metrics")
        if (self.group / "memory.swap.max").read_text(encoding="ascii").strip() != "0":
            fail("fresh cgroup leaf did not enforce memory.swap.max=0")

        runtime = self.profile / "runtime.json"
        holder: dict[str, Any] = {}

        def runtime_ready() -> bool:
            try:
                value = json.loads(runtime.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            address = value.get("address") if isinstance(value, dict) else None
            if not isinstance(address, str) or not address.startswith("127.0.0.1:"):
                return False
            holder["address"] = address
            return True

        poll(START_TIMEOUT, runtime_ready, f"{self.label}: runtime metadata was not published")
        self.address = holder["address"]
        self.base_url = f"http://{self.address}"
        if not self.token:
            try:
                self.token = (self.profile / "access-token").read_text(encoding="utf-8").strip()
            except OSError as error:
                raise HarnessError(f"{self.label}: server token publication failed") from error
            if len(self.token) < 64 or any(character.isspace() for character in self.token):
                fail(f"{self.label}: server token publication was invalid")

        def health() -> bool:
            try:
                value, status, _ = self.request("GET", "/api/v1/health", authenticated=False)
                return status == 200 and isinstance(value, dict)
            except HarnessError:
                return False

        poll(START_TIMEOUT, health, f"{self.label}: health readiness failed")
        return (time.perf_counter() - started) * 1000.0

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
        data = None
        if body is not None:
            data = canonical(body)
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["Origin"] = self.base_url
        if operation_id is not None:
            uuid.UUID(operation_id)
            headers["Idempotency-Key"] = operation_id
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=CALL_TIMEOUT) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            raw = error.read(2 * 1024 * 1024 + 1)
            status = int(error.code)
        except (urllib.error.URLError, TimeoutError) as error:
            raise HarnessError(f"HTTP {method} {path} did not complete") from error
        if len(raw) > 2 * 1024 * 1024:
            fail(f"HTTP {method} {path} exceeded response bound")
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeError, json.JSONDecodeError) as error:
            raise HarnessError(f"HTTP {method} {path} returned malformed JSON") from error
        return payload, status, raw

    def expect(
        self,
        method: str,
        path: str,
        expected: int,
        *,
        body: Any | None = None,
        operation_id: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Any, bytes]:
        value, status, raw = self.request(
            method,
            path,
            body=body,
            operation_id=operation_id,
            authenticated=authenticated,
        )
        if status != expected:
            code = value.get("error", {}).get("code") if isinstance(value, dict) else None
            fail(f"HTTP {method} {path} returned {status}, expected {expected} (code={code}, body={value!r})")
        return value, raw

    def sse_through(self, event_epoch: str, since: int, through: int) -> list[dict[str, Any]]:
        parsed = urllib.parse.urlparse(self.base_url)
        if parsed.hostname is None or parsed.port is None:
            fail("runtime address was invalid")
        path = "/api/v1/events?" + urllib.parse.urlencode({"event_epoch": event_epoch, "since": since})
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=CALL_TIMEOUT)
        events: list[dict[str, Any]] = []
        try:
            connection.request(
                "GET",
                path,
                headers={"Host": self.address, "Authorization": f"Bearer {self.token}", "Accept": "text/event-stream"},
            )
            response = connection.getresponse()
            if response.status != 200:
                fail("event catch-up request failed")
            lines: list[str] = []
            while not events or int(events[-1].get("revision", -1)) < through:
                raw = response.readline(512 * 1024)
                if not raw:
                    fail("event catch-up ended early")
                line = raw.decode("utf-8", errors="strict").rstrip("\r\n")
                if line.startswith("data:"):
                    lines.append(line[5:].lstrip())
                elif not line and lines:
                    value = json.loads("\n".join(lines))
                    lines.clear()
                    if isinstance(value, dict) and isinstance(value.get("revision"), int):
                        events.append(value)
                if len(events) > 2048:
                    fail("event catch-up exceeded retained-event bound")
            return events
        finally:
            connection.close()

    def process_records(self) -> tuple[list[dict[str, Any]], dict[str, int]]:
        assert self.group is not None
        processes: list[dict[str, Any]] = []
        counts = {"server": 0, "host": 0, "unexpected": 0, "node": 0}
        try:
            process_ids = [int(value) for value in (self.group / "cgroup.procs").read_text().split()]
        except (OSError, ValueError) as error:
            raise HarnessError("cgroup process membership was unavailable") from error
        for process in process_ids:
            executable = proc_exe(process)
            if executable is None:
                fail("cgroup contained an unidentifiable process")
            name = executable.name
            lowered = name.lower()
            if executable == self.server:
                counts["server"] += 1
            elif self.host is not None and executable == self.host:
                counts["host"] += 1
            else:
                counts["unexpected"] += 1
            if lowered in FORBIDDEN_RUNTIME_NAMES:
                counts["node"] += 1
            rss, pss = proc_memory(process)
            processes.append({"name": name, "rss_bytes": rss, "pss_bytes": pss})
        return sorted(processes, key=lambda value: value["name"]), counts

    def observation(self, label: str, *, server_count: int, host_count: int) -> dict[str, Any]:
        assert self.group is not None

        def memory_state() -> tuple[int, dict[str, int]]:
            current = int((self.group / "memory.current").read_text(encoding="ascii").strip())
            values: dict[str, int] = {}
            for line in (self.group / "memory.stat").read_text(encoding="ascii").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1].isdigit():
                    values[parts[0]] = int(parts[1])
            if "anon" not in values or "file" not in values:
                fail("cgroup memory.stat omitted anon/file authority")
            return current, values

        current, stat_values = memory_state()
        file_bytes = stat_values["file"]
        reclaim_result = "not_needed"
        reclaim_attempts: list[dict[str, Any]] = []
        request_bytes = file_bytes
        if file_bytes:
            for attempt in range(1, 4):
                try:
                    (self.group / "memory.reclaim").write_text(
                        f"{request_bytes} swappiness=0\n", encoding="ascii"
                    )
                    result = "written"
                except BlockingIOError:
                    result = "eagain"
                except OSError as error:
                    raise HarnessError("exact file-only cgroup reclaim was unavailable") from error
                after_current, after_stat = memory_state()
                reclaim_attempts.append(
                    {
                        "requested_file_bytes": request_bytes,
                        "result": result,
                        "memory_current_after_bytes": after_current,
                        "memory_file_after_bytes": after_stat["file"],
                    }
                )
                reclaim_result = result
                if result == "written":
                    break
                if attempt < 3:
                    # Linux reports EAGAIN when it cannot reclaim the complete
                    # request. Re-read both raw authorities before a bounded,
                    # still-file-only retry. One page avoids repeatedly asking
                    # for known active mappings; a zero-file reread is retried
                    # with an honest zero-byte write rather than synthesized as
                    # success.
                    retry_ceiling = 4096 if request_bytes > 4096 else request_bytes // 2
                    request_bytes = min(after_stat["file"], retry_ceiling)
                    time.sleep(POLL * attempt)
                else:
                    break
        if self.require_reclaim and reclaim_result != "written":
            fail(f"{label}: authoritative file-only reclaim did not succeed")
        post_current, post_stat = memory_state()
        post_file = post_stat["file"]
        if reclaim_result == "written":
            # The completed file-only write does not itself imply that cgroup
            # accounting has quiesced. Require three unchanged rereads within a
            # bounded window so a single scheduler/accounting race cannot decide
            # a matched median.
            stable_reads = 0
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and stable_reads < 3:
                time.sleep(POLL)
                current_read, stat_read = memory_state()
                if current_read == post_current and stat_read["file"] == post_file:
                    stable_reads += 1
                else:
                    stable_reads = 0
                    post_current = current_read
                    post_file = stat_read["file"]
        processes, counts = self.process_records()
        if counts != {"server": server_count, "host": host_count, "unexpected": 0, "node": 0}:
            fail(f"{label}: measured cgroup process composition was invalid")
        peak = int((self.group / "memory.peak").read_text(encoding="ascii").strip())
        swap_current = int((self.group / "memory.swap.current").read_text(encoding="ascii").strip())
        swap_peak = int((self.group / "memory.swap.peak").read_text(encoding="ascii").strip())
        if swap_current != 0 or swap_peak != 0:
            fail("measured cgroup used swap")
        return {
            "label": label,
            "memory_current_bytes": current,
            "memory_peak_bytes": peak,
            "memory_swap_current_bytes": swap_current,
            "memory_swap_peak_bytes": swap_peak,
            "memory_anon_bytes": stat_values["anon"],
            "memory_file_bytes": stat_values["file"],
            "reclaim_file_bytes": file_bytes,
            "reclaim_result": reclaim_result,
            "reclaim_attempts": reclaim_attempts,
            "post_reclaim_memory_current_bytes": post_current,
            "post_reclaim_file_bytes": post_file,
            "processes": processes,
            "server_count": counts["server"],
            "host_count": counts["host"],
            "unexpected_count": counts["unexpected"],
            "node_count": counts["node"],
        }

    def wait_host_exit(self) -> None:
        if self.host is None:
            return
        poll(
            STOP_TIMEOUT,
            lambda: self.process_records()[1]["host"] == 0,
            f"{self.label}: plugin host did not naturally exit",
        )

    def stop(self) -> tuple[int, dict[str, Any]]:
        if not self.started or self.stopped:
            fail("server lifecycle stop was invoked out of order")
        assert self.main_process is not None and self.group is not None
        # systemd removes an empty service leaf immediately. Sample cumulative
        # memory.peak and swap continuously through exit so the final value seen
        # before removal covers shutdown rather than substituting a warm peak.
        monitor_stop = threading.Event()
        monitored = {
            "peak": int((self.group / "memory.peak").read_text(encoding="ascii").strip()),
            "swap_current": 0,
            "swap_peak": 0,
            "reads": 0,
        }

        def monitor() -> None:
            while not monitor_stop.is_set():
                try:
                    monitored["peak"] = max(
                        monitored["peak"],
                        int((self.group / "memory.peak").read_text(encoding="ascii").strip()),
                    )
                    monitored["swap_current"] = max(
                        monitored["swap_current"],
                        int((self.group / "memory.swap.current").read_text(encoding="ascii").strip()),
                    )
                    monitored["swap_peak"] = max(
                        monitored["swap_peak"],
                        int((self.group / "memory.swap.peak").read_text(encoding="ascii").strip()),
                    )
                    monitored["reads"] += 1
                except OSError:
                    return
                monitor_stop.wait(0.001)

        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        os.kill(self.main_process, signal.SIGTERM)

        def exited() -> bool:
            return not Path(f"/proc/{self.main_process}").exists()

        graceful = True
        try:
            poll(STOP_TIMEOUT, exited, f"{self.label}: graceful server shutdown timed out")
        except HarnessError:
            graceful = False
            run(["systemctl", "--user", "kill", self.unit, "--signal=SIGKILL"], check=False)
            poll(5.0, exited, f"{self.label}: forced server shutdown timed out")
        monitor_stop.set()
        monitor_thread.join(timeout=2.0)
        if monitored["reads"] == 0 or monitored["swap_current"] or monitored["swap_peak"]:
            fail("shutdown cgroup lifecycle memory/swap authority was unavailable or nonzero")
        runtime_removed = not (self.profile / "runtime.json").exists()
        if not runtime_removed:
            poll(5.0, lambda: not (self.profile / "runtime.json").exists(), "runtime metadata remained after stop")
            runtime_removed = True
        lock_free = lock_is_free(self.profile)
        lifecycle_peak = monitored["peak"]
        no_orphan = self.host is None or exact_host_processes(self.host).issubset(self.preexisting_hosts)
        profile_size = directory_size(self.profile)
        run(["systemctl", "--user", "stop", self.unit], check=False, timeout=20)
        run(["systemctl", "--user", "reset-failed", self.unit], check=False, timeout=20)
        poll(5.0, lambda: not self.group.exists(), "transient cgroup leaf could not be removed")
        shutil.rmtree(self.profile)
        self.stopped = True
        cleanup = {
            "runtime_metadata_removed": runtime_removed,
            "profile_lock_released": lock_free,
            "empty_cgroup": not self.group.exists(),
            "cgroup_removed": not self.group.exists(),
            "no_host_orphan": no_orphan,
            "profile_removed": not self.profile.exists(),
            "graceful_exit": graceful,
        }
        if not all(cleanup.values()):
            fail(f"{self.label}: cleanup proof failed")
        return lifecycle_peak, {"profile_bytes": profile_size, "cleanup": cleanup}

    def force_cleanup(self) -> None:
        if not self.started or self.stopped:
            return
        run(["systemctl", "--user", "kill", self.unit, "--signal=SIGKILL"], check=False, timeout=10)
        run(["systemctl", "--user", "stop", self.unit], check=False, timeout=10)
        run(["systemctl", "--user", "reset-failed", self.unit], check=False, timeout=10)
        shutil.rmtree(self.profile, ignore_errors=True)


def operation(label: str) -> str:
    return str(uuid.uuid5(uuid.UUID("50b6467f-21ec-5df0-b6ba-5d4011ca644c"), label))


def timed(latencies: dict[str, list[float]], label: str, call: Callable[[], Any]) -> Any:
    started = time.perf_counter()
    value = call()
    latencies.setdefault(label, []).append((time.perf_counter() - started) * 1000.0)
    return value


def contribution_fence(values: list[dict[str, Any]]) -> dict[str, Any]:
    if not values:
        fail("plugin contribution fence was unavailable")
    value = values[0]
    fence = {key: value.get(key) for key in ("package_generation", "activation_epoch", "host_session_id")}
    if not isinstance(fence["package_generation"], int) or not isinstance(fence["activation_epoch"], int):
        fail("plugin contribution fence was malformed")
    uuid.UUID(str(fence["host_session_id"]))
    return fence


def wait_contributions(client: CgroupServer, plugin_id: str, expected: set[tuple[str, str]]) -> list[dict[str, Any]]:
    holder: dict[str, Any] = {}

    def ready() -> bool:
        value, status, _ = client.request("GET", "/api/v1/plugins/contributions")
        if status != 200 or not isinstance(value, dict):
            return False
        selected = [item for item in value.get("contributions", []) if item.get("plugin_id") == plugin_id]
        if {(item.get("kind"), item.get("local_id")) for item in selected} != expected:
            return False
        fences = [contribution_fence([item]) for item in selected]
        if any(fence != fences[0] for fence in fences):
            fail(f"{plugin_id}: contributions did not share one exact fence")
        installed, installed_status, _ = client.request("GET", f"/api/v1/plugins/{plugin_id}")
        if installed_status != 200 or not isinstance(installed, dict):
            return False
        if (
            fences[0]["package_generation"] != installed.get("package_generation")
            or fences[0]["activation_epoch"] != installed.get("activation_epoch")
        ):
            return False
        holder["values"] = selected
        return True

    poll(CALL_TIMEOUT, ready, f"{plugin_id}: contributions did not become active with current authority")
    return holder["values"]


def sync_state(client: CgroupServer) -> dict[str, Any]:
    value, _ = client.expect("GET", "/api/v1/sync-state", 200)
    if not isinstance(value, dict) or not isinstance(value.get("revision"), int) or not isinstance(value.get("event_epoch"), str):
        fail("sync-state response was malformed")
    return value


def task_id_from_mutation(value: Any) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("event"), dict):
        fail("task mutation omitted event authority")
    event = value["event"]
    snapshot = event.get("snapshot")
    if isinstance(snapshot, dict) and isinstance(snapshot.get("task"), dict):
        task_id = snapshot["task"].get("id")
        if isinstance(task_id, str):
            return task_id
    primary = event.get("primary")
    if isinstance(primary, dict) and isinstance(primary.get("id"), str):
        return primary["id"]
    fail("task mutation omitted primary identity")


def create_task(client: CgroupServer, label: str, title: str) -> tuple[str, bytes, Any]:
    key = operation(label)
    body = {"title": title}
    value, raw = client.expect("POST", "/api/v1/tasks", 201, body=body, operation_id=key)
    return task_id_from_mutation(value), raw, (body, key, value)


def affected_task_ids(event: dict[str, Any]) -> list[str]:
    affected = event.get("affected")
    if isinstance(affected, dict) and isinstance(affected.get("task_ids"), list):
        return [value for value in affected["task_ids"] if isinstance(value, str)]
    primary = event.get("primary")
    if isinstance(primary, dict) and isinstance(primary.get("id"), str):
        return [primary["id"]]
    return []


def package_size(plugin_id: str) -> int:
    digest = dict(REGISTRY)[plugin_id]
    return (ROOT / f"plugins/registry/sha256/{digest}.jbp").stat().st_size


def response_identity(raw: bytes) -> dict[str, Any]:
    return {"sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}


def corpus_digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def default_workload_digest(workload: dict[str, Any]) -> str:
    counts = {
        "task_count": workload["task_count"],
        "mutation_cycles": workload["mutation_cycles"],
        "static_reads": workload["static_reads"],
        "list_reads": workload["list_reads"],
        "latency_counts": {key: value["count"] for key, value in workload["latencies"].items()},
    }
    return corpus_digest(counts)


def default_side(
    bench: Any,
    server: Path,
    web_dir: Path,
    root: Path,
    label: str,
    quick: bool,
    authoritative: bool,
) -> dict[str, Any]:
    token = hashlib.sha256(f"{PROTOCOL}:{label}".encode()).hexdigest() + "phase7w5"
    client = CgroupServer(
        server, None, web_dir, root, label, token=token,
        require_reclaim=authoritative,
    )
    try:
        startup = client.start()
        observations = [client.observation("idle", server_count=1, host_count=0)]
        config = bench.protocol_config(quick)
        workload = bench.run_workload(
            client.base_url,
            client.address,
            client.base_url,
            client.token,
            config["task_count"],
            config["mutation_cycles"],
            config["static_reads"],
            config["list_reads"],
        )
        observations.append(client.observation("warm", server_count=1, host_count=0))
        lifecycle_peak, tail = client.stop()
        return {
            "startup_to_health_ms": startup,
            "observations": observations,
            "lifecycle_peak_bytes": lifecycle_peak,
            "workload": workload,
            "workload_digest": default_workload_digest(workload),
            "profile_bytes": tail["profile_bytes"],
            "cleanup": tail["cleanup"],
        }
    finally:
        client.force_cleanup()


def pomodoro_round_transition(number: int) -> tuple[str, str, str, str]:
    metrics = {"work": "25:00", "break": "05:00", "long_break": "15:00"}
    if number % 2 == 0:
        reset_phase = "work"
        work_session = number // 2 + 1
        post_action_phase = "long_break" if work_session % 4 == 0 else "break"
    else:
        work_session = (number + 1) // 2
        reset_phase = "long_break" if work_session % 4 == 0 else "break"
        post_action_phase = "work"
    return (
        reset_phase,
        metrics[reset_phase],
        post_action_phase,
        metrics[post_action_phase],
    )


def invoke(client: CgroupServer, method: str, path: str, body: Any, label: str) -> tuple[Any, bytes]:
    return client.expect(method, path, 200, body=body, operation_id=operation(label))


def install_grant_enable(client: CgroupServer, dogfood: Any, plugin_id: str, label: str) -> dict[str, Any]:
    digest = dict(REGISTRY)[plugin_id]
    plugin = dogfood.install_registry(client, plugin_id, digest, label)
    dogfood.grant_exact(client, plugin, label)
    return dogfood.enable(client, plugin_id, label)


def rust_sample(
    dogfood: Any, server: Path, host: Path, web: Path, root: Path,
    index: int, quick: bool, authoritative: bool,
) -> dict[str, Any]:
    rounds = 5 if quick else 100
    client = CgroupServer(
        server, host, web, root, f"rust-{index}",
        require_reclaim=authoritative,
    )
    observations: list[dict[str, Any]] = []
    latencies: dict[str, list[float]] = {}
    try:
        startup = client.start()
        dogfood.trust_bundled_publisher(client)
        observations.append(client.observation("dormant", server_count=1, host_count=0))
        pomodoro_label = f"rust:{index}:pomodoro"
        pomodoro = timed(
            latencies,
            "install_verify",
            lambda: dogfood.install_registry(client, "pomodoro", dict(REGISTRY)["pomodoro"], pomodoro_label),
        )
        timed(latencies, "grant", lambda: dogfood.grant_exact(client, pomodoro, pomodoro_label))
        pomodoro = timed(
            latencies,
            "enable_compile",
            lambda: dogfood.enable(client, "pomodoro", pomodoro_label),
        )
        contributions = wait_contributions(
            client,
            "pomodoro",
            {("command", value) for value in ("pause", "reset", "skip", "start")}
            | {("status", "status"), ("view", "timer")},
        )
        fence = contribution_fence(contributions)
        settings = {
            "break-minutes": 5,
            "long-break-minutes": 15,
            "sessions-before-long-break": 4,
            "work-minutes": 25,
        }
        for key, value in settings.items():
            pomodoro = dogfood.installed(client, "pomodoro")
            timed(
                latencies,
                "settings_write",
                lambda key=key, value=value, generation=pomodoro["package_generation"]: client.expect(
                    "PUT",
                    f"/api/v1/plugins/pomodoro/settings/{key}",
                    200,
                    body={"package_generation": generation, "value": value},
                    operation_id=operation(f"rust-{index}:setting:{key}"),
                ),
            )
            pomodoro = dogfood.installed(client, "pomodoro")
            contributions = wait_contributions(
                client,
                "pomodoro",
                {("command", value) for value in ("pause", "reset", "skip", "start")}
                | {("status", "status"), ("view", "timer")},
            )
            fence = contribution_fence(contributions)
            if (
                fence["package_generation"] != pomodoro.get("package_generation")
                or fence["activation_epoch"] != pomodoro.get("activation_epoch")
            ):
                fail("Pomodoro settings mutation did not publish refreshed exact authority")
        observations.append(client.observation("pomodoro-first", server_count=1, host_count=1))
        units = []
        for number in range(rounds):
            prefix = f"rust-{index}:pomodoro:{number:03d}"
            settings_value, settings_raw = timed(
                latencies,
                "settings_read",
                lambda: client.expect("GET", "/api/v1/plugins/pomodoro/settings", 200),
            )
            settings_readback = {
                item.get("key"): item.get("value")
                for item in settings_value.get("settings", [])
                if isinstance(item, dict)
            }
            if settings_readback != settings:
                fail("Pomodoro benchmark settings readback drifted")
            _, command_raw = timed(
                latencies,
                "command",
                lambda: invoke(
                    client, "POST", "/api/v1/plugins/pomodoro/commands/reset",
                    {**fence, "values": []}, prefix + ":command"
                ),
            )
            reset_view, reset_raw = timed(
                latencies,
                "view_render",
                lambda: client.expect(
                    "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fence
                ),
            )
            reset_phase, expected_reset_metric, post_action_phase, expected_post_metric = (
                pomodoro_round_transition(number)
            )
            reset_metric = dogfood.surface_metric(reset_view, "timer-value").get("value")
            if reset_metric != expected_reset_metric:
                fail(
                    "Pomodoro reset KV readback did not match exact phase settings; "
                    f"expected {reset_phase}={expected_reset_metric!r}, observed {reset_metric!r}"
                )
            _, action_raw = timed(
                latencies,
                "action",
                lambda: invoke(
                    client, "POST", "/api/v1/plugins/pomodoro/surfaces/timer/actions/skip",
                    {**fence, "values": []}, prefix + ":action"
                ),
            )
            view, view_raw = timed(
                latencies,
                "view_render",
                lambda: client.expect(
                    "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fence
                ),
            )
            status, status_raw = timed(
                latencies,
                "status_render",
                lambda: client.expect(
                    "POST", "/api/v1/plugins/pomodoro/surfaces/status/render", 200, body=fence
                ),
            )
            post_action_metric = dogfood.surface_metric(view, "timer-value").get("value")
            status_tone = dogfood.surface_metric(status, "status-value").get("tone")
            if post_action_metric != expected_post_metric or status_tone != "neutral":
                fail(
                    "Pomodoro action KV transition/readback output was not exact; "
                    f"expected {post_action_phase}={expected_post_metric!r}/neutral, "
                    f"observed {post_action_metric!r}/{status_tone!r}"
                )
            units.append(
                {
                    "number": number,
                    "settings_values": settings_readback,
                    "settings_response": response_identity(settings_raw),
                    "command_operation_id": operation(prefix + ":command"),
                    "command_response": response_identity(command_raw),
                    "reset_phase": reset_phase,
                    "reset_metric": reset_metric,
                    "reset_render_response": response_identity(reset_raw),
                    "action_operation_id": operation(prefix + ":action"),
                    "action_response": response_identity(action_raw),
                    "post_action_phase": post_action_phase,
                    "post_action_metric": post_action_metric,
                    "view_render_response": response_identity(view_raw),
                    "status_tone": status_tone,
                    "status_render_response": response_identity(status_raw),
                }
            )
            if number in {0, rounds - 1}:
                observations.append(client.observation(f"pomodoro-{number:03d}", server_count=1, host_count=1))
        timed(latencies, "disable", lambda: dogfood.disable(client, "pomodoro", f"rust-{index}:pomodoro"))
        stale, stale_status, _ = client.request(
            "POST",
            "/api/v1/plugins/pomodoro/commands/reset",
            body={**fence, "values": []},
            operation_id=operation(f"rust-{index}:pomodoro:stale"),
        )
        stale_rejected = stale_status == 409 and isinstance(stale, dict)
        if not stale_rejected:
            fail("disabled Pomodoro stale fence was not rejected")
        client.wait_host_exit()
        observations.append(client.observation("between-runtimes", server_count=1, host_count=0))

        timed(
            latencies,
            "install_verify",
            lambda: install_grant_enable(client, dogfood, "automation", f"rust:{index}:automation"),
        )
        observations.append(client.observation("automation-first", server_count=1, host_count=1))
        before = sync_state(client)
        task_ids: list[str] = []
        source_units: list[dict[str, Any]] = []
        for number in range(rounds):
            prefix = f"rust-{index}:automation:{number:03d}"
            task_id, raw, replay_material = timed(
                latencies,
                "automation_event",
                lambda prefix=prefix, number=number: create_task(
                    client, prefix, f"Phase 7 automation {number:03d}"
                ),
            )
            body, key, value = replay_material
            replay, replay_raw = client.expect(
                "POST", "/api/v1/tasks", 201, body=body, operation_id=key
            )
            first_identity = response_identity(raw)
            replay_identity = response_identity(replay_raw)
            if replay != value or replay_identity != first_identity:
                fail("automation source operation replay was not exact")
            task_ids.append(task_id)
            source_units.append(
                {
                    "number": number,
                    "task_id": task_id,
                    "source_operation_id": key,
                    "source_response": first_identity,
                    "replay_response": replay_identity,
                }
            )
        dogfood.wait_task_status(
            client, task_ids, "completed", CALL_TIMEOUT, label="Rust automation benchmark"
        )
        after = sync_state(client)
        events = client.sse_through(before["event_epoch"], before["revision"], after["revision"])
        created = {task_id: 0 for task_id in task_ids}
        completed = {task_id: 0 for task_id in task_ids}
        for event in events:
            targets = set(affected_task_ids(event)).intersection(task_ids)
            counter = created if event.get("event_type") == "task.created" else completed if event.get("event_type") == "task.completed" else None
            if counter is not None:
                for task_id in targets:
                    counter[task_id] += 1
        duplicate_effects = sum(max(0, value - 1) for value in completed.values())
        if set(created.values()) != {1} or set(completed.values()) != {1} or duplicate_effects:
            fail("automation corpus had missing or duplicate event/effect authority")
        event_by_task: dict[str, dict[str, int]] = {task_id: {} for task_id in task_ids}
        for event in events:
            for task_id in set(affected_task_ids(event)).intersection(task_ids):
                if event.get("event_type") == "task.created":
                    event_by_task[task_id]["source_revision"] = event["revision"]
                elif event.get("event_type") == "task.completed":
                    event_by_task[task_id]["effect_revision"] = event["revision"]
        automation_units = []
        for source in source_units:
            progress = event_by_task[source["task_id"]]
            effect_task = dogfood.task(client, source["task_id"])
            if (
                set(progress) != {"source_revision", "effect_revision"}
                or progress["source_revision"] >= progress["effect_revision"]
                or effect_task.get("status") != "completed"
                or effect_task.get("revision") != progress["effect_revision"]
            ):
                fail("automation API-observable cursor/effect progression was not exact")
            automation_units.append(
                {
                    **source,
                    **progress,
                    "effect_task_revision": effect_task["revision"],
                    "effect_status": effect_task["status"],
                    "cursor_observation": "api_observable_no_duplicate_effect",
                }
            )
        observations.append(client.observation("automation-warm", server_count=1, host_count=1))
        timed(latencies, "disable", lambda: dogfood.disable(client, "automation", f"rust-{index}:automation"))
        client.wait_host_exit()
        observations.append(client.observation("all-disabled", server_count=1, host_count=0))
        lifecycle_peak, tail = client.stop()
        corpus = {
            "pomodoro_rounds": units,
            "automation_units": automation_units,
            "stale_fence_rejected": stale_rejected,
            "duplicate_effects": duplicate_effects,
            "simultaneous_loaded_runtimes": False,
        }
        return {
            "sample_index": index,
            "startup_to_health_ms": startup,
            "observations": observations,
            "lifecycle_peak_bytes": lifecycle_peak,
            "latencies_ms": latencies,
            "corpus": corpus,
            "corpus_digest": corpus_digest(corpus),
            "profile_bytes": tail["profile_bytes"],
            "package_bytes": package_size("pomodoro") + package_size("automation"),
            "cleanup": tail["cleanup"],
        }
    finally:
        client.force_cleanup()


def typescript_sample(
    dogfood: Any, server: Path, host: Path, web: Path, root: Path,
    index: int, quick: bool, authoritative: bool,
) -> dict[str, Any]:
    count = 10 if quick else 100
    client = CgroupServer(
        server, host, web, root, f"typescript-{index}",
        require_reclaim=authoritative,
    )
    observations: list[dict[str, Any]] = []
    latencies: dict[str, list[float]] = {}
    try:
        startup = client.start()
        dogfood.trust_bundled_publisher(client)
        observations.append(client.observation("dormant", server_count=1, host_count=0))
        task_ids = []
        task_units = []
        for number in range(count):
            task_id, create_raw, create_material = timed(
                latencies,
                "task_create",
                lambda number=number: create_task(
                    client,
                    f"typescript-{index}:task:{number:03d}",
                    f"Phase 7 TypeScript bulk {number:03d}",
                ),
            )
            initial = dogfood.task(client, task_id)
            task_ids.append(task_id)
            task_units.append(
                {
                    "number": number,
                    "task_id": task_id,
                    "create_operation_id": create_material[1],
                    "create_response": response_identity(create_raw),
                    "initial_revision": initial["revision"],
                }
            )
        plugin = timed(
            latencies,
            "install_verify",
            lambda: dogfood.install_registry(
                client,
                "import-typescript",
                dict(REGISTRY)["import-typescript"],
                f"typescript:{index}",
            ),
        )
        timed(latencies, "grant", lambda: dogfood.grant_exact(client, plugin, f"typescript-{index}"))
        timed(latencies, "enable_compile", lambda: dogfood.enable(client, "import-typescript", f"typescript-{index}:first"))
        values = wait_contributions(client, "import-typescript", {("command", "bulk-complete")})
        fence = contribution_fence(values)
        observations.append(client.observation("typescript-first", server_count=1, host_count=1))
        before = sync_state(client)
        body = {**fence, "values": [{"name": "task-ids", "value": {"tag": "task-id-list", "val": task_ids}}]}
        command_operation_id = operation(f"typescript-{index}:bulk")
        result, raw = timed(
            latencies,
            "bulk_command",
            lambda: client.expect(
                "POST",
                "/api/v1/plugins/import-typescript/commands/bulk-complete",
                200,
                body=body,
                operation_id=command_operation_id,
            ),
        )
        dogfood.wait_task_status(
            client, task_ids, "completed", CALL_TIMEOUT, label="TypeScript benchmark"
        )
        revisions = {task_id: dogfood.task(client, task_id)["revision"] for task_id in task_ids}
        replay, replay_raw = client.expect(
            "POST",
            "/api/v1/plugins/import-typescript/commands/bulk-complete",
            200,
            body=body,
            operation_id=command_operation_id,
        )
        replay_ok = replay == result and replay_raw == raw
        if not replay_ok or revisions != {task_id: dogfood.task(client, task_id)["revision"] for task_id in task_ids}:
            fail("TypeScript command replay produced a duplicate effect")
        after = sync_state(client)
        events = client.sse_through(before["event_epoch"], before["revision"], after["revision"])
        completed_counts = {task_id: 0 for task_id in task_ids}
        for event in events:
            if event.get("event_type") in {"task.completed", "task.bulk"}:
                for task_id in set(affected_task_ids(event)).intersection(task_ids):
                    completed_counts[task_id] += 1
        event_ok = set(completed_counts.values()) == {1}
        event_revisions: dict[str, int] = {}
        for event in events:
            if event.get("event_type") in {"task.completed", "task.bulk"}:
                for task_id in set(affected_task_ids(event)).intersection(task_ids):
                    event_revisions[task_id] = event["revision"]
        if not event_ok or set(event_revisions) != set(task_ids):
            fail("TypeScript bulk command did not complete every task exactly once")
        for unit in task_units:
            completed_task = dogfood.task(client, unit["task_id"])
            unit["completed_revision"] = completed_task["revision"]
            unit["event_revision"] = event_revisions[unit["task_id"]]
            if (
                completed_task.get("status") != "completed"
                or unit["completed_revision"] != unit["event_revision"]
                or unit["completed_revision"] <= unit["initial_revision"]
            ):
                fail("TypeScript exact task/event revision authority drifted")
        observations.append(client.observation("typescript-warm", server_count=1, host_count=1))
        timed(latencies, "disable", lambda: dogfood.disable(client, "import-typescript", f"typescript-{index}:first"))
        client.wait_host_exit()
        timed(latencies, "enable_compile", lambda: dogfood.enable(client, "import-typescript", f"typescript-{index}:second"))
        wait_contributions(client, "import-typescript", {("command", "bulk-complete")})
        stale, stale_status, _ = client.request(
            "POST",
            "/api/v1/plugins/import-typescript/commands/bulk-complete",
            body=body,
            operation_id=operation(f"typescript-{index}:stale"),
        )
        stale_ok = stale_status == 409 and isinstance(stale, dict)
        if not stale_ok:
            fail("TypeScript stale contribution fence was not rejected")
        dogfood.disable(client, "import-typescript", f"typescript-{index}:second")
        client.wait_host_exit()
        observations.append(client.observation("all-disabled", server_count=1, host_count=0))
        lifecycle_peak, tail = client.stop()
        selected_events = [
            {
                "revision": event["revision"],
                "event_type": event.get("event_type"),
                "task_ids": sorted(set(affected_task_ids(event)).intersection(task_ids)),
            }
            for event in events
            if set(affected_task_ids(event)).intersection(task_ids)
        ]
        corpus = {
            "task_units": task_units,
            "affected_task_count": len(task_ids),
            "command_operation_id": command_operation_id,
            "command_response": response_identity(raw),
            "replay_response": response_identity(replay_raw),
            "revision_before": before["revision"],
            "revision_after": after["revision"],
            "event_corpus_sha256": corpus_digest(selected_events),
            "stale_error_code": stale.get("error", {}).get("code"),
            "event_claim": False,
            "command_invocations": 1,
        }
        return {
            "sample_index": index,
            "startup_to_health_ms": startup,
            "observations": observations,
            "lifecycle_peak_bytes": lifecycle_peak,
            "latencies_ms": latencies,
            "corpus": corpus,
            "corpus_digest": corpus_digest(corpus),
            "profile_bytes": tail["profile_bytes"],
            "package_bytes": package_size("import-typescript"),
            "cleanup": tail["cleanup"],
        }
    finally:
        client.force_cleanup()


def percentile(values: list[float], percent: float) -> float:
    if not values:
        fail("cannot aggregate an empty latency series")
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return ordered[0]
    rank = percent / 100.0 * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] * (1.0 - (rank - low)) + ordered[high] * (rank - low)


def latency_aggregates(samples: list[dict[str, Any]]) -> dict[str, Any]:
    classes = sorted({name for sample in samples for name in sample.get("latencies_ms", {})})
    result: dict[str, Any] = {}
    for name in classes:
        values = [float(value) for sample in samples for value in sample["latencies_ms"].get(name, [])]
        result[name] = {
            "count": len(values),
            "p50_ms": percentile(values, 50),
            "p95_ms": percentile(values, 95),
            "min_ms": min(values),
            "max_ms": max(values),
        }
    return result


def default_aggregates(samples: list[dict[str, Any]]) -> dict[str, Any]:
    base_warm = [next(obs["post_reclaim_memory_current_bytes"] for obs in pair["base"]["observations"] if obs["label"] == "warm") for pair in samples]
    candidate_warm = [next(obs["post_reclaim_memory_current_bytes"] for obs in pair["candidate"]["observations"] if obs["label"] == "warm") for pair in samples]
    base_median = statistics.median(base_warm)
    candidate_median = statistics.median(candidate_warm)
    allowed = max(DELTA_FLOOR, base_median * DELTA_PERCENT)
    return {
        "base_median_warm_bytes": base_median,
        "candidate_median_warm_bytes": candidate_median,
        "candidate_max_warm_bytes": max(candidate_warm),
        "candidate_max_peak_bytes": max(pair["candidate"]["lifecycle_peak_bytes"] for pair in samples),
        "median_growth_bytes": candidate_median - base_median,
        "allowed_growth_bytes": allowed,
        "latencies": {
            side: latency_aggregates(
                [
                    {"latencies_ms": {name: metric["values_ms"] for name, metric in pair[side]["workload"]["latencies"].items()}}
                    for pair in samples
                ]
            )
            for side in ("base", "candidate")
        },
    }


def plugin_aggregates(samples: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "max_current_bytes": max(
            obs["post_reclaim_memory_current_bytes"]
            for sample in samples for obs in sample["observations"]
        ),
        "max_peak_bytes": max(sample["lifecycle_peak_bytes"] for sample in samples),
        "latencies": latency_aggregates(samples),
    }


def checker_identity() -> dict[str, Any]:
    return {"version": CHECKER_VERSION, "sha256": sha256_file(SCRIPT), "document_payload_sha256": "0" * 64}


def seal(report: dict[str, Any]) -> None:
    report["checker"]["document_payload_sha256"] = "0" * 64
    report["checker"]["document_payload_sha256"] = hashlib.sha256(canonical(report)).hexdigest()


def report_budget(report: dict[str, Any]) -> bool:
    kind = report["report_kind"]
    aggregate = report["aggregates"]
    if kind == "default":
        return (
            aggregate["candidate_max_warm_bytes"] <= DEFAULT_CURRENT_BUDGET
            and aggregate["candidate_max_peak_bytes"] <= DEFAULT_PEAK_BUDGET
            and aggregate["median_growth_bytes"] <= aggregate["allowed_growth_bytes"]
        )
    return aggregate["max_current_bytes"] <= report["budgets"]["current_bytes"] and aggregate["max_peak_bytes"] <= report["budgets"]["peak_bytes"]


def make_report(
    kind: str,
    authority: str,
    quick: bool,
    started: str,
    candidate: dict[str, Any],
    common: dict[str, Any],
    base: Any,
    workload: dict[str, Any],
    samples: list[dict[str, Any]],
) -> dict[str, Any]:
    aggregates = default_aggregates(samples) if kind == "default" else plugin_aggregates(samples)
    budgets = (
        {
            "current_bytes": DEFAULT_CURRENT_BUDGET,
            "peak_bytes": DEFAULT_PEAK_BUDGET,
            "growth_percent": DELTA_PERCENT,
            "growth_floor_bytes": DELTA_FLOOR,
        }
        if kind == "default"
        else {
            "current_bytes": RUST_CURRENT_BUDGET if kind == "rust" else TYPESCRIPT_CURRENT_BUDGET,
            "peak_bytes": RUST_PEAK_BUDGET if kind == "rust" else TYPESCRIPT_PEAK_BUDGET,
        }
    )
    report = {
        "schema_version": SCHEMA_VERSION,
        "protocol": PROTOCOL,
        "report_kind": kind,
        "authority": authority,
        "quick": quick,
        "started_at": started,
        "finished_at": utc_now(),
        "candidate": candidate,
        "common": common,
        "base": base,
        "workload": workload,
        "samples": samples,
        "aggregates": aggregates,
        "budgets": budgets,
        "budget_passed": False,
        "checker": checker_identity(),
    }
    report["budget_passed"] = report_budget(report)
    seal(report)
    return report


def build_base(
    output_dir: Path,
) -> tuple[Path, Path, tempfile.TemporaryDirectory[str], dict[str, Any]]:
    temporary = tempfile.TemporaryDirectory(prefix="junban-p7w5-base-", dir=output_dir)
    root = Path(temporary.name)
    os.chmod(root, 0o700)
    worktree = root / "source"
    try:
        run(["git", "worktree", "add", "--detach", str(worktree), BASE_COMMIT], timeout=120)
        commit = git_text("rev-parse", "HEAD", cwd=worktree)
        tree = git_text("rev-parse", "HEAD^{tree}", cwd=worktree)
        clean_before = not bool(git_text("status", "--porcelain", cwd=worktree))
        forbidden = [
            worktree / "plugins",
            worktree / "crates/junban-plugin-sdk",
            worktree / "crates/junban-plugin-host",
        ]
        if commit != BASE_COMMIT or tree != BASE_TREE or not clean_before or any(
            path.exists() for path in forbidden
        ):
            fail("isolated Phase 6 base source was not the exact clean plugin-free authority")
        run(["pnpm", "install", "--frozen-lockfile"], cwd=worktree, timeout=900)
        run(["pnpm", "build"], cwd=worktree, timeout=900)
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(root / "target")
        run(["cargo", "build", "--locked", "--release", "-p", "junban-server"], cwd=worktree, env=environment, timeout=1800)
        server = root / "target/release/junban-server"
        clean_after = not bool(git_text("status", "--porcelain", cwd=worktree))
        if not clean_after or git_text("rev-parse", "HEAD", cwd=worktree) != BASE_COMMIT:
            fail("isolated Phase 6 base source changed during build")
        proof = {
            "mode": "isolated_detached_worktree_build",
            "commit": commit,
            "tree": tree,
            "clean_before": clean_before,
            "clean_after": clean_after,
            "plugin_paths_absent": True,
        }
        return (
            resolve_regular(server, "built Phase 6 base server", executable=True),
            worktree / "dist",
            temporary,
            proof,
        )
    except Exception:
        run(["git", "worktree", "remove", "--force", str(worktree)], check=False, timeout=60)
        temporary.cleanup()
        raise


def remove_base(temporary: tempfile.TemporaryDirectory[str] | None) -> None:
    if temporary is None:
        return
    worktree = Path(temporary.name) / "source"
    run(["git", "worktree", "remove", "--force", str(worktree)], check=False, timeout=60)
    temporary.cleanup()


def validate_output_dir(path: Path) -> Path:
    resolved_parent = path.expanduser().parent.resolve(strict=True)
    output = resolved_parent / path.name
    if within(output, ROOT.resolve()):
        fail("performance reports must be written outside the checkout")
    output.mkdir(mode=0o700, exist_ok=True)
    if output.is_symlink() or not output.is_dir():
        fail("output directory is unsafe")
    for name in REPORT_NAMES.values():
        if (output / name).exists():
            fail(f"output report already exists: {name}")
    return output.resolve(strict=True)


def write_reports(output: Path, reports: dict[str, dict[str, Any]]) -> None:
    for kind, name in REPORT_NAMES.items():
        path = output / name
        data = json.dumps(reports[kind], sort_keys=True, indent=2, ensure_ascii=False) + "\n"
        assert_public_safe(reports[kind])
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())


def common_record(
    artifacts: dict[str, Any], platform: dict[str, Any], host: dict[str, Any],
    toolchain: dict[str, Any], authority: str, build_attestation: dict[str, Any], *, quick: bool,
) -> dict[str, Any]:
    return {
        "artifacts": artifacts,
        "artifact_check_passed": True,
        "build_attestation": build_attestation,
        "platform": platform,
        "host": host,
        "toolchain": toolchain,
        "command_template": (
            f"{SCRIPT.name} --collect "
            f"--{'authoritative' if authority == 'authoritative' else 'non-authoritative'}"
            f"{' --quick' if quick else ''} --output-dir <external-directory>"
        ),
    }


def collect(args: argparse.Namespace) -> int:
    require_cgroup_tools()
    output = validate_output_dir(args.output_dir)
    if args.authoritative:
        if not args.build_base or args.base_server is not None or args.base_web_dir is not None:
            fail("authoritative collection requires --build-base and rejects supplied base artifacts")
        build_attestation = authoritative_rebuild()
        start = candidate_snapshot()
    else:
        if args.base_server is not None or args.base_web_dir is not None:
            fail("supplied base artifacts are rejected; preliminary collection also builds exact BASE_COMMIT")
        if not args.build_base:
            fail("collection requires --build-base for the exact isolated Phase 6 authority")
        build_attestation = {"mode": "supplied_preliminary_outputs"}
        start = candidate_snapshot()
    server = resolve_regular(args.server, "candidate server", executable=True)
    host = resolve_regular(args.host, "candidate adjacent plugin host", executable=True)
    tool = resolve_regular(args.artifact_tool, "artifact tool", executable=True)
    web = args.web_dir.expanduser().resolve(strict=True)
    if host != server.parent / "junban-plugin-host":
        fail("candidate plugin host must be the exact adjacent sibling of junban-server")
    if args.authoritative:
        expected = (ROOT / "target/release").resolve(strict=True)
        expected_web = (ROOT / "dist").resolve(strict=True)
        if (
            server != expected / "junban-server"
            or host != expected / "junban-plugin-host"
            or tool != expected / "junban-plugin-artifact"
            or web != expected_web
        ):
            fail("authoritative collection requires exact target/release binaries and production dist")
    if args.quick and args.authoritative:
        fail("quick collection can never be authoritative")
    if args.authoritative and not start["clean"]:
        fail("authoritative collection requires a clean candidate at start")
    host_helper = load_module(HOST_CHECK_PATH, "junban_phase7_host_check")
    public_artifact_check(tool)
    artifacts = artifact_identities(server, host, tool, web)
    if any(marker in server.read_bytes() for marker in WASMTIME_MARKERS):
        fail("ordinary candidate server binary contains a Wasmtime marker")
    platform = platform_record()
    if not platform["memory_controller"]:
        fail("cgroup-v2 memory controller is unavailable")
    toolchain = toolchain_record()
    authority = "authoritative" if args.authoritative else "preliminary"
    started = utc_now()
    sample_count = QUICK_SAMPLES if args.quick else SAMPLES
    bench = load_module(BENCH_PATH, "junban_hosted_bench")
    dogfood = load_module(DOGFOOD_PATH, "junban_plugin_dogfood")

    base_temp: tempfile.TemporaryDirectory[str] | None = None
    base_proof: dict[str, Any]
    if args.build_base:
        if args.base_server is not None or args.base_web_dir is not None:
            fail("--build-base cannot be combined with explicit base artifacts")
        base_server, base_web, base_temp, base_proof = build_base(output)
    else:
        fail("collection requires --build-base for the exact isolated Phase 6 authority")
    if args.base_commit != BASE_COMMIT or git_text("cat-file", "-t", args.base_commit) != "commit":
        fail("Phase 6 base commit must be the exact frozen docs-close authority")
    base_identity = {
        "commit": args.base_commit,
        "tree": BASE_TREE,
        "source": base_proof,
        "server": file_identity(base_server),
        "production_dist": tree_identity(base_web),
        "interleave": "base_then_candidate_per_pair",
    }
    if args.authoritative and (
        base_identity["server"] == artifacts["junban_server"]
        or base_identity["production_dist"] == artifacts["production_dist"]
    ):
        fail("candidate artifacts cannot impersonate the exact Phase 6 base")

    try:
        if args.authoritative:
            host_pre = wait_for_idle_host(lambda: host_snapshot(host_helper))
        else:
            host_pre = host_snapshot(host_helper)
    except Exception:
        remove_base(base_temp)
        raise
    common = common_record(
        artifacts, platform, {"pre": host_pre, "post": None}, toolchain, authority,
        build_attestation, quick=args.quick,
    )

    work = tempfile.TemporaryDirectory(prefix="junban-p7w5-measure-")
    private_root = Path(work.name)
    os.chmod(private_root, 0o700)
    default_samples: list[dict[str, Any]] = []
    rust_samples: list[dict[str, Any]] = []
    typescript_samples: list[dict[str, Any]] = []
    try:
        for index in range(sample_count):
            print(f"Phase 7 Wave 5 default pair {index + 1}/{sample_count}", file=sys.stderr)
            default_samples.append(
                {
                    "pair_index": index,
                    "base": default_side(
                        bench, base_server, base_web, private_root,
                        f"base-{index}", args.quick, args.authoritative,
                    ),
                    "candidate": default_side(
                        bench, server, web, private_root,
                        f"candidate-{index}", args.quick, args.authoritative,
                    ),
                }
            )
        for index in range(sample_count):
            print(f"Phase 7 Wave 5 Rust sample {index + 1}/{sample_count}", file=sys.stderr)
            rust_samples.append(
                rust_sample(
                    dogfood, server, host, web, private_root,
                    index, args.quick, args.authoritative,
                )
            )
        for index in range(sample_count):
            print(f"Phase 7 Wave 5 TypeScript sample {index + 1}/{sample_count}", file=sys.stderr)
            typescript_samples.append(
                typescript_sample(
                    dogfood, server, host, web, private_root,
                    index, args.quick, args.authoritative,
                )
            )
    finally:
        work.cleanup()
        remove_base(base_temp)

    end = candidate_snapshot()
    candidate = candidate_record(start, end)
    if args.authoritative and (not candidate["clean_at_end"] or not candidate["identity_stable"]):
        fail("authoritative candidate identity did not remain clean and stable")
    if args.authoritative:
        host_post = wait_for_idle_host(lambda: host_snapshot(host_helper))
    else:
        host_post = host_snapshot(host_helper)
    common["host"]["post"] = host_post
    reports = {
        "default": make_report(
            "default",
            authority,
            args.quick,
            started,
            candidate,
            copy.deepcopy(common),
            base_identity,
            {
                "name": "junban-phase1-hosted-server-v1",
                "samples": sample_count,
                "task_count": 10 if args.quick else 100,
                "mutation_cycles": 5 if args.quick else 20,
                "static_reads": 5 if args.quick else 20,
                "list_reads": 6 if args.quick else 21,
                "interleave": "base_then_candidate_per_pair",
            },
            default_samples,
        ),
        "rust": make_report(
            "rust",
            authority,
            args.quick,
            started,
            candidate,
            copy.deepcopy(common),
            None,
            {
                "name": "rust-reference-sequential-v1",
                "samples": sample_count,
                "pomodoro_rounds": 5 if args.quick else 100,
                "automation_units": 5 if args.quick else 100,
                "runtime_scale": 1,
                "order": "pomodoro-disable-host-exit-automation-disable-host-exit",
            },
            rust_samples,
        ),
        "typescript": make_report(
            "typescript",
            authority,
            args.quick,
            started,
            candidate,
            copy.deepcopy(common),
            None,
            {
                "name": "typescript-import-bulk-v1",
                "samples": sample_count,
                "bulk_task_count": 10 if args.quick else 100,
                "runtime_scale": 1,
                "plugin_id": "import-typescript",
                "event_workload": False,
            },
            typescript_samples,
        ),
    }
    write_reports(output, reports)
    check_evidence(output, require_authoritative=args.authoritative)
    print(f"Phase 7 Wave 5 performance reports passed: {output}")
    if args.quick and not args.authoritative:
        return 0
    return 0 if all(report["budget_passed"] for report in reports.values()) else 1


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} must contain exactly {sorted(keys)}")
    return value


def require_bool(value: Any, label: str) -> bool:
    if type(value) is not bool:
        fail(f"{label} must be boolean")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        fail(f"{label} must be an integer >= {minimum}")
    return value


def require_number(value: Any, label: str, minimum: float | None = None) -> float:
    if type(value) not in (int, float) or not math.isfinite(float(value)):
        fail(f"{label} must be a finite number")
    result = float(value)
    if minimum is not None and result < minimum:
        fail(f"{label} must be >= {minimum}")
    return result


def assert_public_safe(value: Any, trail: str = "report") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or FORBIDDEN_KEY_RE.search(key):
                fail(f"{trail} contains forbidden private/secret/process key")
            assert_public_safe(child, f"{trail}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_public_safe(child, f"{trail}[{index}]")
    elif isinstance(value, str):
        if BEARER_RE.search(value) or AUTH_RE.search(value) or TOKEN_RE.search(value) or PRIVATE_PATH_RE.search(value):
            fail(f"{trail} contains secret or private path material")
        if len(value.encode("utf-8")) > 4096:
            fail(f"{trail} contains an unbounded public string")


def validate_identity(value: Any, label: str) -> None:
    identity = exact_keys(value, IDENTITY_KEYS, label)
    if not isinstance(identity["sha256"], str) or not HEX64.fullmatch(identity["sha256"]):
        fail(f"{label}.sha256 is malformed")
    require_int(identity["size_bytes"], f"{label}.size_bytes", 1)


def validate_candidate(value: Any, authority: str) -> None:
    candidate = exact_keys(value, CANDIDATE_KEYS, "candidate")
    for key in ("commit", "tree", "index_tree"):
        if not isinstance(candidate[key], str) or not HEX40.fullmatch(candidate[key]):
            fail(f"candidate.{key} is malformed")
    if not isinstance(candidate["working_state_sha256"], str) or not HEX64.fullmatch(candidate["working_state_sha256"]):
        fail("candidate working-state digest is malformed")
    for key in ("clean_at_start", "clean_at_end", "identity_stable"):
        require_bool(candidate[key], f"candidate.{key}")
    if authority == "authoritative" and not all(candidate[key] for key in ("clean_at_start", "clean_at_end", "identity_stable")):
        fail("authoritative candidate was not clean and stable")


def validate_host(value: Any, authority: str) -> None:
    host = exact_keys(value, {"pre", "post"}, "common.host")
    host_keys = {
        "load1",
        "load5",
        "load15",
        "cpu_count",
        "load1_threshold",
        "load5_threshold",
        "active_confounder_count",
        "swap_io_active",
        "swap_used_bytes",
        "idle",
    }
    for phase in ("pre", "post"):
        item = exact_keys(host[phase], host_keys, f"common.host.{phase}")
        for key in ("load1", "load5", "load15", "load1_threshold", "load5_threshold"):
            require_number(item[key], f"host.{phase}.{key}", 0)
        require_int(item["cpu_count"], f"host.{phase}.cpu_count", 1)
        require_int(item["active_confounder_count"], f"host.{phase}.active_confounder_count")
        require_bool(item["swap_io_active"], f"host.{phase}.swap_io_active")
        if item["swap_used_bytes"] is not None:
            require_int(item["swap_used_bytes"], f"host.{phase}.swap_used_bytes")
        require_bool(item["idle"], f"host.{phase}.idle")
        if authority == "authoritative" and (not item["idle"] or item["swap_io_active"] or item["swap_used_bytes"] not in (None, 0)):
            fail("authoritative report was not collected on an idle zero-swap host")


def validate_common(value: Any, authority: str) -> None:
    common = exact_keys(value, COMMON_KEYS, "common")
    require_bool(common["artifact_check_passed"], "common.artifact_check_passed")
    if not common["artifact_check_passed"]:
        fail("public artifact checker did not pass")
    artifacts = common["artifacts"]
    if not isinstance(artifacts, dict) or len(artifacts) < 20:
        fail("common.artifacts is incomplete")
    required = {
        "junban_server",
        "junban_plugin_host",
        "junban_plugin_artifact",
        "production_dist",
        "artifact_checker",
        "performance_harness",
        "dogfood_harness",
        "cargo_lock",
        "pnpm_lock",
        "rust_toolchain",
        "protocol",
        "registry_index",
        "include_table",
        "package_automation",
        "package_import_typescript",
        "package_pomodoro",
    }
    if not required.issubset(artifacts):
        fail("common.artifacts omitted a candidate/public identity")
    for name, identity in artifacts.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_]+", name):
            fail("artifact identity name is malformed")
        validate_identity(identity, f"artifacts.{name}")
    platform = exact_keys(
        common["platform"],
        {"system", "kernel", "machine", "cpu_count", "memory_total_bytes", "cgroup_version", "memory_controller"},
        "common.platform",
    )
    if platform["system"] != "Linux" or platform["cgroup_version"] != 2 or platform["memory_controller"] is not True:
        fail("report is not Linux cgroup-v2 memory authority")
    require_int(platform["cpu_count"], "platform.cpu_count", 1)
    require_int(platform["memory_total_bytes"], "platform.memory_total_bytes", 1)
    validate_host(common["host"], authority)
    validate_build_attestation(common["build_attestation"], authority)
    toolchain = exact_keys(
        common["toolchain"],
        {"python", "rustc", "cargo", "node", "pnpm", "wasmtime", "jco", "componentize_js"},
        "common.toolchain",
    )
    if toolchain["jco"] != "1.26.1" or toolchain["componentize_js"] != "0.22.0":
        fail("TypeScript authoring tool authority drifted")
    if not isinstance(common["command_template"], str) or "<external-directory>" not in common["command_template"]:
        fail("safe command template is missing")


def validate_measurement(
    value: Any, label: str, expected_server: int, expected_host: int, *, authoritative: bool
) -> None:
    item = exact_keys(value, MEASUREMENT_KEYS, label)
    if not isinstance(item["label"], str) or not item["label"]:
        fail(f"{label}.label is invalid")
    for key in (
        "memory_current_bytes",
        "memory_peak_bytes",
        "memory_swap_current_bytes",
        "memory_swap_peak_bytes",
        "memory_anon_bytes",
        "memory_file_bytes",
        "reclaim_file_bytes",
        "post_reclaim_memory_current_bytes",
        "post_reclaim_file_bytes",
        "server_count",
        "host_count",
        "unexpected_count",
        "node_count",
    ):
        require_int(item[key], f"{label}.{key}")
    if item["memory_peak_bytes"] < max(
        item["memory_current_bytes"], item["post_reclaim_memory_current_bytes"]
    ):
        fail(f"{label} peak is below current")
    if item["memory_swap_current_bytes"] != 0 or item["memory_swap_peak_bytes"] != 0:
        fail(f"{label} used swap")
    if item["reclaim_file_bytes"] != item["memory_file_bytes"]:
        fail(f"{label} did not request exact observed file-byte reclaim")
    if item["reclaim_result"] not in {"not_needed", "written", "eagain"}:
        fail(f"{label} reclaim result is invalid")
    attempts = item["reclaim_attempts"]
    if not isinstance(attempts, list) or len(attempts) > 3:
        fail(f"{label} reclaim attempts are malformed")
    if item["reclaim_file_bytes"] == 0:
        if attempts or item["reclaim_result"] != "not_needed":
            fail(f"{label} performed reclaim without observed file bytes")
    else:
        if not attempts or item["reclaim_result"] == "not_needed":
            fail(f"{label} omitted observed file-byte reclaim")
        previous: dict[str, Any] | None = None
        for index, attempt in enumerate(attempts):
            attempt = exact_keys(
                attempt,
                {
                    "requested_file_bytes",
                    "result",
                    "memory_current_after_bytes",
                    "memory_file_after_bytes",
                },
                f"{label}.reclaim_attempts[{index}]",
            )
            requested = require_int(
                attempt["requested_file_bytes"],
                f"{label}.reclaim_attempts[{index}].requested_file_bytes",
            )
            require_int(
                attempt["memory_current_after_bytes"],
                f"{label}.reclaim_attempts[{index}].memory_current_after_bytes",
            )
            require_int(
                attempt["memory_file_after_bytes"],
                f"{label}.reclaim_attempts[{index}].memory_file_after_bytes",
            )
            if attempt["result"] not in {"written", "eagain"}:
                fail(f"{label} reclaim attempt result is invalid")
            if previous is None:
                if requested != item["reclaim_file_bytes"] or requested <= 0:
                    fail(f"{label} first reclaim did not request exact observed file bytes")
            else:
                retry_ceiling = (
                    4096
                    if previous["requested_file_bytes"] > 4096
                    else previous["requested_file_bytes"] // 2
                )
                expected = min(previous["memory_file_after_bytes"], retry_ceiling)
                if previous["result"] != "eagain" or requested != expected:
                    fail(f"{label} reclaim retry was not bounded by reread file authority")
            if attempt["result"] == "written" and index != len(attempts) - 1:
                fail(f"{label} continued reclaim after a successful write")
            previous = attempt
        if attempts[-1]["result"] != item["reclaim_result"]:
            fail(f"{label} final reclaim result mismatched its raw attempt")
    if authoritative and item["reclaim_file_bytes"] > 0 and item["reclaim_result"] != "written":
        fail(f"{label} authoritative file-only reclaim did not succeed")
    if item["server_count"] != expected_server or item["host_count"] != expected_host:
        fail(f"{label} process counts do not match lifecycle segment")
    if item["unexpected_count"] != 0 or item["node_count"] != 0:
        fail(f"{label} contains unexpected/runtime-Node processes")
    processes = item["processes"]
    if not isinstance(processes, list) or len(processes) != expected_server + expected_host:
        fail(f"{label} process record count mismatched")
    names = []
    for index, process in enumerate(processes):
        process = exact_keys(process, PROCESS_KEYS, f"{label}.processes[{index}]")
        if process["name"] not in {"junban-server", "junban-plugin-host"}:
            fail(f"{label} process name was unexpected")
        require_int(process["rss_bytes"], "process.rss_bytes", 1)
        require_int(process["pss_bytes"], "process.pss_bytes", 1)
        names.append(process["name"])
    if names.count("junban-server") != expected_server or names.count("junban-plugin-host") != expected_host:
        fail(f"{label} exact process composition mismatched")


def validate_cleanup(value: Any, label: str) -> None:
    cleanup = exact_keys(value, CLEANUP_KEYS, label)
    if not all(require_bool(cleanup[key], f"{label}.{key}") for key in CLEANUP_KEYS):
        fail(f"{label} cleanup did not completely pass")


def validate_latencies_raw(value: Any, label: str) -> None:
    if not isinstance(value, dict) or not value:
        fail(f"{label} latency observations are missing")
    for name, series in value.items():
        if not isinstance(name, str) or not isinstance(series, list) or not series:
            fail(f"{label}.{name} is not a raw nonempty latency series")
        for observation in series:
            require_number(observation, f"{label}.{name}", 0)


def validate_latency_aggregates(value: Any, raw_samples: list[dict[str, Any]], label: str) -> None:
    expected = latency_aggregates(raw_samples)
    if value != expected:
        fail(f"{label} latency aggregates do not recompute from raw observations")


def validate_default_side(
    value: Any, label: str, workload: dict[str, Any], *, authoritative: bool
) -> None:
    keys = {
        "startup_to_health_ms",
        "observations",
        "lifecycle_peak_bytes",
        "workload",
        "workload_digest",
        "profile_bytes",
        "cleanup",
    }
    side = exact_keys(value, keys, label)
    require_number(side["startup_to_health_ms"], f"{label}.startup", 0)
    observations = side["observations"]
    if not isinstance(observations, list) or [value.get("label") for value in observations] != ["idle", "warm"]:
        fail(f"{label} must contain exact idle/warm observations")
    for index, observation in enumerate(observations):
        validate_measurement(
            observation, f"{label}.observations[{index}]", 1, 0,
            authoritative=authoritative,
        )
    require_int(side["lifecycle_peak_bytes"], f"{label}.lifecycle_peak_bytes", 1)
    if side["lifecycle_peak_bytes"] < max(item["memory_peak_bytes"] for item in observations):
        fail(f"{label} lifecycle peak lost an observed peak")
    raw = side["workload"]
    required = {"task_count", "mutation_cycles", "static_reads", "list_reads", "latencies"}
    if not isinstance(raw, dict) or not required.issubset(raw):
        fail(f"{label} frozen Phase 1 workload is malformed")
    for key in ("task_count", "mutation_cycles", "static_reads", "list_reads"):
        if raw[key] != workload[key]:
            fail(f"{label} frozen workload count {key} drifted")
    expected_latency_names = {"static_read", "create", "list", "replace", "complete", "uncomplete", "delete"}
    if set(raw["latencies"]) != expected_latency_names:
        fail(f"{label} frozen workload latency classes drifted")
    for name, metric in raw["latencies"].items():
        if not isinstance(metric, dict) or not isinstance(metric.get("values_ms"), list) or metric.get("count") != len(metric["values_ms"]):
            fail(f"{label}.{name} raw latency observations are malformed")
        if metric["count"] <= 0:
            fail(f"{label}.{name} latency class is empty")
    if side["workload_digest"] != default_workload_digest(raw):
        fail(f"{label} workload digest does not recompute")
    require_int(side["profile_bytes"], f"{label}.profile_bytes", 1)
    validate_cleanup(side["cleanup"], f"{label}.cleanup")


def validate_build_attestation(value: Any, authority: str) -> None:
    if authority == "authoritative":
        build = exact_keys(
            value, {"mode", "commands", "source_before", "source_after"},
            "common.build_attestation",
        )
        if (
            build["mode"] != "clean_in_place_rebuild"
            or build["commands"] != [" ".join(command) for command in AUTHORITATIVE_BUILD_COMMANDS]
            or build["source_before"] != build["source_after"]
            or build["source_before"].get("clean") is not True
        ):
            fail("authoritative candidate build attestation was invalid")
    elif value != {"mode": "supplied_preliminary_outputs"}:
        fail("preliminary build attestation was invalid")


def validate_default(report: dict[str, Any]) -> None:
    quick = report["quick"]
    expected_samples = 1 if quick else 5
    workload = exact_keys(
        report["workload"],
        {"name", "samples", "task_count", "mutation_cycles", "static_reads", "list_reads", "interleave"},
        "default.workload",
    )
    expected = (10, 5, 5, 6) if quick else (100, 20, 20, 21)
    if (
        workload["name"] != "junban-phase1-hosted-server-v1"
        or workload["samples"] != expected_samples
        or tuple(workload[key] for key in ("task_count", "mutation_cycles", "static_reads", "list_reads")) != expected
        or workload["interleave"] != "base_then_candidate_per_pair"
    ):
        fail("default workload authority drifted")
    base = exact_keys(
        report["base"],
        {"commit", "tree", "source", "server", "production_dist", "interleave"},
        "default.base",
    )
    if (
        base["commit"] != BASE_COMMIT
        or base["tree"] != BASE_TREE
        or base["interleave"] != "base_then_candidate_per_pair"
    ):
        fail("default base/interleave authority drifted")
    source = exact_keys(
        base["source"],
        {"mode", "commit", "tree", "clean_before", "clean_after", "plugin_paths_absent"},
        "default.base.source",
    )
    if source != {
        "mode": "isolated_detached_worktree_build",
        "commit": BASE_COMMIT,
        "tree": BASE_TREE,
        "clean_before": True,
        "clean_after": True,
        "plugin_paths_absent": True,
    }:
        fail("default base was not the exact isolated plugin-free source")
    validate_identity(base["server"], "default.base.server")
    validate_identity(base["production_dist"], "default.base.production_dist")
    samples = report["samples"]
    if not isinstance(samples, list) or len(samples) != expected_samples:
        fail("default sample count drifted")
    for index, pair in enumerate(samples):
        pair = exact_keys(pair, {"pair_index", "base", "candidate"}, f"default.samples[{index}]")
        if pair["pair_index"] != index:
            fail("default pair ordering drifted")
        validate_default_side(
            pair["base"], f"default.samples[{index}].base", workload,
            authoritative=report["authority"] == "authoritative",
        )
        validate_default_side(
            pair["candidate"], f"default.samples[{index}].candidate", workload,
            authoritative=report["authority"] == "authoritative",
        )
    expected_aggregate = default_aggregates(samples)
    if report["aggregates"] != expected_aggregate:
        fail("default aggregates do not recompute from raw samples")
    budgets = exact_keys(report["budgets"], {"current_bytes", "peak_bytes", "growth_percent", "growth_floor_bytes"}, "default.budgets")
    if budgets != {
        "current_bytes": DEFAULT_CURRENT_BUDGET,
        "peak_bytes": DEFAULT_PEAK_BUDGET,
        "growth_percent": DELTA_PERCENT,
        "growth_floor_bytes": DELTA_FLOOR,
    }:
        fail("default frozen budgets drifted")


def validate_rust_corpus(corpus: Any, quick: bool) -> None:
    corpus = exact_keys(
        corpus,
        {"pomodoro_rounds", "automation_units", "stale_fence_rejected", "duplicate_effects", "simultaneous_loaded_runtimes"},
        "rust.corpus",
    )
    count = 5 if quick else 100
    pomodoro = corpus["pomodoro_rounds"]
    automation = corpus["automation_units"]
    if not isinstance(pomodoro, list) or not isinstance(automation, list) or len(pomodoro) != count or len(automation) != count:
        fail("Rust exact corpus count drifted")
    pomodoro_keys = {
        "number", "settings_values", "settings_response", "command_operation_id",
        "command_response", "reset_phase", "reset_metric", "reset_render_response",
        "action_operation_id", "action_response", "post_action_phase",
        "post_action_metric", "view_render_response", "status_tone",
        "status_render_response",
    }
    automation_keys = {
        "number", "task_id", "source_operation_id", "source_response",
        "replay_response", "source_revision", "effect_revision",
        "effect_task_revision", "effect_status", "cursor_observation",
    }
    for number, unit in enumerate(pomodoro):
        unit = exact_keys(unit, pomodoro_keys, f"rust.pomodoro[{number}]")
        reset_phase, reset_metric, post_action_phase, post_action_metric = (
            pomodoro_round_transition(number)
        )
        if (
            unit["number"] != number
            or unit["settings_values"] != {
                "break-minutes": 5, "long-break-minutes": 15,
                "sessions-before-long-break": 4, "work-minutes": 25,
            }
            or unit["reset_phase"] != reset_phase
            or unit["reset_metric"] != reset_metric
            or unit["post_action_phase"] != post_action_phase
            or unit["post_action_metric"] != post_action_metric
            or unit["status_tone"] != "neutral"
        ):
            fail("Rust Pomodoro numbered field evidence was incomplete")
        for key in (
            "settings_response", "command_response", "reset_render_response",
            "action_response", "view_render_response", "status_render_response",
        ):
            validate_identity(unit[key], f"rust.pomodoro[{number}].{key}")
        for key in ("command_operation_id", "action_operation_id"):
            try:
                uuid.UUID(unit[key])
            except (ValueError, TypeError) as error:
                raise HarnessError("Rust Pomodoro operation identity was malformed") from error
    for number, unit in enumerate(automation):
        unit = exact_keys(unit, automation_keys, f"rust.automation[{number}]")
        if (
            unit["number"] != number
            or unit["source_response"] != unit["replay_response"]
            or unit["source_revision"] >= unit["effect_revision"]
            or unit["effect_task_revision"] != unit["effect_revision"]
            or unit["effect_status"] != "completed"
            or unit["cursor_observation"] != "api_observable_no_duplicate_effect"
        ):
            fail("Rust automation event/effect/cursor/replay corpus was incomplete")
        validate_identity(unit["source_response"], f"rust.automation[{number}].source_response")
        for key in ("task_id", "source_operation_id"):
            try:
                uuid.UUID(unit[key])
            except (ValueError, TypeError) as error:
                raise HarnessError("Rust automation identity was malformed") from error
    if corpus["stale_fence_rejected"] is not True or corpus["duplicate_effects"] != 0 or corpus["simultaneous_loaded_runtimes"] is not False:
        fail("Rust stale-fence/effect/runtime assertion failed")


def validate_typescript_corpus(corpus: Any, quick: bool) -> None:
    corpus = exact_keys(
        corpus,
        {
            "task_units", "affected_task_count", "command_operation_id",
            "command_response", "replay_response", "revision_before",
            "revision_after", "event_corpus_sha256", "stale_error_code",
            "event_claim", "command_invocations",
        },
        "typescript.corpus",
    )
    count = 10 if quick else 100
    units = corpus["task_units"]
    if not isinstance(units, list) or len(units) != count or corpus["affected_task_count"] != count:
        fail("TypeScript bounded bulk corpus count drifted")
    for number, unit in enumerate(units):
        unit = exact_keys(
            unit,
            {
                "number", "task_id", "create_operation_id", "create_response",
                "initial_revision", "completed_revision", "event_revision",
            },
            f"typescript.task_units[{number}]",
        )
        if (
            unit["number"] != number
            or unit["initial_revision"] >= unit["completed_revision"]
            or unit["completed_revision"] != unit["event_revision"]
        ):
            fail("TypeScript numbered bulk corpus was incomplete")
        validate_identity(unit["create_response"], f"typescript.task_units[{number}].create_response")
        for key in ("task_id", "create_operation_id"):
            try:
                uuid.UUID(unit[key])
            except (ValueError, TypeError) as error:
                raise HarnessError("TypeScript task identity was malformed") from error
    validate_identity(corpus["command_response"], "typescript.command_response")
    validate_identity(corpus["replay_response"], "typescript.replay_response")
    if (
        corpus["command_response"] != corpus["replay_response"]
        or corpus["revision_before"] >= corpus["revision_after"]
        or corpus["stale_error_code"] != "stale_plugin_authority"
        or not isinstance(corpus["event_corpus_sha256"], str)
        or not HEX64.fullmatch(corpus["event_corpus_sha256"])
        or corpus["event_claim"] is not False
        or corpus["command_invocations"] != 1
    ):
        fail("TypeScript receipt/event/revision/replay authority failed")
    try:
        uuid.UUID(corpus["command_operation_id"])
    except (ValueError, TypeError) as error:
        raise HarnessError("TypeScript command operation identity was malformed") from error


def expected_host_for_label(kind: str, label: str) -> int:
    if label in {"dormant", "between-runtimes", "all-disabled"}:
        return 0
    if kind == "rust" and (label.startswith("pomodoro-") or label.startswith("automation-")):
        return 1
    if kind == "typescript" and label.startswith("typescript-"):
        return 1
    fail(f"{kind} observation label is not part of the frozen lifecycle")


def validate_plugin(report: dict[str, Any], kind: str) -> None:
    quick = report["quick"]
    expected_samples = 1 if quick else 5
    workload_keys = (
        {"name", "samples", "pomodoro_rounds", "automation_units", "runtime_scale", "order"}
        if kind == "rust"
        else {"name", "samples", "bulk_task_count", "runtime_scale", "plugin_id", "event_workload"}
    )
    workload = exact_keys(report["workload"], workload_keys, f"{kind}.workload")
    if workload["samples"] != expected_samples or workload["runtime_scale"] != 1:
        fail(f"{kind} workload sample/scale authority drifted")
    if kind == "rust":
        expected_count = 5 if quick else 100
        if (
            workload["name"] != "rust-reference-sequential-v1"
            or workload["pomodoro_rounds"] != expected_count
            or workload["automation_units"] != expected_count
            or workload["order"] != "pomodoro-disable-host-exit-automation-disable-host-exit"
        ):
            fail("Rust workload authority drifted")
    else:
        expected_count = 10 if quick else 100
        if (
            workload["name"] != "typescript-import-bulk-v1"
            or workload["bulk_task_count"] != expected_count
            or workload["plugin_id"] != "import-typescript"
            or workload["event_workload"] is not False
        ):
            fail("TypeScript workload authority drifted")
    if report["base"] is not None:
        fail(f"{kind} report must not merge a default/base report")
    samples = report["samples"]
    if not isinstance(samples, list) or len(samples) != expected_samples:
        fail(f"{kind} sample count drifted")
    sample_keys = {
        "sample_index",
        "startup_to_health_ms",
        "observations",
        "lifecycle_peak_bytes",
        "latencies_ms",
        "corpus",
        "corpus_digest",
        "profile_bytes",
        "package_bytes",
        "cleanup",
    }
    for index, sample in enumerate(samples):
        sample = exact_keys(sample, sample_keys, f"{kind}.samples[{index}]")
        if sample["sample_index"] != index:
            fail(f"{kind} sample ordering drifted")
        require_number(sample["startup_to_health_ms"], f"{kind}.startup", 0)
        observations = sample["observations"]
        if not isinstance(observations, list) or len(observations) < 4:
            fail(f"{kind} lifecycle observations are incomplete")
        for position, observation in enumerate(observations):
            host_count = expected_host_for_label(kind, str(observation.get("label")))
            validate_measurement(
                observation, f"{kind}.observations[{position}]", 1, host_count,
                authoritative=report["authority"] == "authoritative",
            )
        require_int(sample["lifecycle_peak_bytes"], f"{kind}.lifecycle_peak_bytes", 1)
        if sample["lifecycle_peak_bytes"] < max(value["memory_peak_bytes"] for value in observations):
            fail(f"{kind} lifecycle peak lost an observed peak")
        validate_latencies_raw(sample["latencies_ms"], f"{kind}.latencies_ms")
        if kind == "rust":
            validate_rust_corpus(sample["corpus"], quick)
        else:
            validate_typescript_corpus(sample["corpus"], quick)
        if sample["corpus_digest"] != corpus_digest(sample["corpus"]):
            fail(f"{kind} corpus digest does not recompute")
        require_int(sample["profile_bytes"], f"{kind}.profile_bytes", 1)
        require_int(sample["package_bytes"], f"{kind}.package_bytes", 1)
        validate_cleanup(sample["cleanup"], f"{kind}.cleanup")
    expected_aggregate = plugin_aggregates(samples)
    if report["aggregates"] != expected_aggregate:
        fail(f"{kind} aggregates do not recompute from raw samples")
    expected_budgets = {
        "current_bytes": RUST_CURRENT_BUDGET if kind == "rust" else TYPESCRIPT_CURRENT_BUDGET,
        "peak_bytes": RUST_PEAK_BUDGET if kind == "rust" else TYPESCRIPT_PEAK_BUDGET,
    }
    if report["budgets"] != expected_budgets:
        fail(f"{kind} frozen budgets drifted")


def validate_checker(report: dict[str, Any]) -> None:
    checker = exact_keys(report["checker"], CHECKER_KEYS, "checker")
    if checker["version"] != CHECKER_VERSION:
        fail("checker version drifted")
    if not isinstance(checker["sha256"], str) or not HEX64.fullmatch(checker["sha256"]):
        fail("checker hash is malformed")
    if checker["sha256"] != report["common"]["artifacts"]["performance_harness"]["sha256"]:
        fail("checker/harness artifact identity mismatched")
    if checker["sha256"] != sha256_file(SCRIPT):
        fail("report checker hash does not match the current checker script")
    claimed = checker["document_payload_sha256"]
    if not isinstance(claimed, str) or not HEX64.fullmatch(claimed):
        fail("document payload hash is malformed")
    clone = copy.deepcopy(report)
    clone["checker"]["document_payload_sha256"] = "0" * 64
    if hashlib.sha256(canonical(clone)).hexdigest() != claimed:
        fail("document payload hash does not recompute")


def validate_report(report: Any, expected_kind: str, *, require_authoritative: bool) -> dict[str, Any]:
    assert_public_safe(report)
    value = exact_keys(report, REPORT_KEYS, f"{expected_kind} report")
    if value["schema_version"] != SCHEMA_VERSION or value["protocol"] != PROTOCOL or value["report_kind"] != expected_kind:
        fail(f"{expected_kind} protocol/schema/kind authority drifted")
    if value["authority"] not in {"preliminary", "authoritative"}:
        fail(f"{expected_kind} authority is invalid")
    require_bool(value["quick"], f"{expected_kind}.quick")
    if value["quick"] and value["authority"] == "authoritative":
        fail("quick evidence cannot claim authoritative status")
    if require_authoritative and value["authority"] != "authoritative":
        fail(f"{expected_kind} report is not authoritative")
    for key in ("started_at", "finished_at"):
        if not isinstance(value[key], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value[key]):
            fail(f"{expected_kind}.{key} is malformed")
    validate_candidate(value["candidate"], value["authority"])
    validate_common(value["common"], value["authority"])
    if expected_kind == "default":
        validate_default(value)
    else:
        validate_plugin(value, expected_kind)
    recomputed = report_budget(value)
    require_bool(value["budget_passed"], f"{expected_kind}.budget_passed")
    if value["budget_passed"] != recomputed:
        fail(f"{expected_kind} budget result does not recompute")
    if not recomputed and require_authoritative:
        fail(f"{expected_kind} frozen performance gate failed")
    validate_checker(value)
    return value


def read_report(path: Path) -> Any:
    if path.is_symlink() or not path.is_file():
        fail(f"required evidence report is missing or unsafe: {path.name}")
    if path.stat().st_size > 16 * 1024 * 1024:
        fail(f"evidence report exceeds bounded checker input: {path.name}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise HarnessError(f"evidence report is not strict UTF-8 JSON: {path.name}") from error


def check_evidence(directory: Path, *, require_authoritative: bool = False) -> dict[str, dict[str, Any]]:
    root = directory.expanduser().resolve(strict=True)
    if not root.is_dir() or root.is_symlink():
        fail("evidence directory is unsafe")
    reports = {
        kind: validate_report(read_report(root / name), kind, require_authoritative=require_authoritative)
        for kind, name in REPORT_NAMES.items()
    }
    reference = reports["default"]
    for kind in ("rust", "typescript"):
        current = reports[kind]
        if current["candidate"] != reference["candidate"]:
            fail(f"{kind} candidate identity does not match default report")
        if current["common"]["artifacts"] != reference["common"]["artifacts"]:
            fail(f"{kind} candidate/public artifact identities do not match default report")
        if current["common"]["artifact_check_passed"] != reference["common"]["artifact_check_passed"]:
            fail(f"{kind} public checker result does not match default report")
        if current["authority"] != reference["authority"] or current["quick"] != reference["quick"]:
            fail(f"{kind} campaign authority does not match default report")
    return reports


def validate_current_binding(
    reports: dict[str, dict[str, Any]],
    snapshot: dict[str, Any],
    artifacts: dict[str, dict[str, Any]],
) -> None:
    current = exact_keys(
        snapshot,
        {"commit", "tree", "index_tree", "working_state_sha256", "clean"},
        "current candidate snapshot",
    )
    if current["clean"] is not True:
        fail("closure evidence requires a clean current checkout")
    identity_keys = ("commit", "tree", "index_tree", "working_state_sha256")
    for kind, report in reports.items():
        recorded = report["candidate"]
        if any(recorded[key] != current[key] for key in identity_keys):
            fail(f"current candidate identity does not match {kind} report")
        recorded_artifacts = report["common"]["artifacts"]
        if set(recorded_artifacts) != set(artifacts):
            fail(f"current artifact inventory does not match {kind} report")
        for name, recorded_identity in recorded_artifacts.items():
            if recorded_identity != artifacts[name]:
                fail(f"current {name} identity does not match {kind} report")


def current_binding_inputs() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    before = candidate_snapshot()
    if not before["clean"]:
        fail("closure evidence requires a clean current checkout")
    release = ROOT / "target/release"
    server = resolve_regular(release / "junban-server", "current candidate server", executable=True)
    host = resolve_regular(release / "junban-plugin-host", "current adjacent plugin host", executable=True)
    tool = resolve_regular(release / "junban-plugin-artifact", "current artifact tool", executable=True)
    artifacts = artifact_identities(server, host, tool, ROOT / "dist")
    after = candidate_snapshot()
    if before != after or not after["clean"]:
        fail("current candidate identity changed while binding closure evidence")
    return after, artifacts


def synthetic_measurement(label: str, host_count: int, current: int, peak: int) -> dict[str, Any]:
    processes = [{"name": "junban-server", "rss_bytes": 1024, "pss_bytes": 1024}]
    if host_count:
        processes.append({"name": "junban-plugin-host", "rss_bytes": 2048, "pss_bytes": 2048})
    return {
        "label": label,
        "memory_current_bytes": current,
        "memory_peak_bytes": peak,
        "memory_swap_current_bytes": 0,
        "memory_swap_peak_bytes": 0,
        "memory_anon_bytes": current,
        "memory_file_bytes": 0,
        "reclaim_file_bytes": 0,
        "reclaim_result": "not_needed",
        "reclaim_attempts": [],
        "post_reclaim_memory_current_bytes": current,
        "post_reclaim_file_bytes": 0,
        "processes": processes,
        "server_count": 1,
        "host_count": host_count,
        "unexpected_count": 0,
        "node_count": 0,
    }


def synthetic_cleanup() -> dict[str, bool]:
    return {key: True for key in CLEANUP_KEYS}


def synthetic_common() -> dict[str, Any]:
    identity = {"sha256": "a" * 64, "size_bytes": 1}
    names = {
        "junban_server",
        "junban_plugin_host",
        "junban_plugin_artifact",
        "production_dist",
        "artifact_checker",
        "performance_harness",
        "dogfood_harness",
        "hosted_benchmark",
        "protocol",
        "cargo_lock",
        "pnpm_lock",
        "rust_toolchain",
        "cargo_manifest",
        "package_manifest",
        "openapi",
        "wit_contract",
        "registry_index",
        "registry_root_public_key",
        "publisher_public_key",
        "include_table",
        "automation_source",
        "automation_component",
        "pomodoro_source",
        "pomodoro_component",
        "typescript_source",
        "typescript_component",
        "package_automation",
        "package_import_typescript",
        "package_pomodoro",
    }
    host = {
        "load1": 0.1,
        "load5": 0.1,
        "load15": 0.1,
        "cpu_count": 4,
        "load1_threshold": 2.0,
        "load5_threshold": 1.2,
        "active_confounder_count": 0,
        "swap_io_active": False,
        "swap_used_bytes": 0,
        "idle": True,
    }
    artifacts = {name: dict(identity) for name in names}
    artifacts["performance_harness"] = {"sha256": sha256_file(SCRIPT), "size_bytes": SCRIPT.stat().st_size}
    return {
        "artifacts": artifacts,
        "artifact_check_passed": True,
        "build_attestation": {"mode": "supplied_preliminary_outputs"},
        "platform": {
            "system": "Linux",
            "kernel": "synthetic",
            "machine": "x86_64",
            "cpu_count": 4,
            "memory_total_bytes": 8 * 1024 * MIB,
            "cgroup_version": 2,
            "memory_controller": True,
        },
        "host": {"pre": dict(host), "post": dict(host)},
        "toolchain": {
            "python": "3.synthetic",
            "rustc": "rustc synthetic",
            "cargo": "cargo synthetic",
            "node": "v24.synthetic",
            "pnpm": "10.synthetic",
            "wasmtime": "36.0.13",
            "jco": "1.26.1",
            "componentize_js": "0.22.0",
        },
        "command_template": (
            f"{SCRIPT.name} --collect --non-authoritative --quick "
            "--output-dir <external-directory>"
        ),
    }


def synthetic_candidate() -> dict[str, Any]:
    return {
        "commit": "1" * 40,
        "tree": "2" * 40,
        "index_tree": "2" * 40,
        "working_state_sha256": "3" * 64,
        "clean_at_start": False,
        "clean_at_end": False,
        "identity_stable": True,
    }


def synthetic_reports() -> dict[str, dict[str, Any]]:
    common = synthetic_common()
    candidate = synthetic_candidate()
    lat_metric = lambda values: {
        "count": len(values),
        "p50_ms": percentile(values, 50),
        "p95_ms": percentile(values, 95),
        "min_ms": min(values),
        "max_ms": max(values),
        "values_ms": values,
    }
    latency_names = ("static_read", "create", "list", "replace", "complete", "uncomplete", "delete")
    raw_workload = {
        "task_count": 10,
        "mutation_cycles": 5,
        "static_reads": 5,
        "list_reads": 6,
        "latencies": {name: lat_metric([1.0]) for name in latency_names},
    }

    def side(current: int) -> dict[str, Any]:
        return {
            "startup_to_health_ms": 1.0,
            "observations": [
                synthetic_measurement("idle", 0, current - 100, current + 100),
                synthetic_measurement("warm", 0, current, current + 200),
            ],
            "lifecycle_peak_bytes": current + 300,
            "workload": copy.deepcopy(raw_workload),
            "workload_digest": default_workload_digest(raw_workload),
            "profile_bytes": 4096,
            "cleanup": synthetic_cleanup(),
        }

    default = make_report(
        "default",
        "preliminary",
        True,
        "2026-01-01T00:00:00Z",
        copy.deepcopy(candidate),
        copy.deepcopy(common),
        {
            "commit": BASE_COMMIT,
            "tree": BASE_TREE,
            "source": {
                "mode": "isolated_detached_worktree_build",
                "commit": BASE_COMMIT,
                "tree": BASE_TREE,
                "clean_before": True,
                "clean_after": True,
                "plugin_paths_absent": True,
            },
            "server": {"sha256": "b" * 64, "size_bytes": 1},
            "production_dist": {"sha256": "c" * 64, "size_bytes": 1},
            "interleave": "base_then_candidate_per_pair",
        },
        {
            "name": "junban-phase1-hosted-server-v1",
            "samples": 1,
            "task_count": 10,
            "mutation_cycles": 5,
            "static_reads": 5,
            "list_reads": 6,
            "interleave": "base_then_candidate_per_pair",
        },
        [{"pair_index": 0, "base": side(8 * MIB), "candidate": side(8 * MIB + 1024)}],
    )
    identity = {"sha256": "d" * 64, "size_bytes": 1}
    pomodoro = []
    for number in range(5):
        reset_phase, reset_metric, post_action_phase, post_action_metric = (
            pomodoro_round_transition(number)
        )
        pomodoro.append(
            {
                "number": number,
                "settings_values": {
                    "break-minutes": 5, "long-break-minutes": 15,
                    "sessions-before-long-break": 4, "work-minutes": 25,
                },
                "settings_response": dict(identity),
                "command_operation_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"command:{number}")),
                "command_response": dict(identity),
                "reset_phase": reset_phase,
                "reset_metric": reset_metric,
                "reset_render_response": dict(identity),
                "action_operation_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"action:{number}")),
                "action_response": dict(identity),
                "post_action_phase": post_action_phase,
                "post_action_metric": post_action_metric,
                "view_render_response": dict(identity),
                "status_tone": "neutral",
                "status_render_response": dict(identity),
            }
        )
    automation = [
        {
            "number": number,
            "task_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"task:{number}")),
            "source_operation_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"source:{number}")),
            "source_response": dict(identity),
            "replay_response": dict(identity),
            "source_revision": number * 2 + 1,
            "effect_revision": number * 2 + 2,
            "effect_task_revision": number * 2 + 2,
            "effect_status": "completed",
            "cursor_observation": "api_observable_no_duplicate_effect",
        }
        for number in range(5)
    ]
    rust_corpus = {
        "pomodoro_rounds": pomodoro,
        "automation_units": automation,
        "stale_fence_rejected": True,
        "duplicate_effects": 0,
        "simultaneous_loaded_runtimes": False,
    }
    rust_sample_value = {
        "sample_index": 0,
        "startup_to_health_ms": 1.0,
        "observations": [
            synthetic_measurement("dormant", 0, 8 * MIB, 9 * MIB),
            synthetic_measurement("pomodoro-000", 1, 20 * MIB, 25 * MIB),
            synthetic_measurement("between-runtimes", 0, 9 * MIB, 25 * MIB),
            synthetic_measurement("automation-first", 1, 21 * MIB, 26 * MIB),
            synthetic_measurement("all-disabled", 0, 9 * MIB, 26 * MIB),
        ],
        "lifecycle_peak_bytes": 27 * MIB,
        "latencies_ms": {"install_verify": [1.0], "disable": [1.0]},
        "corpus": rust_corpus,
        "corpus_digest": corpus_digest(rust_corpus),
        "profile_bytes": 4096,
        "package_bytes": 4096,
        "cleanup": synthetic_cleanup(),
    }
    rust_reclaim = rust_sample_value["observations"][1]
    rust_reclaim.update(
        {
            "memory_file_bytes": 4096,
            "reclaim_file_bytes": 4096,
            "reclaim_result": "written",
            "reclaim_attempts": [
                {
                    "requested_file_bytes": 4096,
                    "result": "written",
                    "memory_current_after_bytes": rust_reclaim[
                        "post_reclaim_memory_current_bytes"
                    ],
                    "memory_file_after_bytes": 0,
                }
            ],
        }
    )
    rust = make_report(
        "rust",
        "preliminary",
        True,
        "2026-01-01T00:00:00Z",
        copy.deepcopy(candidate),
        copy.deepcopy(common),
        None,
        {
            "name": "rust-reference-sequential-v1",
            "samples": 1,
            "pomodoro_rounds": 5,
            "automation_units": 5,
            "runtime_scale": 1,
            "order": "pomodoro-disable-host-exit-automation-disable-host-exit",
        },
        [rust_sample_value],
    )
    ts_corpus = {
        "task_units": [
            {
                "number": number,
                "task_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"ts-task:{number}")),
                "create_operation_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"ts-create:{number}")),
                "create_response": dict(identity),
                "initial_revision": number + 1,
                "completed_revision": 20,
                "event_revision": 20,
            }
            for number in range(10)
        ],
        "affected_task_count": 10,
        "command_operation_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ts-command")),
        "command_response": dict(identity),
        "replay_response": dict(identity),
        "revision_before": 10,
        "revision_after": 20,
        "event_corpus_sha256": "e" * 64,
        "stale_error_code": "stale_plugin_authority",
        "event_claim": False,
        "command_invocations": 1,
    }
    ts_sample = {
        "sample_index": 0,
        "startup_to_health_ms": 1.0,
        "observations": [
            synthetic_measurement("dormant", 0, 8 * MIB, 9 * MIB),
            synthetic_measurement("typescript-first", 1, 400 * MIB, 500 * MIB),
            synthetic_measurement("typescript-warm", 1, 410 * MIB, 510 * MIB),
            synthetic_measurement("all-disabled", 0, 9 * MIB, 510 * MIB),
        ],
        "lifecycle_peak_bytes": 520 * MIB,
        "latencies_ms": {"install_verify": [1.0], "bulk_command": [1.0]},
        "corpus": ts_corpus,
        "corpus_digest": corpus_digest(ts_corpus),
        "profile_bytes": 4096,
        "package_bytes": 4096,
        "cleanup": synthetic_cleanup(),
    }
    typescript = make_report(
        "typescript",
        "preliminary",
        True,
        "2026-01-01T00:00:00Z",
        copy.deepcopy(candidate),
        copy.deepcopy(common),
        None,
        {
            "name": "typescript-import-bulk-v1",
            "samples": 1,
            "bulk_task_count": 10,
            "runtime_scale": 1,
            "plugin_id": "import-typescript",
            "event_workload": False,
        },
        [ts_sample],
    )
    return {"default": default, "rust": rust, "typescript": typescript}


def write_synthetic(root: Path, reports: dict[str, dict[str, Any]]) -> None:
    for kind, name in REPORT_NAMES.items():
        seal(reports[kind])
        (root / name).write_text(json.dumps(reports[kind], sort_keys=True), encoding="utf-8")


def expect_rejected(reports: dict[str, dict[str, Any]], mutation: Callable[[dict[str, dict[str, Any]]], None], label: str) -> None:
    candidate = copy.deepcopy(reports)
    mutation(candidate)
    with tempfile.TemporaryDirectory(prefix="junban-p7w5-reject-") as temporary:
        root = Path(temporary)
        write_synthetic(root, candidate)
        try:
            check_evidence(root)
        except HarnessError:
            return
    raise AssertionError(f"self-check mutation was accepted: {label}")


def expect_current_binding_rejected(
    reports: dict[str, dict[str, Any]],
    snapshot: dict[str, Any],
    artifacts: dict[str, dict[str, Any]],
    mutation: Callable[[dict[str, dict[str, Any]]], None],
    label: str,
) -> None:
    candidate = copy.deepcopy(reports)
    mutation(candidate)
    try:
        validate_current_binding(candidate, snapshot, artifacts)
    except HarnessError:
        return
    raise AssertionError(f"self-check current-binding mutation was accepted: {label}")


def self_check() -> None:
    def snapshot(*, idle: bool, load: float) -> dict[str, Any]:
        return {
            "load1": load,
            "load5": load,
            "load15": load,
            "cpu_count": 4,
            "load1_threshold": 2.0,
            "load5_threshold": 2.0,
            "active_confounder_count": 0 if idle else 1,
            "swap_io_active": False,
            "swap_used_bytes": 0,
            "idle": idle,
        }

    immediate = snapshot(idle=True, load=0.5)
    immediate_calls = 0

    def sample_immediate() -> dict[str, Any]:
        nonlocal immediate_calls
        immediate_calls += 1
        return immediate

    assert wait_for_idle_host(sample_immediate, sleep_fn=lambda _: None) is immediate
    assert immediate_calls == 1

    clock = [0.0]
    sleeps: list[float] = []

    def fake_monotonic() -> float:
        return clock[0]

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    contended = snapshot(idle=False, load=4.0)
    eventual = snapshot(idle=True, load=1.0)
    eventual_samples = [contended, eventual]
    accepted = wait_for_idle_host(
        lambda: eventual_samples.pop(0),
        timeout_seconds=20.0,
        poll_seconds=10.0,
        sleep_fn=fake_sleep,
        monotonic_fn=fake_monotonic,
    )
    assert accepted is eventual
    assert sleeps == [10.0]

    clock[0] = 0.0
    sleeps.clear()
    timeout_calls = 0

    def sample_contended() -> dict[str, Any]:
        nonlocal timeout_calls
        timeout_calls += 1
        return contended

    try:
        wait_for_idle_host(
            sample_contended,
            timeout_seconds=20.0,
            poll_seconds=10.0,
            sleep_fn=fake_sleep,
            monotonic_fn=fake_monotonic,
        )
    except HarnessError as error:
        assert "did not become idle with zero swap" in str(error)
        assert "load5=4.00/2.00" in str(error)
    else:
        raise AssertionError("idle-host wait accepted a contended host after timeout")
    assert timeout_calls == 3
    assert sleeps == [10.0, 10.0]

    reports = synthetic_reports()
    with tempfile.TemporaryDirectory(prefix="junban-p7w5-valid-") as temporary:
        root = Path(temporary)
        write_synthetic(root, reports)
        check_evidence(root)

    failed_diagnostic = copy.deepcopy(reports)
    failed_rust = failed_diagnostic["rust"]
    failed_observation = failed_rust["samples"][0]["observations"][1]
    failed_observation["memory_current_bytes"] = RUST_CURRENT_BUDGET + 1
    failed_observation["post_reclaim_memory_current_bytes"] = RUST_CURRENT_BUDGET + 1
    failed_observation["memory_peak_bytes"] = RUST_CURRENT_BUDGET + 1
    failed_rust["samples"][0]["lifecycle_peak_bytes"] = RUST_CURRENT_BUDGET + 1
    failed_rust["aggregates"] = plugin_aggregates(failed_rust["samples"])
    failed_rust["budget_passed"] = report_budget(failed_rust)
    if failed_rust["budget_passed"] is not False:
        raise AssertionError("synthetic preliminary budget failure did not fail")
    with tempfile.TemporaryDirectory(prefix="junban-p7w5-failed-diagnostic-") as temporary:
        root = Path(temporary)
        write_synthetic(root, failed_diagnostic)
        check_evidence(root)
        try:
            check_evidence(root, require_authoritative=True)
        except HarnessError:
            pass
        else:
            raise AssertionError("closure checker accepted failed preliminary evidence")

    def mutate_all(candidate: dict[str, dict[str, Any]], call: Callable[[dict[str, Any]], None]) -> None:
        for report in candidate.values():
            call(report)

    current_snapshot = {
        key: reports["default"]["candidate"][key]
        for key in ("commit", "tree", "index_tree", "working_state_sha256")
    }
    current_snapshot["clean"] = True
    current_artifacts = copy.deepcopy(reports["default"]["common"]["artifacts"])
    validate_current_binding(reports, current_snapshot, current_artifacts)
    dirty_snapshot = dict(current_snapshot)
    dirty_snapshot["clean"] = False
    try:
        validate_current_binding(reports, dirty_snapshot, current_artifacts)
    except HarnessError:
        pass
    else:
        raise AssertionError("self-check current binding accepted a dirty checkout")

    def mutate_recorded_candidate(candidate: dict[str, dict[str, Any]]) -> None:
        mutate_all(candidate, lambda report: report["candidate"].__setitem__("commit", "f" * 40))

    def mutate_recorded_artifact(name: str) -> Callable[[dict[str, dict[str, Any]]], None]:
        return lambda candidate: mutate_all(
            candidate,
            lambda report: report["common"]["artifacts"][name].__setitem__("sha256", "f" * 64),
        )

    current_binding_mutations = [
        ("candidate", mutate_recorded_candidate),
        ("public artifact", mutate_recorded_artifact("protocol")),
        ("server binary", mutate_recorded_artifact("junban_server")),
        ("host binary", mutate_recorded_artifact("junban_plugin_host")),
        ("artifact tool binary", mutate_recorded_artifact("junban_plugin_artifact")),
        ("production dist", mutate_recorded_artifact("production_dist")),
    ]
    for label, mutation in current_binding_mutations:
        expect_current_binding_rejected(
            reports, current_snapshot, current_artifacts, mutation, label,
        )

    mutations: list[tuple[str, Callable[[dict[str, dict[str, Any]]], None]]] = [
        ("raw budget", lambda value: value["rust"]["samples"][0]["observations"][1].__setitem__("memory_current_bytes", RUST_CURRENT_BUDGET + 1)),
        ("candidate identity", lambda value: value["rust"]["candidate"].__setitem__("commit", "f" * 40)),
        ("artifact identity", lambda value: value["typescript"]["common"]["artifacts"]["junban_server"].__setitem__("sha256", "f" * 64)),
        ("swap", lambda value: value["rust"]["samples"][0]["observations"][0].__setitem__("memory_swap_current_bytes", 1)),
        ("reclaim request", lambda value: value["rust"]["samples"][0]["observations"][1]["reclaim_attempts"][0].__setitem__("requested_file_bytes", 2048)),
        ("node process", lambda value: value["typescript"]["samples"][0]["observations"][1]["processes"].append({"name": "node", "rss_bytes": 1, "pss_bytes": 1})),
        ("cleanup", lambda value: value["rust"]["samples"][0]["cleanup"].__setitem__("no_host_orphan", False)),
        ("corpus", lambda value: value["rust"]["samples"][0]["corpus"]["automation_units"][0].__setitem__("effect_status", "pending")),
        ("artifact checker", lambda value: value["default"]["common"].__setitem__("artifact_check_passed", False)),
        ("quick authority", lambda value: mutate_all(value, lambda report: report.__setitem__("authority", "authoritative"))),
        ("dirty authoritative", lambda value: (mutate_all(value, lambda report: report.__setitem__("authority", "authoritative")), mutate_all(value, lambda report: report.__setitem__("quick", False)))),
        ("secret", lambda value: value["default"]["common"].__setitem__("command_template", "Authorization: Bearer secretsecret")),
        ("unknown schema field", lambda value: value["default"].__setitem__("unknown", True)),
    ]
    for label, mutation in mutations:
        expect_rejected(reports, mutation, label)
    print("Phase 7 Wave 5 performance self-check passed")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-check", action="store_true")
    mode.add_argument("--collect", action="store_true")
    mode.add_argument(
        "--check-evidence", type=Path, metavar="DIR",
        help="validate closure evidence: authoritative, nonquick, budget-passing reports only",
    )
    mode.add_argument(
        "--check-preliminary-evidence", type=Path, metavar="DIR",
        help="validate structurally complete preliminary/diagnostic reports",
    )
    authority = parser.add_mutually_exclusive_group()
    authority.add_argument("--authoritative", action="store_true")
    authority.add_argument("--non-authoritative", action="store_true")
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--server", type=Path, default=Path("target/release/junban-server"))
    parser.add_argument("--host", type=Path, default=Path("target/release/junban-plugin-host"))
    parser.add_argument("--artifact-tool", type=Path, default=Path("target/release/junban-plugin-artifact"))
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    # Retained only to reject stale invocations explicitly rather than silently
    # accepting caller-controlled comparison artifacts.
    parser.add_argument("--base-server", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--base-web-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--base-commit", default=BASE_COMMIT, help=argparse.SUPPRESS)
    parser.add_argument("--build-base", action="store_true")
    args = parser.parse_args(argv)
    if args.collect:
        if args.output_dir is None:
            parser.error("--collect requires --output-dir")
        if args.authoritative == args.non_authoritative:
            parser.error("--collect requires exactly one of --authoritative or --non-authoritative")
    elif any((args.authoritative, args.non_authoritative, args.quick, args.output_dir, args.base_server, args.base_web_dir, args.build_base)):
        parser.error("collection-only options require --collect")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_check:
        self_check()
        return 0
    if args.check_evidence is not None:
        reports = check_evidence(args.check_evidence, require_authoritative=True)
        if any(report["quick"] or report["budget_passed"] is not True for report in reports.values()):
            fail("closure evidence must be nonquick and pass every frozen budget")
        snapshot, artifacts = current_binding_inputs()
        validate_current_binding(reports, snapshot, artifacts)
        print("Phase 7 Wave 5 authoritative closure evidence passed strict validation")
        return 0
    if args.check_preliminary_evidence is not None:
        reports = check_evidence(args.check_preliminary_evidence)
        authority = reports["default"]["authority"]
        print(f"Phase 7 Wave 5 {authority} evidence passed strict validation")
        return 0
    return collect(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HarnessError, AssertionError) as error:
        print(f"Phase 7 Wave 5 performance failed: {error}", file=sys.stderr)
        raise SystemExit(1)
