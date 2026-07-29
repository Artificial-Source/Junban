#!/usr/bin/env python3
"""Phase 1 hosted-server memory/startup/latency benchmark harness.

Measures only the optimized junban-server process inside a transient
systemd --user cgroup. The Python driver, Node, Vite, and browsers stay
outside that cgroup and are never counted as runtime memory.

Default protocol (authoritative evidence):
  - 5 independent fresh-profile samples
  - 100 ordinary task creates (not the Phase 2 10k fixture)
  - fixed list/static reads and mutation cycle
  - cgroup MemoryCurrent/MemoryPeak + RSS/PSS
  - per-operation HTTP latency p50/p95

Quick mode (--quick) is for harness validation only and must not be frozen
as final Phase 1 evidence.

This harness deliberately does not invent a memory ceiling. Summary fields
leave ceiling/variance null so the main agent can freeze them after a full
5-sample run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROTOCOL_NAME = "junban-phase1-hosted-server-v1"
PROTOCOL_VERSION = 1

# Ordinary personal working set: enough to warm SQLite pages and list
# serialization without becoming Phase 2's large 10_000-task fixture.
DEFAULT_SAMPLES = 5
DEFAULT_TASK_COUNT = 100
DEFAULT_MUTATION_CYCLES = 20
DEFAULT_STATIC_READS = 20
DEFAULT_LIST_READS = 20

# Short post-ready settle so allocator/page-cache noise drops before idle.
# Readiness and shutdown are condition-polled; this is the only fixed sleep.
DEFAULT_SETTLE_SECONDS = 2.0

READY_TIMEOUT_SECONDS = 15.0
STOP_TIMEOUT_SECONDS = 15.0
POLL_INTERVAL_SECONDS = 0.025

TOKEN_FILE = "access-token"
RUNTIME_FILE = "runtime.json"
DATABASE_FILE = "junban.sqlite3"


class BenchError(RuntimeError):
    """Fail-closed benchmark error."""


@dataclass
class LatencyBucket:
    values_ms: list[float] = field(default_factory=list)

    def add(self, elapsed_ms: float) -> None:
        self.values_ms.append(elapsed_ms)

    def summary(self) -> dict[str, Any]:
        if not self.values_ms:
            raise BenchError("missing latency samples")
        ordered = sorted(self.values_ms)
        return {
            "count": len(ordered),
            "p50_ms": percentile(ordered, 50),
            "p95_ms": percentile(ordered, 95),
            "min_ms": ordered[0],
            "max_ms": ordered[-1],
            "values_ms": ordered,
        }


def percentile(ordered: list[float], pct: float) -> float:
    if not ordered:
        raise BenchError("cannot compute percentile of empty series")
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def median(values: list[float]) -> float:
    if not values:
        raise BenchError("cannot compute median of empty series")
    return statistics.median(values)


def run_cmd(
    args: list[str],
    *,
    check: bool = True,
    capture: bool = True,
    text: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        check=False,
        capture_output=capture,
        text=text,
        env=env,
    )
    if check and result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        detail = stderr or stdout or f"exit {result.returncode}"
        raise BenchError(f"command failed ({' '.join(args)}): {detail}")
    return result


def which_or_none(name: str) -> str | None:
    return shutil.which(name)


def require_linux_cgroup_v2() -> None:
    if sys.platform != "linux":
        raise BenchError("this harness requires Linux cgroup v2")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise BenchError("cgroup v2 not mounted at /sys/fs/cgroup")
    if which_or_none("systemctl") is None or which_or_none("systemd-run") is None:
        raise BenchError("systemd --user tools (systemctl, systemd-run) are required")
    probe = run_cmd(["systemctl", "--user", "is-system-running"], check=False)
    # degraded/running/starting are acceptable; offline is not
    state = (probe.stdout or "").strip()
    if probe.returncode not in (0, 1) and state not in {
        "running",
        "degraded",
        "starting",
        "maintenance",
    }:
        raise BenchError(f"systemd --user is unavailable (state={state!r})")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def host_metadata(repo_root: Path) -> dict[str, Any]:
    uname = os.uname()
    cpu_model = None
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except OSError:
        cpu_model = None

    rustc = run_cmd(["rustc", "--version"], check=False)
    rustc_version = (rustc.stdout or "").strip() if rustc.returncode == 0 else None

    commit = run_cmd(["git", "-C", str(repo_root), "rev-parse", "HEAD"], check=False)
    commit_sha = (commit.stdout or "").strip() if commit.returncode == 0 else None
    dirty = run_cmd(
        ["git", "-C", str(repo_root), "status", "--porcelain"],
        check=False,
    )
    dirty_tree = bool((dirty.stdout or "").strip()) if dirty.returncode == 0 else None

    return {
        "hostname": uname.nodename,
        "kernel": uname.release,
        "os": f"{uname.sysname} {uname.release} {uname.machine}",
        "machine": uname.machine,
        "cpu_model": cpu_model,
        "cpu_count": os.cpu_count(),
        "rustc_version": rustc_version,
        "git_commit": commit_sha,
        "git_dirty": dirty_tree,
    }


def binary_metadata(server: Path) -> dict[str, Any]:
    data = server.read_bytes()
    return {
        "path": str(server),
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def deterministic_token(run_id: str, sample_index: int) -> str:
    material = f"{PROTOCOL_NAME}:{run_id}:{sample_index}".encode()
    digest = hashlib.sha256(material).hexdigest()
    # load_or_create_token requires >= 64 characters.
    return digest + hashlib.sha256(digest.encode()).hexdigest()[:16]


def write_private_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    os.chmod(path, 0o600)


def prepare_profile(profile_dir: Path, token: str) -> None:
    if profile_dir.exists():
        shutil.rmtree(profile_dir)
    profile_dir.mkdir(mode=0o700, parents=True)
    os.chmod(profile_dir, 0o700)
    write_private_file(profile_dir / TOKEN_FILE, token + "\n")
    mode = profile_dir.stat().st_mode & 0o777
    if mode != 0o700:
        raise BenchError(f"profile mode is {oct(mode)}, expected 0o700")


def unit_property(unit: str, prop: str) -> str:
    result = run_cmd(
        ["systemctl", "--user", "show", unit, f"--property={prop}", "--value"],
        check=False,
    )
    if result.returncode != 0:
        raise BenchError(f"could not read {prop} from {unit}: {(result.stderr or '').strip()}")
    return (result.stdout or "").strip()


def parse_memory_bytes(raw: str) -> int | None:
    raw = raw.strip()
    if not raw or raw in {"[not set]", "n/a", "N/A"}:
        return None
    if raw == "18446744073709551615":  # uint64 max => unavailable
        return None
    try:
        value = int(raw)
    except ValueError as error:
        raise BenchError(f"invalid memory value {raw!r}") from error
    if value < 0:
        return None
    return value


def cgroup_paths(unit: str) -> Path:
    control_group = unit_property(unit, "ControlGroup")
    if not control_group:
        raise BenchError(f"{unit} has empty ControlGroup")
    path = Path("/sys/fs/cgroup") / control_group.lstrip("/")
    if not path.is_dir():
        raise BenchError(f"cgroup path missing: {path}")
    return path


def read_cgroup_memory(unit: str) -> dict[str, int]:
    # Prefer cgroupfs; fall back to systemd properties.
    current = peak = None
    try:
        cg = cgroup_paths(unit)
        current_raw = (cg / "memory.current").read_text(encoding="utf-8").strip()
        peak_path = cg / "memory.peak"
        peak_raw = peak_path.read_text(encoding="utf-8").strip() if peak_path.exists() else ""
        current = parse_memory_bytes(current_raw)
        peak = parse_memory_bytes(peak_raw) if peak_raw else None
    except BenchError:
        current = peak = None

    if current is None:
        current = parse_memory_bytes(unit_property(unit, "MemoryCurrent"))
    if peak is None:
        peak = parse_memory_bytes(unit_property(unit, "MemoryPeak"))

    if current is None:
        raise BenchError(f"MemoryCurrent unavailable for {unit}")
    if peak is None:
        # Some kernels omit peak; fail closed because protocol requires it.
        raise BenchError(f"MemoryPeak unavailable for {unit}")
    return {"current_bytes": current, "peak_bytes": peak}


def cgroup_pids(unit: str) -> list[int]:
    cg = cgroup_paths(unit)
    procs = (cg / "cgroup.procs").read_text(encoding="utf-8").split()
    return [int(pid) for pid in procs]


def read_proc_rss_pss(pid: int) -> dict[str, int]:
    status_path = Path(f"/proc/{pid}/status")
    if not status_path.exists():
        raise BenchError(f"process {pid} disappeared while reading RSS")
    rss_kb = None
    for line in status_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("VmRSS:"):
            rss_kb = int(line.split()[1])
            break
    if rss_kb is None:
        raise BenchError(f"VmRSS missing for pid {pid}")

    pss_kb = None
    rollup = Path(f"/proc/{pid}/smaps_rollup")
    if rollup.exists():
        for line in rollup.read_text(encoding="utf-8").splitlines():
            if line.startswith("Pss:"):
                pss_kb = int(line.split()[1])
                break
    if pss_kb is None:
        # Fall back to summing smaps when rollup is unavailable.
        smaps = Path(f"/proc/{pid}/smaps")
        if not smaps.exists():
            raise BenchError(f"PSS unavailable for pid {pid}")
        total = 0
        for line in smaps.read_text(encoding="utf-8").splitlines():
            if line.startswith("Pss:"):
                total += int(line.split()[1])
        pss_kb = total

    return {"rss_bytes": rss_kb * 1024, "pss_bytes": pss_kb * 1024}


def process_cmdline(pid: int) -> str:
    raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()


def process_comm(pid: int) -> str:
    return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()


def process_exe_name(pid: int) -> str:
    try:
        return os.path.basename(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        return process_comm(pid)


def assert_single_server_process(unit: str, server_path: Path) -> dict[str, Any]:
    pids = cgroup_pids(unit)
    if len(pids) != 1:
        details = []
        for pid in pids:
            details.append(
                {
                    "pid": pid,
                    "comm": process_comm(pid) if Path(f"/proc/{pid}").exists() else None,
                    "cmdline": process_cmdline(pid) if Path(f"/proc/{pid}").exists() else None,
                }
            )
        raise BenchError(
            f"expected exactly one process in {unit}, found {len(pids)}: {details}"
        )

    pid = pids[0]
    exe = process_exe_name(pid)
    cmdline = process_cmdline(pid)
    comm = process_comm(pid)
    server_name = server_path.name

    node_markers = ("node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright")
    blob = f"{exe} {comm} {cmdline}".lower()
    tokens = set(re.split(r"[^a-z0-9_.+-]+", blob))
    if tokens.intersection(node_markers):
        raise BenchError(f"Node/tooling process found in server cgroup: {cmdline!r}")

    if server_name not in exe and server_name not in cmdline and "junban-server" not in comm:
        raise BenchError(
            f"cgroup process does not look like junban-server (exe={exe!r}, cmdline={cmdline!r})"
        )

    # Server must not spawn Node children (descendants may briefly exist for other reasons).
    children = Path(f"/proc/{pid}/task/{pid}/children")
    if children.exists():
        child_pids = [int(x) for x in children.read_text(encoding="utf-8").split() if x]
        for child in child_pids:
            if not Path(f"/proc/{child}").exists():
                continue
            child_blob = f"{process_exe_name(child)} {process_cmdline(child)}".lower()
            child_tokens = set(re.split(r"[^a-z0-9_.+-]+", child_blob))
            if child_tokens.intersection(node_markers):
                raise BenchError(
                    f"server spawned Node descendant pid={child}: {child_blob!r}"
                )

    mem = read_proc_rss_pss(pid)
    return {
        "pid": pid,
        "exe": exe,
        "comm": comm,
        "cmdline": cmdline,
        "process_count": 1,
        **mem,
    }


def bytes_to_mib(value: int) -> float:
    return value / (1024.0 * 1024.0)


def sqlite_size_bytes(profile_dir: Path) -> dict[str, int]:
    total = 0
    parts: dict[str, int] = {}
    for name in (DATABASE_FILE, f"{DATABASE_FILE}-wal", f"{DATABASE_FILE}-shm"):
        path = profile_dir / name
        if path.exists():
            size = path.stat().st_size
            parts[name] = size
            total += size
    parts["total_bytes"] = total
    return parts


def wait_for_runtime(profile_dir: Path, timeout: float) -> dict[str, Any]:
    runtime_path = profile_dir / RUNTIME_FILE
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if runtime_path.exists():
            try:
                data = json.loads(read_text(runtime_path))
            except json.JSONDecodeError:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue
            if "address" in data and "pid" in data:
                return data
        time.sleep(POLL_INTERVAL_SECONDS)
    raise BenchError(f"runtime metadata not ready within {timeout}s: {runtime_path}")


def http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    expect_statuses: set[int] | None = None,
) -> tuple[int, Any, float]:
    expect_statuses = expect_statuses or {200, 201}
    data = None
    req_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            status = response.getcode()
            raw = response.read()
    except urllib.error.HTTPError as error:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        status = error.code
        raw = error.read()
    except urllib.error.URLError as error:
        raise BenchError(f"HTTP {method} {url} failed: {error}") from error

    if status not in expect_statuses:
        snippet = raw[:300].decode("utf-8", errors="replace")
        raise BenchError(f"HTTP {method} {url} returned {status}, body={snippet!r}")

    if not raw:
        payload: Any = None
    else:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise BenchError(f"malformed JSON from {method} {url}: {error}") from error
    return status, payload, elapsed_ms


def http_bytes(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    expect_statuses: set[int] | None = None,
) -> tuple[int, bytes, float]:
    expect_statuses = expect_statuses or {200}
    request = urllib.request.Request(url, headers=dict(headers or {}), method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            status = response.getcode()
            raw = response.read()
    except urllib.error.HTTPError as error:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        status = error.code
        raw = error.read()
    except urllib.error.URLError as error:
        raise BenchError(f"HTTP {method} {url} failed: {error}") from error
    if status not in expect_statuses:
        raise BenchError(f"HTTP {method} {url} returned {status}")
    return status, raw, elapsed_ms


def poll_health(base_url: str, host_header: str, timeout: float) -> float:
    deadline = time.monotonic() + timeout
    last_error: str | None = None
    started = time.perf_counter()
    while time.monotonic() < deadline:
        try:
            status, payload, _ = http_json(
                "GET",
                f"{base_url}/api/v1/health",
                headers={"Host": host_header},
                expect_statuses={200},
            )
            if status == 200 and isinstance(payload, dict) and payload.get("status"):
                return (time.perf_counter() - started) * 1000.0
            last_error = f"unexpected health payload: {payload!r}"
        except BenchError as error:
            last_error = str(error)
        time.sleep(POLL_INTERVAL_SECONDS)
    raise BenchError(f"health not ready within {timeout}s: {last_error}")


class ServerUnit:
    def __init__(
        self,
        *,
        unit_name: str,
        server: Path,
        profile_dir: Path,
        web_dir: Path,
        repo_root: Path,
    ) -> None:
        self.unit_name = unit_name
        self.unit = f"{unit_name}.service"
        self.server = server
        self.profile_dir = profile_dir
        self.web_dir = web_dir
        self.repo_root = repo_root
        self.started = False
        self.address: str | None = None
        self.base_url: str | None = None
        self.host_header: str | None = None
        self.origin: str | None = None
        self.main_pid: int | None = None

    def start(self) -> float:
        # Ephemeral loopback port; runtime.json carries the bound address.
        cmd = [
            "systemd-run",
            "--user",
            f"--unit={self.unit_name}",
            "--collect",
            "--property=MemoryAccounting=yes",
            "--property=Type=exec",
            f"--working-directory={self.repo_root}",
            "--",
            str(self.server),
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            str(self.profile_dir),
            "--web-dir",
            str(self.web_dir),
        ]
        launch_started = time.perf_counter()
        run_cmd(cmd)
        self.started = True

        runtime = wait_for_runtime(self.profile_dir, READY_TIMEOUT_SECONDS)
        address = runtime["address"]
        if isinstance(address, dict):
            # defensive: unexpected shape
            raise BenchError(f"unexpected runtime address shape: {address!r}")
        self.address = str(address)
        if not self.address.startswith("127.0.0.1:"):
            raise BenchError(f"server did not bind loopback: {self.address}")
        self.host_header = self.address
        self.base_url = f"http://{self.address}"
        self.origin = self.base_url
        self.main_pid = int(runtime["pid"])

        # Remaining startup-to-health wait after process is up.
        health_wait_ms = poll_health(self.base_url, self.host_header, READY_TIMEOUT_SECONDS)
        startup_to_health_ms = (time.perf_counter() - launch_started) * 1000.0
        # health_wait_ms is nested; total wall from launch is the protocol metric.
        _ = health_wait_ms
        return startup_to_health_ms

    def snapshot(self, label: str) -> dict[str, Any]:
        if not self.started:
            raise BenchError("server is not started")
        proc = assert_single_server_process(self.unit, self.server)
        cgroup = read_cgroup_memory(self.unit)
        main_pid = unit_property(self.unit, "MainPID")
        if main_pid and main_pid not in {"0", ""}:
            if int(main_pid) != proc["pid"]:
                raise BenchError(
                    f"MainPID {main_pid} != cgroup pid {proc['pid']} during {label}"
                )
        return {
            "label": label,
            "cgroup_current_bytes": cgroup["current_bytes"],
            "cgroup_peak_bytes": cgroup["peak_bytes"],
            "cgroup_current_mib": round(bytes_to_mib(cgroup["current_bytes"]), 4),
            "cgroup_peak_mib": round(bytes_to_mib(cgroup["peak_bytes"]), 4),
            "rss_bytes": proc["rss_bytes"],
            "pss_bytes": proc["pss_bytes"],
            "rss_mib": round(bytes_to_mib(proc["rss_bytes"]), 4),
            "pss_mib": round(bytes_to_mib(proc["pss_bytes"]), 4),
            "process_count": proc["process_count"],
            "pid": proc["pid"],
            "exe": proc["exe"],
            "cmdline": proc["cmdline"],
        }

    def stop(self) -> None:
        if not self.started:
            return
        stop = run_cmd(["systemctl", "--user", "stop", self.unit], check=False)
        deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            state = unit_property(self.unit, "ActiveState") if self._unit_exists() else "inactive"
            if state in {"inactive", "failed", "dead"} or not self._unit_exists():
                break
            time.sleep(POLL_INTERVAL_SECONDS)
        else:
            run_cmd(["systemctl", "--user", "kill", self.unit, "-s", "SIGKILL"], check=False)
            time.sleep(0.1)

        # Ensure no lingering unit.
        if self._unit_exists():
            state = unit_property(self.unit, "ActiveState")
            if state not in {"inactive", "failed", "dead"}:
                raise BenchError(f"unit {self.unit} still active after stop: {state}")
            # transient --collect should unload; force reset/stop if needed
            run_cmd(["systemctl", "--user", "reset-failed", self.unit], check=False)

        # Wait until fully gone or inactive with no MainPID.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if not self._unit_exists():
                break
            state = unit_property(self.unit, "ActiveState")
            main_pid = unit_property(self.unit, "MainPID")
            if state in {"inactive", "failed", "dead"} and main_pid in {"", "0"}:
                break
            time.sleep(POLL_INTERVAL_SECONDS)

        if self._unit_exists():
            state = unit_property(self.unit, "ActiveState")
            if state not in {"inactive", "failed", "dead"}:
                raise BenchError(f"lingering unit {self.unit}: ActiveState={state}")

        # runtime metadata should be removed by graceful shutdown.
        runtime_path = self.profile_dir / RUNTIME_FILE
        deadline = time.monotonic() + 5.0
        while runtime_path.exists() and time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL_SECONDS)

        self.started = False
        if stop.returncode not in (0,):
            # stop may return non-zero if already dead; only fail if process still lives.
            if self.main_pid and Path(f"/proc/{self.main_pid}").exists():
                raise BenchError(f"server pid {self.main_pid} still alive after stop")

    def _unit_exists(self) -> bool:
        result = run_cmd(
            ["systemctl", "--user", "show", self.unit, "--property=LoadState", "--value"],
            check=False,
        )
        if result.returncode != 0:
            return False
        return (result.stdout or "").strip() not in {"", "not-found"}


def auth_headers(token: str, host_header: str, origin: str | None, mutation: bool) -> dict[str, str]:
    headers = {
        "Host": host_header,
        "Authorization": f"Bearer {token}",
    }
    if mutation:
        if origin is None:
            raise BenchError("origin required for mutations")
        headers["Origin"] = origin
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return headers


def run_workload(
    *,
    base_url: str,
    host_header: str,
    origin: str,
    token: str,
    task_count: int,
    mutation_cycles: int,
    static_reads: int,
    list_reads: int,
) -> dict[str, Any]:
    buckets = {
        "static_read": LatencyBucket(),
        "create": LatencyBucket(),
        "list": LatencyBucket(),
        "replace": LatencyBucket(),
        "complete": LatencyBucket(),
        "uncomplete": LatencyBucket(),
        "delete": LatencyBucket(),
    }
    task_ids: list[str] = []

    for index in range(static_reads):
        # Root shell plus a second static path keeps SPA serving on the path.
        path = "/" if index % 2 == 0 else "/index.html"
        _, body, elapsed = http_bytes(
            "GET",
            f"{base_url}{path}",
            headers={"Host": host_header},
            expect_statuses={200},
        )
        if not body:
            raise BenchError(f"empty static body for {path}")
        buckets["static_read"].add(elapsed)

    for index in range(task_count):
        status, payload, elapsed = http_json(
            "POST",
            f"{base_url}/api/v1/tasks",
            headers=auth_headers(token, host_header, origin, mutation=True),
            body={"title": f"bench-task-{index:04d}", "due_date": None},
            expect_statuses={201},
        )
        if status != 201 or not isinstance(payload, dict):
            raise BenchError(f"create failed: status={status} payload={payload!r}")
        task = payload.get("task")
        if not isinstance(task, dict) or not task.get("id"):
            raise BenchError(f"create response missing task.id: {payload!r}")
        task_ids.append(str(task["id"]))
        buckets["create"].add(elapsed)

    for _ in range(list_reads):
        status, payload, elapsed = http_json(
            "GET",
            f"{base_url}/api/v1/tasks",
            headers=auth_headers(token, host_header, origin, mutation=False),
            expect_statuses={200},
        )
        if not isinstance(payload, dict) or "tasks" not in payload:
            raise BenchError(f"list response malformed: {payload!r}")
        if len(payload["tasks"]) < task_count:
            raise BenchError(
                f"list returned {len(payload['tasks'])} tasks, expected >= {task_count}"
            )
        buckets["list"].add(elapsed)

    cycles = min(mutation_cycles, len(task_ids))
    for index in range(cycles):
        task_id = task_ids[index]

        _, payload, elapsed = http_json(
            "PUT",
            f"{base_url}/api/v1/tasks/{task_id}",
            headers=auth_headers(token, host_header, origin, mutation=True),
            body={"title": f"bench-task-{index:04d}-updated", "due_date": None},
            expect_statuses={200},
        )
        if not isinstance(payload, dict) or not payload.get("task"):
            raise BenchError(f"replace response malformed: {payload!r}")
        buckets["replace"].add(elapsed)

        _, payload, elapsed = http_json(
            "POST",
            f"{base_url}/api/v1/tasks/{task_id}/complete",
            headers=auth_headers(token, host_header, origin, mutation=True),
            expect_statuses={200},
        )
        if not isinstance(payload, dict) or not payload.get("task"):
            raise BenchError(f"complete response malformed: {payload!r}")
        buckets["complete"].add(elapsed)

        _, payload, elapsed = http_json(
            "POST",
            f"{base_url}/api/v1/tasks/{task_id}/uncomplete",
            headers=auth_headers(token, host_header, origin, mutation=True),
            expect_statuses={200},
        )
        if not isinstance(payload, dict) or not payload.get("task"):
            raise BenchError(f"uncomplete response malformed: {payload!r}")
        buckets["uncomplete"].add(elapsed)

        _, payload, elapsed = http_json(
            "DELETE",
            f"{base_url}/api/v1/tasks/{task_id}",
            headers=auth_headers(token, host_header, origin, mutation=True),
            expect_statuses={200},
        )
        if not isinstance(payload, dict) or "event" not in payload:
            raise BenchError(f"delete response malformed: {payload!r}")
        buckets["delete"].add(elapsed)

    # Final list confirms API still healthy after mutations.
    _, payload, elapsed = http_json(
        "GET",
        f"{base_url}/api/v1/tasks",
        headers=auth_headers(token, host_header, origin, mutation=False),
        expect_statuses={200},
    )
    buckets["list"].add(elapsed)
    remaining = task_count - cycles
    if not isinstance(payload, dict) or len(payload.get("tasks", [])) != remaining:
        raise BenchError(
            f"post-mutation list size {len(payload.get('tasks', []))} != expected {remaining}"
        )

    return {
        "task_count": task_count,
        "mutation_cycles": cycles,
        "static_reads": static_reads,
        "list_reads": list_reads + 1,
        "latencies": {name: bucket.summary() for name, bucket in buckets.items()},
    }


def series_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        raise BenchError("empty metric series")
    ordered = sorted(values)
    return {
        "median": median(ordered),
        "min": ordered[0],
        "max": ordered[-1],
        "values": values,
    }


def run_sample(
    *,
    sample_index: int,
    run_id: str,
    repo_root: Path,
    server: Path,
    web_dir: Path,
    work_root: Path,
    task_count: int,
    mutation_cycles: int,
    static_reads: int,
    list_reads: int,
    settle_seconds: float,
) -> dict[str, Any]:
    profile_dir = work_root / f"profile-{sample_index:02d}"
    token = deterministic_token(run_id, sample_index)
    prepare_profile(profile_dir, token)

    unit_name = f"junban-bench-{run_id}-s{sample_index:02d}"
    # systemd unit names should be modest length
    unit_name = unit_name[:180]
    server_unit = ServerUnit(
        unit_name=unit_name,
        server=server,
        profile_dir=profile_dir,
        web_dir=web_dir,
        repo_root=repo_root,
    )

    cleanup_ok = False
    try:
        startup_to_health_ms = server_unit.start()
        # Documented settle only; no other fixed sleeps in the protocol path.
        time.sleep(settle_seconds)
        idle = server_unit.snapshot("idle")

        assert server_unit.base_url and server_unit.host_header and server_unit.origin
        workload = run_workload(
            base_url=server_unit.base_url,
            host_header=server_unit.host_header,
            origin=server_unit.origin,
            token=token,
            task_count=task_count,
            mutation_cycles=mutation_cycles,
            static_reads=static_reads,
            list_reads=list_reads,
        )
        warm = server_unit.snapshot("warm")
        db_sizes = sqlite_size_bytes(profile_dir)

        server_unit.stop()
        # Profile removal proves lock release and no lingering files from unit.
        shutil.rmtree(profile_dir)
        cleanup_ok = True

        return {
            "sample_index": sample_index,
            "startup_to_health_ms": startup_to_health_ms,
            "settle_seconds": settle_seconds,
            "idle": idle,
            "warm": warm,
            "workload": workload,
            "sqlite": db_sizes,
            "cleanup_success": cleanup_ok,
            "unit": server_unit.unit,
        }
    except Exception:
        try:
            server_unit.stop()
        except BenchError:
            pass
        if profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)
        raise
    finally:
        if not cleanup_ok and profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)


def build_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(path: list[str]) -> list[float]:
        values: list[float] = []
        for sample in samples:
            cursor: Any = sample
            for key in path:
                cursor = cursor[key]
            values.append(float(cursor))
        return values

    latency_names = [
        "static_read",
        "create",
        "list",
        "replace",
        "complete",
        "uncomplete",
        "delete",
    ]
    latency_summary: dict[str, Any] = {}
    for name in latency_names:
        pooled: list[float] = []
        per_sample_p50: list[float] = []
        per_sample_p95: list[float] = []
        for sample in samples:
            lat = sample["workload"]["latencies"][name]
            pooled.extend(lat["values_ms"])
            per_sample_p50.append(lat["p50_ms"])
            per_sample_p95.append(lat["p95_ms"])
        ordered = sorted(pooled)
        latency_summary[name] = {
            "pooled_p50_ms": percentile(ordered, 50),
            "pooled_p95_ms": percentile(ordered, 95),
            "per_sample_p50_ms": series_summary(per_sample_p50),
            "per_sample_p95_ms": series_summary(per_sample_p95),
            "count": len(ordered),
        }

    return {
        "sample_count": len(samples),
        "startup_to_health_ms": series_summary(collect(["startup_to_health_ms"])),
        "idle_cgroup_mib": series_summary(collect(["idle", "cgroup_current_mib"])),
        "idle_cgroup_peak_mib": series_summary(collect(["idle", "cgroup_peak_mib"])),
        "idle_rss_mib": series_summary(collect(["idle", "rss_mib"])),
        "idle_pss_mib": series_summary(collect(["idle", "pss_mib"])),
        "warm_cgroup_mib": series_summary(collect(["warm", "cgroup_current_mib"])),
        "warm_cgroup_peak_mib": series_summary(collect(["warm", "cgroup_peak_mib"])),
        "warm_rss_mib": series_summary(collect(["warm", "rss_mib"])),
        "warm_pss_mib": series_summary(collect(["warm", "pss_mib"])),
        "sqlite_total_bytes": series_summary(
            [float(sample["sqlite"]["total_bytes"]) for sample in samples]
        ),
        "latencies_ms": latency_summary,
        # Populated by the main agent after authoritative evidence — not by this harness.
        "memory_ceiling_mib": None,
        "variance_rule": None,
        "regression_rule": None,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Junban Phase 1 hosted-server benchmark harness",
    )
    parser.add_argument(
        "--server",
        type=Path,
        default=Path("target/release/junban-server"),
        help="Path to optimized junban-server binary",
    )
    parser.add_argument(
        "--web-dir",
        type=Path,
        default=Path("dist"),
        help="Production frontend dist directory",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=None,
        help=f"Independent fresh-profile samples (default {DEFAULT_SAMPLES})",
    )
    parser.add_argument(
        "--tasks",
        type=int,
        default=None,
        help=f"Ordinary create count (default {DEFAULT_TASK_COUNT})",
    )
    parser.add_argument(
        "--mutation-cycles",
        type=int,
        default=None,
        help=f"replace/complete/uncomplete/delete cycles (default {DEFAULT_MUTATION_CYCLES})",
    )
    parser.add_argument(
        "--static-reads",
        type=int,
        default=None,
        help=f"Static shell reads (default {DEFAULT_STATIC_READS})",
    )
    parser.add_argument(
        "--list-reads",
        type=int,
        default=None,
        help=f"Authenticated list reads before mutations (default {DEFAULT_LIST_READS})",
    )
    parser.add_argument(
        "--settle-seconds",
        type=float,
        default=DEFAULT_SETTLE_SECONDS,
        help=f"Post-ready idle settle window seconds (default {DEFAULT_SETTLE_SECONDS})",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Non-authoritative dry run: 1 sample and fewer tasks",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Write machine-readable JSON report to this path",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="Repository root (default: parent of scripts/)",
    )
    return parser.parse_args(argv)


def resolve_protocol(args: argparse.Namespace) -> dict[str, Any]:
    if args.quick:
        samples = args.samples if args.samples is not None else 1
        tasks = args.tasks if args.tasks is not None else 10
        mutation_cycles = args.mutation_cycles if args.mutation_cycles is not None else 5
        static_reads = args.static_reads if args.static_reads is not None else 5
        list_reads = args.list_reads if args.list_reads is not None else 5
        authoritative = False
    else:
        samples = args.samples if args.samples is not None else DEFAULT_SAMPLES
        tasks = args.tasks if args.tasks is not None else DEFAULT_TASK_COUNT
        mutation_cycles = (
            args.mutation_cycles if args.mutation_cycles is not None else DEFAULT_MUTATION_CYCLES
        )
        static_reads = args.static_reads if args.static_reads is not None else DEFAULT_STATIC_READS
        list_reads = args.list_reads if args.list_reads is not None else DEFAULT_LIST_READS
        authoritative = (
            samples == DEFAULT_SAMPLES
            and tasks == DEFAULT_TASK_COUNT
            and mutation_cycles == DEFAULT_MUTATION_CYCLES
            and static_reads == DEFAULT_STATIC_READS
            and list_reads == DEFAULT_LIST_READS
            and not args.quick
        )

    if samples < 1 or tasks < 1 or mutation_cycles < 1:
        raise BenchError("samples, tasks, and mutation-cycles must be >= 1")
    if mutation_cycles > tasks:
        raise BenchError("mutation-cycles cannot exceed tasks")
    if args.settle_seconds < 0:
        raise BenchError("settle-seconds must be >= 0")

    return {
        "name": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "authoritative": authoritative,
        "quick": bool(args.quick),
        "samples": samples,
        "task_count": tasks,
        "mutation_cycles": mutation_cycles,
        "static_reads": static_reads,
        "list_reads": list_reads,
        "settle_seconds": args.settle_seconds,
        "bind": "127.0.0.1:0",
        "profile_mode": "0700",
        "token": "deterministic per sample, pre-written owner-only access-token",
        "cgroup": "transient systemd --user service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "task_count_justification": (
            f"{DEFAULT_TASK_COUNT} ordinary creates approximate a personal warm working set "
            "large enough to exercise SQLite pages and list serialization without overlapping "
            "Phase 2's 10_000-task large fixture."
        ),
        "memory_ceiling_mib": None,
        "variance_rule": None,
        "regression_rule": None,
        "notes": [
            "Optimized release junban-server + production dist only.",
            "Fail closed on non-2xx, malformed JSON, process-count != 1, missing metrics, lingering unit, or cleanup failure.",
            "Do not freeze quick-mode results as Phase 1 evidence.",
            "Main agent freezes ceiling/variance/regression after full 5-sample authoritative run.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (args.repo_root or Path(__file__).resolve().parent.parent).resolve()
    server = args.server if args.server.is_absolute() else (repo_root / args.server)
    web_dir = args.web_dir if args.web_dir.is_absolute() else (repo_root / args.web_dir)
    server = server.resolve()
    web_dir = web_dir.resolve()

    try:
        require_linux_cgroup_v2()
        if not server.is_file():
            raise BenchError(f"server binary not found: {server}")
        if not os.access(server, os.X_OK):
            raise BenchError(f"server binary not executable: {server}")
        if not web_dir.is_dir():
            raise BenchError(f"web-dir not found: {web_dir}")
        if not (web_dir / "index.html").is_file():
            raise BenchError(f"web-dir missing index.html: {web_dir}")

        protocol = resolve_protocol(args)
        run_id = uuid.uuid4().hex[:12]
        host = host_metadata(repo_root)
        binary = binary_metadata(server)

        work_root = Path(tempfile.mkdtemp(prefix=f"junban-bench-{run_id}-", dir="/tmp"))
        os.chmod(work_root, 0o700)

        samples: list[dict[str, Any]] = []
        try:
            for sample_index in range(protocol["samples"]):
                sample = run_sample(
                    sample_index=sample_index,
                    run_id=run_id,
                    repo_root=repo_root,
                    server=server,
                    web_dir=web_dir,
                    work_root=work_root,
                    task_count=protocol["task_count"],
                    mutation_cycles=protocol["mutation_cycles"],
                    static_reads=protocol["static_reads"],
                    list_reads=protocol["list_reads"],
                    settle_seconds=protocol["settle_seconds"],
                )
                samples.append(sample)
                idle_mib = sample["idle"]["cgroup_current_mib"]
                warm_mib = sample["warm"]["cgroup_current_mib"]
                print(
                    f"sample {sample_index}: startup={sample['startup_to_health_ms']:.1f}ms "
                    f"idle={idle_mib:.2f}MiB warm={warm_mib:.2f}MiB "
                    f"peak={sample['warm']['cgroup_peak_mib']:.2f}MiB",
                    file=sys.stderr,
                )
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

        summary = build_summary(samples)
        report = {
            "protocol": protocol,
            "run_id": run_id,
            "host": host,
            "binary": binary,
            "web_dir": str(web_dir),
            "command": {
                "argv": [str(Path(__file__).name), *map(str, sys.argv[1:])],
                "cwd": str(Path.cwd()),
            },
            "samples": samples,
            "summary": summary,
            "evidence_status": (
                "authoritative_candidate"
                if protocol["authoritative"]
                else "non_authoritative_dry_run"
            ),
        }

        text = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.output:
            output = args.output if args.output.is_absolute() else (repo_root / args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text, encoding="utf-8")
            print(f"wrote {output}", file=sys.stderr)
        sys.stdout.write(text)
        return 0
    except BenchError as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Ensure Ctrl-C tears down child units promptly when possible.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.exit(main())
