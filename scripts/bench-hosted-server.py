#!/usr/bin/env python3
"""Junban hosted-server benchmark harness (Phase 1 memory + Phase 2 scale).

Optimized junban-server only, inside a transient systemd --user cgroup.

Phase 1 (default --mode phase1):
  Authoritative: 5 samples / 100 tasks / 20 cycles. --quick: 1 / 10 / 5 (not evidence).

Phase 2 scale (--mode scale):
  Authoritative: 3 samples / 10_000 pre-seeded tasks. --quick: 1 / 500 (harness only).
  Seeder runs outside the measured cgroup via junban-scale-seed.

CLI: --mode, --server, --web-dir, --seeder, --output, --quick.
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import queue
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

# ── Phase 1 protocol (frozen; do not change knobs) ──────────────────────────
PROTOCOL_NAME = "junban-phase1-hosted-server-v1"
PROTOCOL_VERSION = 1
SAMPLES, TASK_COUNT, MUTATION_CYCLES, STATIC_READS, LIST_READS = 5, 100, 20, 20, 20
QUICK_SAMPLES, QUICK_TASKS, QUICK_CYCLES, QUICK_STATIC, QUICK_LIST = 1, 10, 5, 5, 5

# ── Phase 2 scale protocol ──────────────────────────────────────────────────
SCALE_PROTOCOL_NAME = "junban-phase2-scale-v1"
SCALE_PROTOCOL_VERSION = 1
SCALE_SAMPLES, SCALE_TASK_COUNT = 3, 10_000
SCALE_QUICK_SAMPLES, SCALE_QUICK_TASK_COUNT = 1, 500
SCALE_PAGE_LIMIT = 100
SCALE_LIST_VIEW_P95_MS = 75.0
SCALE_SEARCH_FILTER_P95_MS = 100.0
SCALE_SINGLE_MUTATION_P95_MS = 75.0
SCALE_BULK_REORDER_P95_MS = 150.0
SCALE_PARTIAL_UPDATES = 50
SCALE_COMPLETE_PAIRS = 50
SCALE_BULK_BATCHES = 20
SCALE_BULK_BATCH_SIZE = 25
SCALE_REORDER_BATCHES = 20
SCALE_REORDER_BATCH_SIZE = 25

# ── Phase 3 temporal protocol ───────────────────────────────────────────────
TEMPORAL_PROTOCOL_NAME = "junban-phase3-temporal-v1"
TEMPORAL_PROTOCOL_VERSION = 1
TEMPORAL_SAMPLES, TEMPORAL_TASK_COUNT = 5, 10_000
TEMPORAL_QUICK_SAMPLES, TEMPORAL_QUICK_TASK_COUNT = 1, 500
TEMPORAL_BULK_SOURCES = 250
TEMPORAL_QUICK_BULK_SOURCES = 25
TEMPORAL_REMINDER_CLAIMS = 20
TEMPORAL_QUICK_REMINDER_CLAIMS = 5
TEMPORAL_BUDGETS_MS = {
    "calendar_42_day": 100.0,
    "timeblocking_42_day": 100.0,
    "stats_366_day": 150.0,
    "recurrence_complete": 100.0,
    "bulk_recurrence_complete": 1_000.0,
    "bulk_recurrence_uncomplete": 1_000.0,
    "nudges": 100.0,
    "reminder_lease_claim_20": 50.0,
}

# Only intentional fixed sleep; readiness/shutdown are condition-polled.
SETTLE_SECONDS = 2.0
READY_TIMEOUT_SECONDS = 15.0
STOP_TIMEOUT_SECONDS = 15.0
POLL_INTERVAL_SECONDS = 0.025
TOKEN_FILE, RUNTIME_FILE, DATABASE_FILE = "access-token", "runtime.json", "junban.sqlite3"
SEED_MANIFEST_FILE = "scale-seed-manifest.json"
NODE_MARKERS = frozenset({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})
LATENCY_OPS = ("static_read", "create", "list", "replace", "complete", "uncomplete", "delete")
SCALE_LIST_VIEW_OPS = (
    "list_unfiltered",
    "view_inbox",
    "view_today",
    "view_project",
)
SCALE_SEARCH_FILTER_OPS = (
    "search_hit",
    "search_miss",
    "filter_tag_priority",
    "filter_due_range",
    "filter_project_section",
)
SCALE_SINGLE_MUTATION_OPS = (
    "partial_update",
    "complete",
    "uncomplete",
)
SCALE_BULK_REORDER_OPS = (
    "bulk_25",
    "reorder_25",
)
SCALE_NEAR_CAP_OPS = (
    "near_cap_complete",
    "near_cap_complete_undo",
    "near_cap_delete",
    "near_cap_delete_undo",
)
SCALE_LATENCY_OPS = (
    SCALE_LIST_VIEW_OPS
    + SCALE_SEARCH_FILTER_OPS
    + SCALE_SINGLE_MUTATION_OPS
    + SCALE_BULK_REORDER_OPS
    + SCALE_NEAR_CAP_OPS
)
TEMPORAL_LATENCY_OPS = (
    "calendar_42_day",
    "timeblock_create",
    "timeblock_range_42_day",
    "timeslot_create",
    "timeslot_range",
    "planning_daily",
    "planning_weekly",
    "stats_366_day",
    "nudges",
    "recurrence_complete",
    "recurrence_uncomplete",
    "bulk_recurrence_complete",
    "bulk_recurrence_uncomplete",
    "reminder_schedule",
    "reminder_lease_acquire",
    "reminder_claim_20",
    "reminder_lease_claim_20",
    "reminder_settle_delivered",
    "reminder_claim_empty",
    "reminder_lease_release",
)
WARM_MEMORY_CEILING_MIB = 24.0
PEAK_MEMORY_CEILING_MIB = 32.0
VARIANCE_RULE = (
    "same-commit warm median must remain within the larger of 15% or 1 MiB; "
    "otherwise repeat on an idle host and retain both reports"
)
REGRESSION_RULE = (
    "a per-phase warm-median increase above the larger of 20% or 2 MiB requires "
    "measured explanation and explicit acceptance; final 24/32 MiB ceilings cannot be waived"
)
SUMMARY_PATHS = {
    "startup_to_health_ms": ("startup_to_health_ms",),
    "idle_cgroup_mib": ("idle", "cgroup_current_mib"),
    "idle_cgroup_peak_mib": ("idle", "cgroup_peak_mib"),
    "idle_rss_mib": ("idle", "rss_mib"),
    "idle_pss_mib": ("idle", "pss_mib"),
    "warm_cgroup_mib": ("warm", "cgroup_current_mib"),
    "warm_cgroup_peak_mib": ("warm", "cgroup_peak_mib"),
    "warm_rss_mib": ("warm", "rss_mib"),
    "warm_pss_mib": ("warm", "pss_mib"),
}

class BenchError(RuntimeError):
    """Fail-closed benchmark error."""

def percentile(ordered: list[float], pct: float) -> float:
    if not ordered:
        raise BenchError("cannot compute percentile of empty series")
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    low, high = int(rank), min(int(rank) + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight

def latency_summary(values_ms: list[float]) -> dict[str, Any]:
    if not values_ms:
        raise BenchError("missing latency samples")
    ordered = sorted(values_ms)
    return {
        "count": len(ordered), "p50_ms": percentile(ordered, 50), "p95_ms": percentile(ordered, 95),
        "min_ms": ordered[0], "max_ms": ordered[-1], "values_ms": ordered,
    }

def series_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        raise BenchError("empty metric series")
    ordered = sorted(values)
    return {"median": statistics.median(ordered), "min": ordered[0], "max": ordered[-1], "values": values}

def run_cmd(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise BenchError(f"command failed ({' '.join(args)}): {detail}")
    return result

def poll_until(timeout: float, done: Callable[[], bool], error: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if done():
            return
        time.sleep(POLL_INTERVAL_SECONDS)
    raise BenchError(error)

def require_linux_cgroup_v2() -> None:
    if sys.platform != "linux":
        raise BenchError("this harness requires Linux cgroup v2")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise BenchError("cgroup v2 not mounted at /sys/fs/cgroup")
    if shutil.which("systemctl") is None or shutil.which("systemd-run") is None:
        raise BenchError("systemd --user tools (systemctl, systemd-run) are required")
    probe = run_cmd(["systemctl", "--user", "is-system-running"], check=False)
    state = (probe.stdout or "").strip()
    if probe.returncode not in (0, 1) and state not in {"running", "degraded", "starting", "maintenance"}:
        raise BenchError(f"systemd --user is unavailable (state={state!r})")

def host_metadata(repo_root: Path) -> dict[str, Any]:
    uname = os.uname()
    cpu_model = None
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    rustc = run_cmd(["rustc", "--version"], check=False)
    commit = run_cmd(["git", "-C", str(repo_root), "rev-parse", "HEAD"], check=False)
    dirty = run_cmd(["git", "-C", str(repo_root), "status", "--porcelain"], check=False)
    return {
        "hostname": uname.nodename, "kernel": uname.release,
        "os": f"{uname.sysname} {uname.release} {uname.machine}", "machine": uname.machine,
        "cpu_model": cpu_model, "cpu_count": os.cpu_count(),
        "rustc_version": (rustc.stdout or "").strip() if rustc.returncode == 0 else None,
        "git_commit": (commit.stdout or "").strip() if commit.returncode == 0 else None,
        "git_dirty": bool((dirty.stdout or "").strip()) if dirty.returncode == 0 else None,
    }

def binary_metadata(server: Path) -> dict[str, Any]:
    data = server.read_bytes()
    return {"path": str(server), "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def prepare_profile(profile_dir: Path, token: str) -> None:
    if profile_dir.exists():
        shutil.rmtree(profile_dir)
    profile_dir.mkdir(mode=0o700, parents=True)
    os.chmod(profile_dir, 0o700)
    token_path = profile_dir / TOKEN_FILE
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    os.chmod(token_path, 0o600)
    if profile_dir.stat().st_mode & 0o777 != 0o700:
        raise BenchError(f"profile mode is not 0o700: {profile_dir}")

def unit_property(unit: str, prop: str) -> str:
    result = run_cmd(
        ["systemctl", "--user", "show", unit, f"--property={prop}", "--value"], check=False,
    )
    if result.returncode != 0:
        raise BenchError(f"could not read {prop} from {unit}")
    return (result.stdout or "").strip()

def unit_exists(unit: str) -> bool:
    try:
        return unit_property(unit, "LoadState") not in {"", "not-found"}
    except BenchError:
        return False

def cgroup_path(unit: str) -> Path:
    control_group = unit_property(unit, "ControlGroup")
    if not control_group:
        raise BenchError(f"{unit} has empty ControlGroup")
    path = Path("/sys/fs/cgroup") / control_group.lstrip("/")
    if not path.is_dir():
        raise BenchError(f"cgroup path missing: {path}")
    return path

def read_cgroup_memory(unit: str) -> dict[str, int]:
    cg = cgroup_path(unit)
    try:
        current = int((cg / "memory.current").read_text(encoding="utf-8").strip())
        peak = int((cg / "memory.peak").read_text(encoding="utf-8").strip())
    except (OSError, ValueError) as error:
        raise BenchError(f"cgroup memory unavailable for {unit}: {error}") from error
    if current < 0 or peak < 0:
        raise BenchError(f"invalid cgroup memory for {unit}")
    return {"current_bytes": current, "peak_bytes": peak}

def read_proc_rss_pss(pid: int) -> dict[str, int]:
    try:
        status = Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
        rollup = Path(f"/proc/{pid}/smaps_rollup").read_text(encoding="utf-8")
    except OSError as error:
        raise BenchError(f"proc memory unavailable for pid {pid}: {error}") from error
    rss_kb = next((int(l.split()[1]) for l in status.splitlines() if l.startswith("VmRSS:")), None)
    pss_kb = next((int(l.split()[1]) for l in rollup.splitlines() if l.startswith("Pss:")), None)
    if rss_kb is None or pss_kb is None:
        raise BenchError(f"VmRSS/Pss missing for pid {pid}")
    return {"rss_bytes": rss_kb * 1024, "pss_bytes": pss_kb * 1024}

def proc_field(pid: int, name: str) -> str:
    if name == "cmdline":
        return (
            Path(f"/proc/{pid}/cmdline")
            .read_bytes()
            .replace(b"\x00", b" ")
            .decode("utf-8", errors="replace")
            .strip()
        )
    if name == "exe":
        try:
            return os.path.basename(os.readlink(f"/proc/{pid}/exe"))
        except OSError:
            name = "comm"
    return Path(f"/proc/{pid}/{name}").read_text(encoding="utf-8").strip()

def assert_single_server_process(unit: str, server_path: Path) -> dict[str, Any]:
    pids = [int(p) for p in (cgroup_path(unit) / "cgroup.procs").read_text().split()]
    if len(pids) != 1:
        raise BenchError(f"expected exactly one process in {unit}, found {len(pids)}: {pids}")
    pid = pids[0]
    exe, cmdline, comm = proc_field(pid, "exe"), proc_field(pid, "cmdline"), proc_field(pid, "comm")
    blob = f"{exe} {comm} {cmdline}".lower()
    if set(re.split(r"[^a-z0-9_.+-]+", blob)).intersection(NODE_MARKERS):
        raise BenchError(f"Node/tooling process found in server cgroup: {cmdline!r}")
    name = server_path.name
    if name not in exe and name not in cmdline and "junban-server" not in comm:
        raise BenchError(f"cgroup process is not junban-server (exe={exe!r}, cmdline={cmdline!r})")
    children = Path(f"/proc/{pid}/task/{pid}/children")
    if children.exists():
        for child in [int(x) for x in children.read_text().split() if x]:
            if not Path(f"/proc/{child}").exists():
                continue
            child_blob = f"{proc_field(child, 'exe')} {proc_field(child, 'cmdline')}".lower()
            if set(re.split(r"[^a-z0-9_.+-]+", child_blob)).intersection(NODE_MARKERS):
                raise BenchError(f"server spawned Node descendant pid={child}")
    return {
        "pid": pid, "exe": exe, "comm": comm, "cmdline": cmdline, "process_count": 1,
        **read_proc_rss_pss(pid),
    }

def sqlite_size_bytes(profile_dir: Path) -> dict[str, int]:
    parts: dict[str, int] = {"total_bytes": 0}
    for name in (DATABASE_FILE, f"{DATABASE_FILE}-wal", f"{DATABASE_FILE}-shm"):
        path = profile_dir / name
        if path.exists():
            size = path.stat().st_size
            parts[name] = size
            parts["total_bytes"] += size
    return parts

def http_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    expect_statuses: set[int],
    as_json: bool,
) -> tuple[Any, float]:
    data, req_headers = None, dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            status, raw = response.getcode(), response.read()
    except urllib.error.HTTPError as error:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        status, raw = error.code, error.read()
    except urllib.error.URLError as error:
        raise BenchError(f"HTTP {method} {url} failed: {error}") from error
    if status not in expect_statuses:
        snippet = raw[:300].decode("utf-8", errors="replace")
        raise BenchError(f"HTTP {method} {url} returned {status}, body={snippet!r}")
    if not as_json:
        return raw, elapsed_ms
    if not raw:
        return None, elapsed_ms
    try:
        return json.loads(raw.decode("utf-8")), elapsed_ms
    except json.JSONDecodeError as error:
        raise BenchError(f"malformed JSON from {method} {url}: {error}") from error

def auth_headers(token: str, host: str, origin: str, *, mutation: bool) -> dict[str, str]:
    headers = {"Host": host, "Authorization": f"Bearer {token}"}
    if mutation:
        headers["Origin"] = origin
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return headers

def start_server(
    unit_name: str, server: Path, profile_dir: Path, web_dir: Path, repo_root: Path,
) -> tuple[str, str, float]:
    t0 = time.perf_counter()
    run_cmd([
        "systemd-run", "--user", f"--unit={unit_name}", "--collect",
        "--property=MemoryAccounting=yes", "--property=Type=exec",
        f"--working-directory={repo_root}", "--",
        str(server), "--bind", "127.0.0.1:0",
        "--data-dir", str(profile_dir), "--web-dir", str(web_dir),
    ])
    runtime_path = profile_dir / RUNTIME_FILE
    holder: dict[str, Any] = {}
    def runtime_ready() -> bool:
        if not runtime_path.exists():
            return False
        try:
            data = json.loads(runtime_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        ok = "address" in data and "pid" in data
        if ok:
            holder["runtime"] = data
        return ok
    poll_until(READY_TIMEOUT_SECONDS, runtime_ready, "runtime.json not ready")
    address = str(holder["runtime"]["address"])
    if not address.startswith("127.0.0.1:"):
        raise BenchError(f"server did not bind loopback: {address}")
    base_url = f"http://{address}"
    last = "no attempt"
    def health_ready() -> bool:
        nonlocal last
        try:
            payload, _ = http_request(
                "GET", f"{base_url}/api/v1/health",
                headers={"Host": address}, expect_statuses={200}, as_json=True,
            )
            if isinstance(payload, dict) and payload.get("status"):
                return True
            last = f"unexpected health payload: {payload!r}"
        except BenchError as error:
            last = str(error)
        return False
    poll_until(READY_TIMEOUT_SECONDS, health_ready, f"health not ready: {last}")
    return base_url, address, (time.perf_counter() - t0) * 1000.0

def stop_server(unit_name: str, profile_dir: Path) -> None:
    unit = f"{unit_name}.service"
    if not unit_exists(unit):
        return
    run_cmd(["systemctl", "--user", "stop", unit], check=False)
    def stopped() -> bool:
        if not unit_exists(unit):
            return True
        state = unit_property(unit, "ActiveState")
        return state in {"inactive", "failed", "dead"} and unit_property(unit, "MainPID") in {"", "0"}
    try:
        poll_until(STOP_TIMEOUT_SECONDS, stopped, f"unit {unit} did not stop")
    except BenchError:
        run_cmd(["systemctl", "--user", "kill", unit, "-s", "SIGKILL"], check=False)
        time.sleep(0.1)
        poll_until(5.0, stopped, f"lingering unit {unit}")
    if unit_exists(unit):
        state = unit_property(unit, "ActiveState")
        if state not in {"inactive", "failed", "dead"}:
            raise BenchError(f"lingering unit {unit}: ActiveState={state}")
        run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)
    runtime_path = profile_dir / RUNTIME_FILE
    try:
        poll_until(5.0, lambda: not runtime_path.exists(), "runtime.json linger")
    except BenchError:
        pass

def memory_snapshot(unit_name: str, server: Path, label: str) -> dict[str, Any]:
    unit = f"{unit_name}.service"
    proc = assert_single_server_process(unit, server)
    cg = read_cgroup_memory(unit)
    main_pid = unit_property(unit, "MainPID")
    if main_pid and main_pid not in {"0", ""} and int(main_pid) != proc["pid"]:
        raise BenchError(f"MainPID {main_pid} != cgroup pid {proc['pid']} during {label}")
    def mib(v: int) -> float:
        return round(v / (1024.0 * 1024.0), 4)
    return {
        "label": label,
        "cgroup_current_bytes": cg["current_bytes"], "cgroup_peak_bytes": cg["peak_bytes"],
        "cgroup_current_mib": mib(cg["current_bytes"]), "cgroup_peak_mib": mib(cg["peak_bytes"]),
        "rss_bytes": proc["rss_bytes"], "pss_bytes": proc["pss_bytes"],
        "rss_mib": mib(proc["rss_bytes"]), "pss_mib": mib(proc["pss_bytes"]),
        "process_count": proc["process_count"], "pid": proc["pid"],
        "exe": proc["exe"], "cmdline": proc["cmdline"],
    }

def _phase1_require_mutation_event(payload: Any, *, op: str) -> dict[str, Any]:
    if not isinstance(payload, dict) or "event" not in payload:
        raise BenchError(f"{op} response missing event: {payload!r}")
    event = payload["event"]
    if not isinstance(event, dict) or "revision" not in event or "event_type" not in event:
        raise BenchError(f"{op} event malformed: {event!r}")
    return event


def _phase1_task_id_from_mutation(payload: Any, *, op: str) -> str:
    event = _phase1_require_mutation_event(payload, op=op)
    snapshot = event.get("snapshot")
    if isinstance(snapshot, dict):
        task = snapshot.get("task")
        if isinstance(task, dict) and task.get("id"):
            return str(task["id"])
    primary = event.get("primary")
    if isinstance(primary, dict) and primary.get("id"):
        return str(primary["id"])
    raise BenchError(f"{op} response missing task id: {payload!r}")


def run_workload(
    base_url: str,
    host: str,
    origin: str,
    token: str,
    task_count: int,
    mutation_cycles: int,
    static_reads: int,
    list_reads: int,
) -> dict[str, Any]:
    buckets: dict[str, list[float]] = {name: [] for name in LATENCY_OPS}
    task_ids: list[str] = []
    for i in range(static_reads):
        path = "/" if i % 2 == 0 else "/index.html"
        body, ms = http_request(
            "GET", f"{base_url}{path}", headers={"Host": host}, expect_statuses={200}, as_json=False,
        )
        if not body:
            raise BenchError(f"empty static body for {path}")
        buckets["static_read"].append(ms)
    for i in range(task_count):
        payload, ms = http_request(
            "POST", f"{base_url}/api/v1/tasks",
            headers=auth_headers(token, host, origin, mutation=True),
            body={"title": f"bench-task-{i:04d}", "due_date": None},
            expect_statuses={201}, as_json=True,
        )
        # Phase 2 mutation envelope: event.snapshot.task / event.primary.id
        task_id = _phase1_task_id_from_mutation(payload, op="create")
        task_ids.append(task_id)
        buckets["create"].append(ms)
    for _ in range(list_reads):
        payload, ms = http_request(
            "GET", f"{base_url}/api/v1/tasks?limit=100",
            headers=auth_headers(token, host, origin, mutation=False),
            expect_statuses={200}, as_json=True,
        )
        if not isinstance(payload, dict) or "tasks" not in payload:
            raise BenchError(f"list response malformed: {payload!r}")
        if len(payload["tasks"]) < task_count:
            raise BenchError(f"list returned {len(payload['tasks'])} tasks, expected >= {task_count}")
        buckets["list"].append(ms)
    cycles = min(mutation_cycles, len(task_ids))
    for i in range(cycles):
        tid = task_ids[i]
        # PUT replace became PATCH in Phase 2; measure the same single-task title update.
        for name, method, path, body in (
            ("replace", "PATCH", f"/api/v1/tasks/{tid}",
             {"title": f"bench-task-{i:04d}-updated", "due_date": None}),
            ("complete", "POST", f"/api/v1/tasks/{tid}/complete", None),
            ("uncomplete", "POST", f"/api/v1/tasks/{tid}/uncomplete", None),
            ("delete", "DELETE", f"/api/v1/tasks/{tid}", None),
        ):
            payload, ms = http_request(
                method, f"{base_url}{path}",
                headers=auth_headers(token, host, origin, mutation=True),
                body=body, expect_statuses={200}, as_json=True,
            )
            _phase1_require_mutation_event(payload, op=name)
            buckets[name].append(ms)
    payload, ms = http_request(
        "GET", f"{base_url}/api/v1/tasks?limit=100",
        headers=auth_headers(token, host, origin, mutation=False),
        expect_statuses={200}, as_json=True,
    )
    buckets["list"].append(ms)
    remaining = task_count - cycles
    got = len(payload.get("tasks", [])) if isinstance(payload, dict) else None
    if got != remaining:
        raise BenchError(f"post-mutation list size {got} != expected {remaining}")
    return {
        "task_count": task_count, "mutation_cycles": cycles,
        "static_reads": static_reads, "list_reads": list_reads + 1,
        "latencies": {name: latency_summary(vals) for name, vals in buckets.items()},
    }

def run_sample(
    sample_index: int,
    run_id: str,
    repo_root: Path,
    server: Path,
    web_dir: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    profile_dir = work_root / f"profile-{sample_index:02d}"
    material = f"{PROTOCOL_NAME}:{run_id}:{sample_index}".encode()
    digest = hashlib.sha256(material).hexdigest()
    token = digest + hashlib.sha256(digest.encode()).hexdigest()[:16]
    prepare_profile(profile_dir, token)
    unit_name = f"junban-bench-{run_id}-s{sample_index:02d}"[:180]
    started = cleanup_ok = False
    try:
        base_url, host, startup_ms = start_server(unit_name, server, profile_dir, web_dir, repo_root)
        started = True
        time.sleep(SETTLE_SECONDS)
        idle = memory_snapshot(unit_name, server, "idle")
        workload = run_workload(
            base_url, host, base_url, token,
            protocol["task_count"], protocol["mutation_cycles"],
            protocol["static_reads"], protocol["list_reads"],
        )
        warm = memory_snapshot(unit_name, server, "warm")
        db_sizes = sqlite_size_bytes(profile_dir)
        stop_server(unit_name, profile_dir)
        started = False
        shutil.rmtree(profile_dir)
        cleanup_ok = True
        return {
            "sample_index": sample_index, "startup_to_health_ms": startup_ms,
            "settle_seconds": SETTLE_SECONDS, "idle": idle, "warm": warm,
            "workload": workload, "sqlite": db_sizes, "cleanup_success": cleanup_ok,
            "unit": f"{unit_name}.service",
        }
    except Exception:
        if started:
            try:
                stop_server(unit_name, profile_dir)
            except BenchError:
                pass
        raise
    finally:
        if not cleanup_ok and profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)

def build_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(path: tuple[str, ...]) -> list[float]:
        out: list[float] = []
        for sample in samples:
            cursor: Any = sample
            for key in path:
                cursor = cursor[key]
            out.append(float(cursor))
        return out
    latency_out: dict[str, Any] = {}
    for name in LATENCY_OPS:
        pooled: list[float] = []
        p50s: list[float] = []
        p95s: list[float] = []
        for sample in samples:
            lat = sample["workload"]["latencies"][name]
            pooled.extend(lat["values_ms"])
            p50s.append(lat["p50_ms"])
            p95s.append(lat["p95_ms"])
        ordered = sorted(pooled)
        latency_out[name] = {
            "pooled_p50_ms": percentile(ordered, 50), "pooled_p95_ms": percentile(ordered, 95),
            "per_sample_p50_ms": series_summary(p50s), "per_sample_p95_ms": series_summary(p95s),
            "count": len(ordered),
        }
    summary: dict[str, Any] = {k: series_summary(collect(p)) for k, p in SUMMARY_PATHS.items()}
    summary.update({
        "sample_count": len(samples),
        "sqlite_total_bytes": series_summary([float(s["sqlite"]["total_bytes"]) for s in samples]),
        "latencies_ms": latency_out,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
    })
    summary["budget_passed"] = (
        summary["warm_cgroup_mib"]["max"] <= WARM_MEMORY_CEILING_MIB
        and summary["warm_cgroup_peak_mib"]["max"] <= PEAK_MEMORY_CEILING_MIB
    )
    return summary

def protocol_config(quick: bool) -> dict[str, Any]:
    if quick:
        samples, tasks, cycles = QUICK_SAMPLES, QUICK_TASKS, QUICK_CYCLES
        static_reads, list_reads = QUICK_STATIC, QUICK_LIST
    else:
        samples, tasks, cycles = SAMPLES, TASK_COUNT, MUTATION_CYCLES
        static_reads, list_reads = STATIC_READS, LIST_READS
    return {
        "name": PROTOCOL_NAME, "version": PROTOCOL_VERSION, "mode": "phase1",
        "authoritative": not quick, "quick": quick,
        "samples": samples, "task_count": tasks, "mutation_cycles": cycles,
        "static_reads": static_reads, "list_reads": list_reads,
        "settle_seconds": SETTLE_SECONDS, "bind": "127.0.0.1:0", "profile_mode": "0700",
        "token": "deterministic per sample, pre-written owner-only access-token",
        "cgroup": "transient systemd --user service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "task_count_justification": (
            f"{TASK_COUNT} ordinary creates warm SQLite/list paths without Phase 2's 10_000-task fixture."
        ),
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
        "notes": [
            "Optimized release junban-server + production dist only; fail closed on protocol violations.",
            "Quick mode exercises the harness but cannot provide authoritative evidence.",
        ],
    }


def scale_protocol_config(quick: bool) -> dict[str, Any]:
    if quick:
        samples, tasks = SCALE_QUICK_SAMPLES, SCALE_QUICK_TASK_COUNT
    else:
        samples, tasks = SCALE_SAMPLES, SCALE_TASK_COUNT
    return {
        "name": SCALE_PROTOCOL_NAME,
        "version": SCALE_PROTOCOL_VERSION,
        "mode": "scale",
        "authoritative": not quick,
        "quick": quick,
        "samples": samples,
        "task_count": tasks,
        "page_limit": SCALE_PAGE_LIMIT,
        "settle_seconds": SETTLE_SECONDS,
        "bind": "127.0.0.1:0",
        "profile_mode": "0700",
        "token": "deterministic per sample, pre-written owner-only access-token",
        "cgroup": "transient systemd --user service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "seeder_outside_cgroup": True,
        "seeder": "junban-scale-seed (scale-bench feature; not in release server artifacts)",
        "budgets_p95_ms": {
            "list_view": SCALE_LIST_VIEW_P95_MS,
            "search_filter": SCALE_SEARCH_FILTER_P95_MS,
            "single_mutation": SCALE_SINGLE_MUTATION_P95_MS,
            "bulk_reorder_25": SCALE_BULK_REORDER_P95_MS,
        },
        "workload": {
            "partial_updates": SCALE_PARTIAL_UPDATES,
            "complete_uncomplete_pairs": SCALE_COMPLETE_PAIRS,
            "bulk_batches": SCALE_BULK_BATCHES,
            "bulk_batch_size": SCALE_BULK_BATCH_SIZE,
            "reorder_batches": SCALE_REORDER_BATCHES,
            "reorder_batch_size": SCALE_REORDER_BATCH_SIZE,
            "near_cap_complete_undo": True,
            "near_cap_delete_undo": True,
        },
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
        "notes": [
            "Rust seeder creates the fixture before server start; seed duration is recorded separately.",
            "Queries always use limit<=100; the harness never lists all tasks in one response.",
            "Quick mode (500 tasks / 1 sample) validates the harness only.",
        ],
    }


def run_seeder(
    seeder: Path, profile_dir: Path, task_count: int, *, temporal_fixture: bool = False,
) -> dict[str, Any]:
    command = [
        str(seeder),
        "--data-dir", str(profile_dir),
        "--task-count", str(task_count),
    ]
    if temporal_fixture:
        command.append("--temporal-fixture")
    started = time.perf_counter()
    result = run_cmd(command, check=False)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise BenchError(f"seeder failed: {detail}")
    manifest_path = profile_dir / SEED_MANIFEST_FILE
    if not manifest_path.is_file():
        raise BenchError(f"seeder did not write {SEED_MANIFEST_FILE}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BenchError(f"malformed seed manifest: {error}") from error
    if int(manifest.get("task_count", -1)) != task_count:
        raise BenchError(
            f"seed manifest task_count {manifest.get('task_count')!r} != expected {task_count}"
        )
    if bool(manifest.get("temporal_fixture")) != temporal_fixture:
        raise BenchError(
            "seed manifest temporal_fixture does not match benchmark mode"
        )
    seed_ms = float(manifest.get("seed_duration_ms") or elapsed_ms)
    return {
        "duration_ms": seed_ms,
        "wall_ms": elapsed_ms,
        "manifest": manifest,
        "stdout": (result.stdout or "").strip(),
    }


def _require_task_page(payload: Any, *, op: str, limit: int) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or "tasks" not in payload:
        raise BenchError(f"{op}: malformed list response: {payload!r}")
    tasks = payload["tasks"]
    if not isinstance(tasks, list):
        raise BenchError(f"{op}: tasks is not a list")
    if len(tasks) > limit:
        raise BenchError(f"{op}: page returned {len(tasks)} tasks > limit {limit}")
    for task in tasks:
        if not isinstance(task, dict) or not task.get("id"):
            raise BenchError(f"{op}: task missing id: {task!r}")
    return tasks


def _mutation_event(payload: Any, *, op: str) -> dict[str, Any]:
    if not isinstance(payload, dict) or "event" not in payload:
        raise BenchError(f"{op}: mutation response missing event: {payload!r}")
    event = payload["event"]
    if not isinstance(event, dict):
        raise BenchError(f"{op}: event is not an object")
    for key in ("revision", "operation_id", "event_type"):
        if key not in event:
            raise BenchError(f"{op}: event missing {key}: {event!r}")
    return event


def _mutate_with_replay(
    base_url: str,
    host: str,
    origin: str,
    token: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    *,
    op: str,
    expect_statuses: set[int] | None = None,
) -> tuple[dict[str, Any], float]:
    expect = expect_statuses or {200}
    headers = auth_headers(token, host, origin, mutation=True)
    idem = headers["Idempotency-Key"]
    payload, ms = http_request(
        method, f"{base_url}{path}",
        headers=headers, body=body, expect_statuses=expect, as_json=True,
    )
    event = _mutation_event(payload, op=op)
    replay_headers = auth_headers(token, host, origin, mutation=True)
    replay_headers["Idempotency-Key"] = idem
    replay, _ = http_request(
        method, f"{base_url}{path}",
        headers=replay_headers, body=body, expect_statuses=expect, as_json=True,
    )
    replay_event = _mutation_event(replay, op=f"{op}_replay")
    for key in ("revision", "operation_id", "event_type"):
        if replay_event.get(key) != event.get(key):
            raise BenchError(
                f"{op}: receipt replay mismatch on {key}: "
                f"first={event.get(key)!r} replay={replay_event.get(key)!r}"
            )
    return event, ms


def _list_query(
    base_url: str,
    host: str,
    origin: str,
    token: str,
    query: dict[str, Any],
    *,
    op: str,
    limit: int = SCALE_PAGE_LIMIT,
) -> tuple[dict[str, Any], list[dict[str, Any]], float]:
    params = dict(query)
    params["limit"] = limit
    if int(params["limit"]) > SCALE_PAGE_LIMIT:
        raise BenchError(f"{op}: refused oversize page limit {params['limit']}")
    qs = urllib.parse.urlencode(params, doseq=True)
    payload, ms = http_request(
        "GET", f"{base_url}/api/v1/tasks?{qs}",
        headers=auth_headers(token, host, origin, mutation=False),
        expect_statuses={200}, as_json=True,
    )
    tasks = _require_task_page(payload, op=op, limit=limit)
    return payload, tasks, ms


def run_scale_workload(
    base_url: str,
    host: str,
    origin: str,
    token: str,
    manifest: dict[str, Any],
    *,
    quick: bool,
) -> dict[str, Any]:
    buckets: dict[str, list[float]] = {name: [] for name in SCALE_LATENCY_OPS}
    response_counts: dict[str, int] = {}
    limit = SCALE_PAGE_LIMIT

    def record(op: str, ms: float, count: int) -> None:
        buckets[op].append(ms)
        response_counts[op] = count

    # Unmeasured warmup so the first timed sample is not a cold-path outlier.
    _list_query(base_url, host, origin, token, {}, op="warmup_list", limit=limit)
    http_request(
        "GET", f"{base_url}/api/v1/profile",
        headers=auth_headers(token, host, origin, mutation=False),
        expect_statuses={200}, as_json=True,
    )

    for op, query in (
        ("list_unfiltered", {}),
        ("view_inbox", {"view": "inbox"}),
        ("view_today", {"view": "today"}),
        (
            "view_project",
            {
                "view": "project",
                "project_id": manifest["project_view_project_id"],
            },
        ),
    ):
        _, tasks, ms = _list_query(
            base_url, host, origin, token, query, op=op, limit=limit,
        )
        record(op, ms, len(tasks))

    _, hit_tasks, ms = _list_query(
        base_url, host, origin, token,
        {"search": manifest["search_hit"]}, op="search_hit", limit=limit,
    )
    if len(hit_tasks) < 1:
        raise BenchError("search_hit returned zero tasks")
    record("search_hit", ms, len(hit_tasks))

    _, miss_tasks, ms = _list_query(
        base_url, host, origin, token,
        {"search": manifest["search_miss"]}, op="search_miss", limit=limit,
    )
    if len(miss_tasks) != 0:
        raise BenchError(f"search_miss expected 0 tasks, got {len(miss_tasks)}")
    record("search_miss", ms, len(miss_tasks))

    _, tasks, ms = _list_query(
        base_url, host, origin, token,
        {
            "tag_id": manifest["filter_tag_id"],
            "priority": manifest["filter_priority"],
        },
        op="filter_tag_priority", limit=limit,
    )
    record("filter_tag_priority", ms, len(tasks))

    _, tasks, ms = _list_query(
        base_url, host, origin, token,
        {
            "due_after": manifest["due_after"],
            "due_before": manifest["due_before"],
        },
        op="filter_due_range", limit=limit,
    )
    record("filter_due_range", ms, len(tasks))

    _, tasks, ms = _list_query(
        base_url, host, origin, token,
        {
            "project_id": manifest["project_view_project_id"],
            "section_id": manifest["project_view_section_id"],
        },
        op="filter_project_section", limit=limit,
    )
    record("filter_project_section", ms, len(tasks))

    partial_n = 5 if quick else SCALE_PARTIAL_UPDATES
    complete_n = 5 if quick else SCALE_COMPLETE_PAIRS
    bulk_n = 2 if quick else SCALE_BULK_BATCHES
    reorder_n = 2 if quick else SCALE_REORDER_BATCHES

    patch_ids = list(manifest.get("patch_task_ids") or [])
    if len(patch_ids) < partial_n:
        raise BenchError(f"manifest patch_task_ids has {len(patch_ids)} < {partial_n}")
    for i in range(partial_n):
        tid = patch_ids[i]
        _, ms = _mutate_with_replay(
            base_url, host, origin, token,
            "PATCH", f"/api/v1/tasks/{tid}",
            {"title": f"scale-patched-{i:04d}"},
            op="partial_update",
        )
        buckets["partial_update"].append(ms)
    response_counts["partial_update"] = partial_n

    pair_ids = patch_ids[partial_n:partial_n + complete_n]
    if len(pair_ids) < complete_n:
        pair_ids = list(manifest.get("bulk_task_ids") or [])[:complete_n]
    if len(pair_ids) < complete_n:
        raise BenchError(f"not enough tasks for complete pairs: {len(pair_ids)}")
    for tid in pair_ids:
        _, ms = _mutate_with_replay(
            base_url, host, origin, token,
            "POST", f"/api/v1/tasks/{tid}/complete", None, op="complete",
        )
        buckets["complete"].append(ms)
        _, ms = _mutate_with_replay(
            base_url, host, origin, token,
            "POST", f"/api/v1/tasks/{tid}/uncomplete", None, op="uncomplete",
        )
        buckets["uncomplete"].append(ms)
    response_counts["complete"] = complete_n
    response_counts["uncomplete"] = complete_n

    bulk_ids = list(manifest.get("bulk_task_ids") or [])
    if len(bulk_ids) < SCALE_BULK_BATCH_SIZE:
        raise BenchError(
            f"manifest bulk_task_ids has {len(bulk_ids)} < {SCALE_BULK_BATCH_SIZE}"
        )
    for i in range(bulk_n):
        priority = (i % 4) + 1
        _, ms = _mutate_with_replay(
            base_url, host, origin, token,
            "POST", "/api/v1/tasks/actions",
            {
                "task_ids": bulk_ids[:SCALE_BULK_BATCH_SIZE],
                "action": {"type": "priority", "priority": priority},
            },
            op="bulk_25",
        )
        buckets["bulk_25"].append(ms)
    response_counts["bulk_25"] = bulk_n

    reorder_ids = list(manifest.get("reorder_task_ids") or [])
    if len(reorder_ids) < SCALE_REORDER_BATCH_SIZE:
        raise BenchError(
            f"manifest reorder_task_ids has {len(reorder_ids)} < {SCALE_REORDER_BATCH_SIZE}"
        )
    ordered = reorder_ids[:SCALE_REORDER_BATCH_SIZE]
    for i in range(reorder_n):
        perm = list(reversed(ordered)) if i % 2 == 0 else list(ordered)
        _, ms = _mutate_with_replay(
            base_url, host, origin, token,
            "POST", "/api/v1/tasks/reorder",
            {
                "project_id": manifest["reorder_project_id"],
                "section_id": manifest["reorder_section_id"],
                "parent_id": None,
                "ordered_ids": perm,
            },
            op="reorder_25",
        )
        buckets["reorder_25"].append(ms)
    response_counts["reorder_25"] = reorder_n

    complete_root = manifest["complete_tree_root_id"]
    delete_root = manifest["delete_tree_root_id"]
    near_cap = int(manifest["near_cap_size"])

    event, ms = _mutate_with_replay(
        base_url, host, origin, token,
        "POST", f"/api/v1/tasks/{complete_root}/complete", None,
        op="near_cap_complete",
    )
    affected = event.get("affected", {}).get("task_ids", [])
    if not isinstance(affected, list) or len(affected) != near_cap:
        raise BenchError(
            f"near_cap_complete affected {len(affected) if isinstance(affected, list) else affected} "
            f"!= near_cap_size {near_cap}"
        )
    buckets["near_cap_complete"].append(ms)
    response_counts["near_cap_complete"] = len(affected)
    complete_op = event["operation_id"]

    event, ms = _mutate_with_replay(
        base_url, host, origin, token,
        "POST", f"/api/v1/operations/{complete_op}/undo", None,
        op="near_cap_complete_undo",
    )
    buckets["near_cap_complete_undo"].append(ms)
    response_counts["near_cap_complete_undo"] = len(
        event.get("affected", {}).get("task_ids", []) or []
    )

    root_payload, _ = http_request(
        "GET", f"{base_url}/api/v1/tasks/{complete_root}",
        headers=auth_headers(token, host, origin, mutation=False),
        expect_statuses={200}, as_json=True,
    )
    if not isinstance(root_payload, dict) or root_payload.get("status") != "pending":
        raise BenchError(
            f"near_cap_complete_undo did not restore pending status: {root_payload!r}"
        )

    event, ms = _mutate_with_replay(
        base_url, host, origin, token,
        "DELETE", f"/api/v1/tasks/{delete_root}", None,
        op="near_cap_delete",
    )
    affected = event.get("affected", {}).get("task_ids", [])
    if not isinstance(affected, list) or len(affected) != near_cap:
        raise BenchError(
            f"near_cap_delete affected {len(affected) if isinstance(affected, list) else affected} "
            f"!= near_cap_size {near_cap}"
        )
    buckets["near_cap_delete"].append(ms)
    response_counts["near_cap_delete"] = len(affected)
    delete_op = event["operation_id"]

    event, ms = _mutate_with_replay(
        base_url, host, origin, token,
        "POST", f"/api/v1/operations/{delete_op}/undo", None,
        op="near_cap_delete_undo",
    )
    buckets["near_cap_delete_undo"].append(ms)
    response_counts["near_cap_delete_undo"] = len(
        event.get("affected", {}).get("task_ids", []) or []
    )

    restored, _ = http_request(
        "GET", f"{base_url}/api/v1/tasks/{delete_root}",
        headers=auth_headers(token, host, origin, mutation=False),
        expect_statuses={200}, as_json=True,
    )
    if not isinstance(restored, dict) or restored.get("id") != delete_root:
        raise BenchError(f"near_cap_delete_undo did not restore root: {restored!r}")

    return {
        "task_count": int(manifest["task_count"]),
        "page_limit": limit,
        "response_counts": response_counts,
        "latencies": {name: latency_summary(vals) for name, vals in buckets.items() if vals},
        "partial_updates": partial_n,
        "complete_uncomplete_pairs": complete_n,
        "bulk_batches": bulk_n,
        "reorder_batches": reorder_n,
        "near_cap_size": near_cap,
    }


def build_scale_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(path: tuple[str, ...]) -> list[float]:
        out: list[float] = []
        for sample in samples:
            cursor: Any = sample
            for key in path:
                cursor = cursor[key]
            out.append(float(cursor))
        return out

    latency_out: dict[str, Any] = {}
    for name in SCALE_LATENCY_OPS:
        pooled: list[float] = []
        p50s: list[float] = []
        p95s: list[float] = []
        present = False
        for sample in samples:
            latencies = sample["workload"].get("latencies", {})
            if name not in latencies:
                continue
            present = True
            lat = latencies[name]
            pooled.extend(lat["values_ms"])
            p50s.append(lat["p50_ms"])
            p95s.append(lat["p95_ms"])
        if not present:
            continue
        ordered = sorted(pooled)
        latency_out[name] = {
            "pooled_p50_ms": percentile(ordered, 50),
            "pooled_p95_ms": percentile(ordered, 95),
            "per_sample_p50_ms": series_summary(p50s),
            "per_sample_p95_ms": series_summary(p95s),
            "count": len(ordered),
        }

    def group_p95(names: tuple[str, ...]) -> float:
        values = [latency_out[n]["pooled_p95_ms"] for n in names if n in latency_out]
        if not values:
            raise BenchError(f"missing latency groups for {names}")
        return max(values)

    list_view_p95 = group_p95(SCALE_LIST_VIEW_OPS)
    search_filter_p95 = group_p95(SCALE_SEARCH_FILTER_OPS)
    single_mut_p95 = group_p95(SCALE_SINGLE_MUTATION_OPS)
    bulk_reorder_p95 = group_p95(SCALE_BULK_REORDER_OPS)

    budget_checks = {
        "list_view_p95_ms": {
            "value": list_view_p95,
            "limit_ms": SCALE_LIST_VIEW_P95_MS,
            "passed": list_view_p95 <= SCALE_LIST_VIEW_P95_MS,
        },
        "search_filter_p95_ms": {
            "value": search_filter_p95,
            "limit_ms": SCALE_SEARCH_FILTER_P95_MS,
            "passed": search_filter_p95 <= SCALE_SEARCH_FILTER_P95_MS,
        },
        "single_mutation_p95_ms": {
            "value": single_mut_p95,
            "limit_ms": SCALE_SINGLE_MUTATION_P95_MS,
            "passed": single_mut_p95 <= SCALE_SINGLE_MUTATION_P95_MS,
        },
        "bulk_reorder_25_p95_ms": {
            "value": bulk_reorder_p95,
            "limit_ms": SCALE_BULK_REORDER_P95_MS,
            "passed": bulk_reorder_p95 <= SCALE_BULK_REORDER_P95_MS,
        },
    }

    summary: dict[str, Any] = {k: series_summary(collect(p)) for k, p in SUMMARY_PATHS.items()}
    summary.update({
        "sample_count": len(samples),
        "seed_duration_ms": series_summary([float(s["seed"]["duration_ms"]) for s in samples]),
        "sqlite_total_bytes": series_summary([float(s["sqlite"]["total_bytes"]) for s in samples]),
        "latencies_ms": latency_out,
        "budget_checks": budget_checks,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
    })
    latency_ok = all(item["passed"] for item in budget_checks.values())
    memory_ok = (
        summary["warm_cgroup_mib"]["max"] <= WARM_MEMORY_CEILING_MIB
        and summary["warm_cgroup_peak_mib"]["max"] <= PEAK_MEMORY_CEILING_MIB
    )
    summary["latency_budget_passed"] = latency_ok
    summary["memory_budget_passed"] = memory_ok
    summary["budget_passed"] = latency_ok and memory_ok
    return summary


def run_scale_sample(
    sample_index: int,
    run_id: str,
    repo_root: Path,
    server: Path,
    seeder: Path,
    web_dir: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    profile_dir = work_root / f"profile-{sample_index:02d}"
    material = f"{SCALE_PROTOCOL_NAME}:{run_id}:{sample_index}".encode()
    digest = hashlib.sha256(material).hexdigest()
    token = digest + hashlib.sha256(digest.encode()).hexdigest()[:16]
    prepare_profile(profile_dir, token)
    unit_name = f"junban-scale-{run_id}-s{sample_index:02d}"[:180]
    started = cleanup_ok = False
    try:
        seed = run_seeder(seeder, profile_dir, int(protocol["task_count"]))
        base_url, host, startup_ms = start_server(unit_name, server, profile_dir, web_dir, repo_root)
        started = True
        time.sleep(SETTLE_SECONDS)
        idle = memory_snapshot(unit_name, server, "idle")
        workload = run_scale_workload(
            base_url, host, base_url, token, seed["manifest"],
            quick=bool(protocol["quick"]),
        )
        warm = memory_snapshot(unit_name, server, "warm")
        db_sizes = sqlite_size_bytes(profile_dir)
        stop_server(unit_name, profile_dir)
        started = False
        shutil.rmtree(profile_dir)
        cleanup_ok = True
        return {
            "sample_index": sample_index,
            "startup_to_health_ms": startup_ms,
            "settle_seconds": SETTLE_SECONDS,
            "seed": {
                "duration_ms": seed["duration_ms"],
                "wall_ms": seed["wall_ms"],
                "task_count": seed["manifest"]["task_count"],
                "near_cap_size": seed["manifest"]["near_cap_size"],
                "as_of_date": seed["manifest"]["as_of_date"],
            },
            "idle": idle,
            "warm": warm,
            "workload": workload,
            "sqlite": db_sizes,
            "cleanup_success": cleanup_ok,
            "unit": f"{unit_name}.service",
        }
    except Exception:
        if started:
            try:
                stop_server(unit_name, profile_dir)
            except BenchError:
                pass
        raise
    finally:
        if not cleanup_ok and profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)


class ReminderWakeObserver:
    """Captures the scheduler's authenticated, content-free SSE wake."""

    def __init__(self, base_url: str, headers: dict[str, str]) -> None:
        self._base_url = base_url
        self._headers = headers
        self._events: queue.Queue[dict[str, Any]] = queue.Queue()
        self._failure: str | None = None
        self._response: Any = None
        self._thread = threading.Thread(target=self._read, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _read(self) -> None:
        event_type: str | None = None
        data_lines: list[str] = []
        try:
            request = urllib.request.Request(
                f"{self._base_url}/api/v1/reminders/events", headers=self._headers,
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                self._response = response
                while True:
                    raw = response.readline()
                    if not raw:
                        return
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        if event_type == "reminders_due" and data_lines:
                            self._events.put(json.loads("\n".join(data_lines)))
                        event_type, data_lines = None, []
                    elif line.startswith("event:"):
                        event_type = line.partition(":")[2].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line.partition(":")[2].strip())
        except Exception as error:  # surfaced by wait_for_sequence
            self._failure = str(error)

    def wait_for_sequence(self, after: int, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._failure:
                raise BenchError(f"reminder SSE observer failed: {self._failure}")
            try:
                wake = self._events.get(timeout=min(0.1, deadline - time.monotonic()))
            except queue.Empty:
                continue
            sequence = wake.get("sequence")
            if isinstance(sequence, int) and sequence > after:
                return wake
        raise BenchError(f"timed out waiting for reminder wake after sequence {after}")

    def close(self) -> None:
        response = self._response
        if response is not None:
            response.close()
        self._thread.join(timeout=1)


def temporal_protocol_config(quick: bool) -> dict[str, Any]:
    if quick:
        samples, tasks = TEMPORAL_QUICK_SAMPLES, TEMPORAL_QUICK_TASK_COUNT
        bulk_sources, reminder_claims = (
            TEMPORAL_QUICK_BULK_SOURCES,
            TEMPORAL_QUICK_REMINDER_CLAIMS,
        )
    else:
        samples, tasks = TEMPORAL_SAMPLES, TEMPORAL_TASK_COUNT
        bulk_sources, reminder_claims = TEMPORAL_BULK_SOURCES, TEMPORAL_REMINDER_CLAIMS
    return {
        "name": TEMPORAL_PROTOCOL_NAME,
        "version": TEMPORAL_PROTOCOL_VERSION,
        "mode": "temporal",
        "authoritative": not quick,
        "quick": quick,
        "samples": samples,
        "task_count": tasks,
        "bulk_recurrence_sources": bulk_sources,
        "bulk_recurrence_affected_tasks": bulk_sources * 2,
        "reminder_claims": reminder_claims,
        "settle_seconds": SETTLE_SECONDS,
        "bind": "127.0.0.1:0",
        "profile_mode": "0700",
        "token": "deterministic per sample, pre-written owner-only access-token",
        "cgroup": "transient systemd --user service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "seeder_outside_cgroup": True,
        "seeder": "junban-scale-seed --temporal-fixture (scale-bench feature)",
        "budgets_p95_ms": TEMPORAL_BUDGETS_MS,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
        "notes": [
            "The existing dev-only seeder writes 10,000 deterministic tasks before server startup.",
            "One recurring bulk mutation has 250 sources + 250 generated children, the frozen 500 affected-task ceiling.",
            "The scheduler observation subscribes to its authenticated content-free SSE wake after the idle memory snapshot.",
            "Quick mode validates the harness only and is not authoritative evidence.",
        ],
    }


def _temporal_mutation(
    base_url: str, host: str, origin: str, token: str, method: str, path: str,
    body: dict[str, Any] | None, *, op: str, statuses: set[int] | None = None,
) -> tuple[Any, dict[str, Any], float]:
    headers = auth_headers(token, host, origin, mutation=True)
    idem = headers["Idempotency-Key"]
    expect = statuses or {200}
    payload, ms = http_request(
        method, f"{base_url}{path}", headers=headers, body=body,
        expect_statuses=expect, as_json=True,
    )
    event = _mutation_event(payload, op=op)
    replay_headers = auth_headers(token, host, origin, mutation=True)
    replay_headers["Idempotency-Key"] = idem
    replay, _ = http_request(
        method, f"{base_url}{path}", headers=replay_headers, body=body,
        expect_statuses=expect, as_json=True,
    )
    replay_event = _mutation_event(replay, op=f"{op}_replay")
    for key in ("revision", "operation_id", "event_type"):
        if replay_event.get(key) != event.get(key):
            raise BenchError(f"{op}: receipt replay mismatch on {key}")
    return payload, event, ms


def run_temporal_workload(
    base_url: str, host: str, origin: str, token: str, manifest: dict[str, Any],
    protocol: dict[str, Any],
) -> dict[str, Any]:
    source_ids = list(manifest.get("temporal_recurrence_source_ids") or [])
    source_count = int(protocol["bulk_recurrence_sources"])
    reminder_count = int(protocol["reminder_claims"])
    if manifest.get("protocol") != TEMPORAL_PROTOCOL_NAME or not manifest.get("temporal_fixture"):
        raise BenchError("temporal run requires the temporal seeder fixture")
    if len(source_ids) < source_count or source_count < reminder_count:
        raise BenchError(
            f"temporal fixture has {len(source_ids)} recurring sources; need {source_count}"
        )
    as_of = date.fromisoformat(str(manifest["as_of_date"]))
    # The deterministic fixture concentrates ordinary due dates near today;
    # this still-42-day future window remains nonempty below the 2,000 result cap.
    calendar_from = as_of + timedelta(days=10)
    calendar_to = calendar_from + timedelta(days=41)
    stats_from = as_of - timedelta(days=365)
    block_date = as_of + timedelta(days=14)
    buckets: dict[str, list[float]] = {name: [] for name in TEMPORAL_LATENCY_OPS}
    response_counts: dict[str, int] = {}
    mutation_events = 0

    def record(op: str, ms: float, count: int) -> None:
        buckets[op].append(ms)
        response_counts[op] = response_counts.get(op, 0) + count

    def authenticated_get(path: str, op: str, expected_key: str) -> tuple[Any, float]:
        payload, ms = http_request(
            "GET", f"{base_url}{path}",
            headers=auth_headers(token, host, origin, mutation=False),
            expect_statuses={200}, as_json=True,
        )
        if not isinstance(payload, dict) or expected_key not in payload:
            raise BenchError(f"{op}: malformed response: {payload!r}")
        return payload, ms

    start_profile, _ = authenticated_get("/api/v1/profile", "profile_start", "revision")
    start_revision = start_profile["revision"]

    calendar, ms = authenticated_get(
        f"/api/v1/calendar/tasks?from={calendar_from}&to={calendar_to}",
        "calendar_42_day", "tasks",
    )
    calendar_tasks = calendar["tasks"]
    if not isinstance(calendar_tasks, list) or not 0 < len(calendar_tasks) <= 2_000:
        raise BenchError(f"calendar_42_day returned invalid task count: {len(calendar_tasks)}")
    record("calendar_42_day", ms, len(calendar_tasks))

    block_payload, block_event, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", "/api/v1/time-blocks",
        {
            "title": "Temporal benchmark block", "date": str(block_date),
            "start": "09:00", "end": "09:30", "time_zone": "Etc/UTC",
        }, op="timeblock_create", statuses={201},
    )
    mutation_events += 1
    block_id = block_event.get("primary", {}).get("id")
    if not isinstance(block_id, str):
        raise BenchError(f"timeblock_create missing primary id: {block_payload!r}")
    record("timeblock_create", ms, 1)
    blocks, ms = authenticated_get(
        f"/api/v1/time-blocks?from={calendar_from}&to={calendar_to}",
        "timeblock_range_42_day", "time_blocks",
    )
    if not isinstance(blocks["time_blocks"], list) or not any(
        row.get("id") == block_id for row in blocks["time_blocks"]
    ):
        raise BenchError("timeblock_range_42_day omitted the created block")
    record("timeblock_range_42_day", ms, len(blocks["time_blocks"]))

    _, _, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", "/api/v1/time-slots",
        {
            "title": "Temporal benchmark slot", "date": str(block_date),
            "start": "10:00", "end": "10:30", "time_zone": "Etc/UTC",
        }, op="timeslot_create", statuses={201},
    )
    mutation_events += 1
    record("timeslot_create", ms, 1)
    slots, ms = authenticated_get(
        f"/api/v1/time-slots?date={block_date}", "timeslot_range", "time_slots",
    )
    if not isinstance(slots["time_slots"], list) or not slots["time_slots"]:
        raise BenchError("timeslot_range returned no created slot")
    record("timeslot_range", ms, len(slots["time_slots"]))

    daily, ms = authenticated_get(f"/api/v1/planning/daily?date={as_of}", "planning_daily", "focus_tasks")
    record("planning_daily", ms, len(daily["focus_tasks"]))
    weekly, ms = authenticated_get(f"/api/v1/planning/weekly?date={as_of}", "planning_weekly", "daily")
    record("planning_weekly", ms, len(weekly["daily"]))
    stats, ms = authenticated_get(
        f"/api/v1/stats?from={stats_from}&to={as_of}", "stats_366_day", "days",
    )
    if not isinstance(stats["days"], list) or len(stats["days"]) != 366:
        raise BenchError(f"stats_366_day returned {len(stats['days'])} buckets, expected 366")
    record("stats_366_day", ms, len(stats["days"]))
    nudge_payload, ms = authenticated_get(
        f"/api/v1/nudges?date={as_of}&capacity_minutes=60", "nudges", "rules",
    )
    nudge_rules = nudge_payload["rules"]
    if not isinstance(nudge_rules, list) or not nudge_rules:
        raise BenchError("nudges returned no firing rules for the temporal fixture")
    kinds = [rule.get("kind") for rule in nudge_rules if isinstance(rule, dict)]
    allowed_kinds = {
        "overdue", "approaching_deadline", "stale_task", "empty_today", "overloaded_day",
    }
    if len(kinds) != len(nudge_rules) or len(set(kinds)) != len(kinds) or not set(kinds) <= allowed_kinds:
        raise BenchError(f"nudges returned invalid rule facts: {nudge_rules!r}")
    record("nudges", ms, len(nudge_rules))

    _, event, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", f"/api/v1/tasks/{source_ids[0]}/complete", None,
        op="recurrence_complete",
    )
    if len(event.get("affected", {}).get("task_ids", [])) != 2:
        raise BenchError("recurrence_complete did not affect source plus generated child")
    mutation_events += 1
    record("recurrence_complete", ms, 2)
    payload, event, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", f"/api/v1/tasks/{source_ids[0]}/uncomplete", None,
        op="recurrence_uncomplete",
    )
    if payload.get("uncomplete_outcome") != "exact" or len(event.get("affected", {}).get("task_ids", [])) != 2:
        raise BenchError("recurrence_uncomplete did not perform the exact reversal")
    mutation_events += 1
    record("recurrence_uncomplete", ms, 2)

    bulk_sources = source_ids[:source_count]
    _, event, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", "/api/v1/tasks/actions",
        {"task_ids": bulk_sources, "action": {"type": "complete"}},
        op="bulk_recurrence_complete",
    )
    expected_affected = source_count * 2
    if len(event.get("affected", {}).get("task_ids", [])) != expected_affected:
        raise BenchError("bulk_recurrence_complete did not stay at its affected-task target")
    mutation_events += 1
    record("bulk_recurrence_complete", ms, expected_affected)
    _, event, ms = _temporal_mutation(
        base_url, host, origin, token, "POST", "/api/v1/tasks/actions",
        {"task_ids": bulk_sources, "action": {"type": "uncomplete"}},
        op="bulk_recurrence_uncomplete",
    )
    if len(event.get("affected", {}).get("task_ids", [])) != expected_affected:
        raise BenchError("bulk_recurrence_uncomplete did not exactly restore the bulk sources")
    mutation_events += 1
    record("bulk_recurrence_uncomplete", ms, expected_affected)

    observer = ReminderWakeObserver(
        base_url, auth_headers(token, host, origin, mutation=False),
    )
    observer.start()
    initial_wake = observer.wait_for_sequence(-1, 5)
    initial_sequence = initial_wake["sequence"]
    try:
        wake_started = time.perf_counter()
        due_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for task_id in bulk_sources[:reminder_count]:
            _, _, ms = _temporal_mutation(
                base_url, host, origin, token, "POST",
                f"/api/v1/tasks/{task_id}/reminders/reschedule", {"remind_at": due_at},
                op="reminder_schedule",
            )
            mutation_events += 1
            record("reminder_schedule", ms, 1)
        due_wake = observer.wait_for_sequence(initial_sequence, 5)
        wake_wait_ms = (time.perf_counter() - wake_started) * 1000.0
    finally:
        observer.close()

    lease_payload, lease_ms = http_request(
        "POST", f"{base_url}/api/v1/reminders/lease",
        headers=auth_headers(token, host, origin, mutation=True), body={},
        expect_statuses={200}, as_json=True,
    )
    if not isinstance(lease_payload, dict) or not isinstance(lease_payload.get("fence_term"), str):
        raise BenchError(f"reminder_lease_acquire malformed: {lease_payload!r}")
    fence_term = lease_payload["fence_term"]
    record("reminder_lease_acquire", lease_ms, 1)
    claim_payload, claim_ms = http_request(
        "POST", f"{base_url}/api/v1/reminders/claim",
        headers=auth_headers(token, host, origin, mutation=True),
        body={"fence_term": fence_term, "limit": reminder_count},
        expect_statuses={200}, as_json=True,
    )
    reminders = claim_payload.get("reminders") if isinstance(claim_payload, dict) else None
    if not isinstance(reminders, list) or len(reminders) != reminder_count:
        raise BenchError(f"reminder_claim expected {reminder_count}, got {reminders!r}")
    record("reminder_claim_20", claim_ms, len(reminders))
    record("reminder_lease_claim_20", lease_ms + claim_ms, len(reminders))
    settle_latencies: list[float] = []
    for reminder in reminders:
        if not isinstance(reminder, dict):
            raise BenchError(f"malformed claimed reminder: {reminder!r}")
        _, ms = http_request(
            "POST", f"{base_url}/api/v1/reminders/settle/delivered",
            headers=auth_headers(token, host, origin, mutation=True),
            body={
                "fence_term": fence_term, "task_id": reminder["task_id"],
                "remind_at": reminder["remind_at"], "claim_attempt": reminder["claim_attempt"],
                "channel": "in_app",
            }, expect_statuses={204}, as_json=True,
        )
        settle_latencies.append(ms)
    buckets["reminder_settle_delivered"].extend(settle_latencies)
    response_counts["reminder_settle_delivered"] = len(settle_latencies)
    empty_claim, ms = http_request(
        "POST", f"{base_url}/api/v1/reminders/claim",
        headers=auth_headers(token, host, origin, mutation=True),
        body={"fence_term": fence_term, "limit": reminder_count},
        expect_statuses={200}, as_json=True,
    )
    if not isinstance(empty_claim, dict) or empty_claim.get("reminders") != []:
        raise BenchError("reminder scheduler did not return to idle after settlement")
    record("reminder_claim_empty", ms, 0)
    _, ms = http_request(
        "POST", f"{base_url}/api/v1/reminders/lease/release",
        headers=auth_headers(token, host, origin, mutation=True), body={"fence_term": fence_term},
        expect_statuses={204}, as_json=True,
    )
    record("reminder_lease_release", ms, 1)

    end_profile, _ = authenticated_get("/api/v1/profile", "profile_end", "revision")
    end_revision = end_profile["revision"]
    if end_revision - start_revision != mutation_events:
        raise BenchError(
            f"temporal revision delta {end_revision - start_revision} != mutation events {mutation_events}"
        )
    return {
        "task_count": int(manifest["task_count"]),
        "response_counts": response_counts,
        "latencies": {name: latency_summary(values) for name, values in buckets.items() if values},
        "event_revision_start": start_revision,
        "event_revision_end": end_revision,
        "event_revision_delta": end_revision - start_revision,
        "mutation_event_count": mutation_events,
        "scheduler": {
            "idle_before_due": True,
            "initial_wake_sequence": initial_sequence,
            "due_wake_sequence": due_wake["sequence"],
            "due_wake_wait_ms": wake_wait_ms,
            "due_intents_scheduled": reminder_count,
            "claimed": len(reminders),
            "settled": len(settle_latencies),
            "post_settle_claimed": 0,
            "idle_after_settlement": True,
        },
    }


def build_temporal_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(path: tuple[str, ...]) -> list[float]:
        values: list[float] = []
        for sample in samples:
            cursor: Any = sample
            for key in path:
                cursor = cursor[key]
            values.append(float(cursor))
        return values

    latencies: dict[str, Any] = {}
    for name in TEMPORAL_LATENCY_OPS:
        pooled: list[float] = []
        p50s: list[float] = []
        p95s: list[float] = []
        for sample in samples:
            metric = sample["workload"]["latencies"].get(name)
            if metric is None:
                continue
            pooled.extend(metric["values_ms"])
            p50s.append(metric["p50_ms"])
            p95s.append(metric["p95_ms"])
        if not pooled:
            continue
        latencies[name] = {
            "pooled_p50_ms": percentile(sorted(pooled), 50),
            "pooled_p95_ms": percentile(sorted(pooled), 95),
            "per_sample_p50_ms": series_summary(p50s),
            "per_sample_p95_ms": series_summary(p95s),
            "count": len(pooled),
        }

    def metric(name: str) -> float:
        try:
            return float(latencies[name]["pooled_p95_ms"])
        except KeyError as error:
            raise BenchError(f"missing temporal latency metric {name}") from error

    checks = {
        "calendar_42_day_p95_ms": (metric("calendar_42_day"), TEMPORAL_BUDGETS_MS["calendar_42_day"]),
        "timeblocking_42_day_p95_ms": (
            max(metric("timeblock_range_42_day"), metric("timeslot_range")),
            TEMPORAL_BUDGETS_MS["timeblocking_42_day"],
        ),
        "stats_366_day_p95_ms": (metric("stats_366_day"), TEMPORAL_BUDGETS_MS["stats_366_day"]),
        "recurrence_complete_p95_ms": (metric("recurrence_complete"), TEMPORAL_BUDGETS_MS["recurrence_complete"]),
        "bulk_recurrence_complete_p95_ms": (metric("bulk_recurrence_complete"), TEMPORAL_BUDGETS_MS["bulk_recurrence_complete"]),
        "bulk_recurrence_uncomplete_p95_ms": (metric("bulk_recurrence_uncomplete"), TEMPORAL_BUDGETS_MS["bulk_recurrence_uncomplete"]),
        "nudges_p95_ms": (metric("nudges"), TEMPORAL_BUDGETS_MS["nudges"]),
        "reminder_lease_claim_20_p95_ms": (metric("reminder_lease_claim_20"), TEMPORAL_BUDGETS_MS["reminder_lease_claim_20"]),
    }
    budget_checks = {
        name: {"value": value, "limit_ms": limit, "passed": value <= limit}
        for name, (value, limit) in checks.items()
    }
    summary: dict[str, Any] = {k: series_summary(collect(p)) for k, p in SUMMARY_PATHS.items()}
    summary.update({
        "sample_count": len(samples),
        "seed_duration_ms": series_summary([float(s["seed"]["duration_ms"]) for s in samples]),
        "sqlite_total_bytes": series_summary([float(s["sqlite"]["total_bytes"]) for s in samples]),
        "latencies_ms": latencies,
        "scheduler_due_wake_wait_ms": series_summary([
            float(s["workload"]["scheduler"]["due_wake_wait_ms"]) for s in samples
        ]),
        "budget_checks": budget_checks,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "variance_rule": VARIANCE_RULE,
        "regression_rule": REGRESSION_RULE,
    })
    summary["latency_budget_passed"] = all(check["passed"] for check in budget_checks.values())
    summary["memory_budget_passed"] = (
        summary["warm_cgroup_mib"]["max"] <= WARM_MEMORY_CEILING_MIB
        and summary["warm_cgroup_peak_mib"]["max"] <= PEAK_MEMORY_CEILING_MIB
    )
    summary["budget_passed"] = summary["latency_budget_passed"] and summary["memory_budget_passed"]
    return summary


def run_temporal_sample(
    sample_index: int, run_id: str, repo_root: Path, server: Path, seeder: Path,
    web_dir: Path, work_root: Path, protocol: dict[str, Any],
) -> dict[str, Any]:
    profile_dir = work_root / f"profile-{sample_index:02d}"
    digest = hashlib.sha256(
        f"{TEMPORAL_PROTOCOL_NAME}:{run_id}:{sample_index}".encode()
    ).hexdigest()
    token = digest + hashlib.sha256(digest.encode()).hexdigest()[:16]
    prepare_profile(profile_dir, token)
    unit_name = f"junban-temporal-{run_id}-s{sample_index:02d}"[:180]
    started = cleanup_ok = False
    try:
        seed = run_seeder(seeder, profile_dir, int(protocol["task_count"]), temporal_fixture=True)
        base_url, host, startup_ms = start_server(unit_name, server, profile_dir, web_dir, repo_root)
        started = True
        time.sleep(SETTLE_SECONDS)
        idle = memory_snapshot(unit_name, server, "idle")
        workload = run_temporal_workload(base_url, host, base_url, token, seed["manifest"], protocol)
        warm = memory_snapshot(unit_name, server, "warm")
        db_sizes = sqlite_size_bytes(profile_dir)
        stop_server(unit_name, profile_dir)
        started = False
        shutil.rmtree(profile_dir)
        cleanup_ok = True
        return {
            "sample_index": sample_index, "startup_to_health_ms": startup_ms,
            "settle_seconds": SETTLE_SECONDS,
            "seed": {
                "duration_ms": seed["duration_ms"], "wall_ms": seed["wall_ms"],
                "task_count": seed["manifest"]["task_count"],
                "as_of_date": seed["manifest"]["as_of_date"],
                "temporal_recurrence_source_count": len(seed["manifest"]["temporal_recurrence_source_ids"]),
            },
            "idle": idle, "warm": warm, "workload": workload, "sqlite": db_sizes,
            "cleanup_success": cleanup_ok, "unit": f"{unit_name}.service",
        }
    except Exception:
        if started:
            try:
                stop_server(unit_name, profile_dir)
            except BenchError:
                pass
        raise
    finally:
        if not cleanup_ok and profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)


def self_check_protocol() -> None:
    """Focused argument/protocol assertions for CI-friendly validation."""
    phase1 = protocol_config(False)
    phase1_q = protocol_config(True)
    assert phase1["name"] == PROTOCOL_NAME
    assert phase1["samples"] == 5 and phase1["task_count"] == 100
    assert phase1_q["quick"] is True and phase1_q["task_count"] == 10
    assert phase1["authoritative"] is True and phase1_q["authoritative"] is False

    scale = scale_protocol_config(False)
    scale_q = scale_protocol_config(True)
    assert scale["name"] == SCALE_PROTOCOL_NAME
    assert scale["samples"] == 3 and scale["task_count"] == 10_000
    assert scale_q["samples"] == 1 and scale_q["task_count"] == 500
    assert scale["page_limit"] == 100
    assert scale["budgets_p95_ms"]["list_view"] == 75.0
    assert scale["budgets_p95_ms"]["search_filter"] == 100.0
    assert scale["budgets_p95_ms"]["single_mutation"] == 75.0
    assert scale["budgets_p95_ms"]["bulk_reorder_25"] == 150.0
    assert scale["seeder_outside_cgroup"] is True
    assert scale["warm_memory_ceiling_mib"] == 24.0
    assert scale["peak_memory_ceiling_mib"] == 32.0

    temporal = temporal_protocol_config(False)
    temporal_q = temporal_protocol_config(True)
    assert temporal["name"] == TEMPORAL_PROTOCOL_NAME
    assert temporal["samples"] == 5 and temporal["task_count"] == 10_000
    assert temporal["bulk_recurrence_sources"] == 250
    assert temporal["bulk_recurrence_affected_tasks"] == 500
    assert temporal["reminder_claims"] == 20
    assert temporal_q["samples"] == 1 and temporal_q["task_count"] == 500
    assert temporal_q["bulk_recurrence_sources"] == 25
    assert temporal["seeder_outside_cgroup"] is True
    assert temporal["budgets_p95_ms"]["calendar_42_day"] == 100.0
    assert temporal["budgets_p95_ms"]["stats_366_day"] == 150.0
    assert temporal["budgets_p95_ms"]["reminder_lease_claim_20"] == 50.0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Junban hosted-server benchmark harness (phase1 memory + scale)",
    )
    parser.add_argument(
        "--mode",
        choices=("phase1", "scale", "temporal"),
        default="phase1",
        help="phase1 = frozen 100-task memory; scale = Phase 2 10k; temporal = Phase 3 10k",
    )
    parser.add_argument("--server", type=Path, default=Path("target/release/junban-server"))
    parser.add_argument(
        "--seeder",
        type=Path,
        default=Path("target/release/junban-scale-seed"),
        help="Path to junban-scale-seed (scale and temporal modes)",
    )
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    parser.add_argument(
        "--quick", action="store_true",
        help="Non-authoritative dry run (phase1: 10; scale/temporal: 500 tasks)",
    )
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Validate protocol constants/argument defaults and exit",
    )
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent

    if args.self_check:
        try:
            self_check_protocol()
        except AssertionError as error:
            print(f"self-check failed: {error}", file=sys.stderr)
            return 1
        print("self-check passed", file=sys.stderr)
        return 0

    server = (args.server if args.server.is_absolute() else repo_root / args.server).resolve()
    web_dir = (args.web_dir if args.web_dir.is_absolute() else repo_root / args.web_dir).resolve()
    seeder = (args.seeder if args.seeder.is_absolute() else repo_root / args.seeder).resolve()
    try:
        require_linux_cgroup_v2()
        if not server.is_file() or not os.access(server, os.X_OK):
            raise BenchError(f"server binary missing or not executable: {server}")
        if not web_dir.is_dir() or not (web_dir / "index.html").is_file():
            raise BenchError(f"web-dir missing or lacks index.html: {web_dir}")
        if args.mode in {"scale", "temporal"}:
            if not seeder.is_file() or not os.access(seeder, os.X_OK):
                raise BenchError(
                    f"seeder binary missing or not executable: {seeder} "
                    "(build with: cargo build --locked --release -p junban-storage "
                    "--features scale-bench --bin junban-scale-seed)"
                )
            protocol = (
                scale_protocol_config(bool(args.quick))
                if args.mode == "scale"
                else temporal_protocol_config(bool(args.quick))
            )
        else:
            protocol = protocol_config(bool(args.quick))

        run_id = uuid.uuid4().hex[:12]
        prefix = (
            "junban-scale-" if args.mode == "scale"
            else "junban-temporal-" if args.mode == "temporal"
            else "junban-bench-"
        )
        work_root = Path(tempfile.mkdtemp(prefix=f"{prefix}{run_id}-", dir="/tmp"))
        os.chmod(work_root, 0o700)
        samples: list[dict[str, Any]] = []
        try:
            for i in range(protocol["samples"]):
                if args.mode == "scale":
                    sample = run_scale_sample(
                        i, run_id, repo_root, server, seeder, web_dir, work_root, protocol,
                    )
                elif args.mode == "temporal":
                    sample = run_temporal_sample(
                        i, run_id, repo_root, server, seeder, web_dir, work_root, protocol,
                    )
                else:
                    sample = run_sample(
                        i, run_id, repo_root, server, web_dir, work_root, protocol,
                    )
                samples.append(sample)
                seed_bit = ""
                if args.mode in {"scale", "temporal"}:
                    seed_bit = f" seed={sample['seed']['duration_ms']:.1f}ms"
                print(
                    f"sample {i}: startup={sample['startup_to_health_ms']:.1f}ms"
                    f"{seed_bit} "
                    f"idle={sample['idle']['cgroup_current_mib']:.2f}MiB "
                    f"warm={sample['warm']['cgroup_current_mib']:.2f}MiB "
                    f"peak={sample['warm']['cgroup_peak_mib']:.2f}MiB",
                    file=sys.stderr,
                )
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

        if args.mode == "scale":
            summary = build_scale_summary(samples)
        elif args.mode == "temporal":
            summary = build_temporal_summary(samples)
        else:
            summary = build_summary(samples)

        status = (
            "authoritative_passed"
            if protocol["authoritative"] and summary["budget_passed"]
            else "authoritative_failed"
            if protocol["authoritative"]
            else "non_authoritative_dry_run"
        )
        report: dict[str, Any] = {
            "protocol": protocol, "run_id": run_id,
            "host": host_metadata(repo_root), "binary": binary_metadata(server),
            "web_dir": str(web_dir),
            "command": {"argv": [Path(__file__).name, *map(str, sys.argv[1:])], "cwd": str(Path.cwd())},
            "samples": samples, "summary": summary, "evidence_status": status,
        }
        if args.mode in {"scale", "temporal"}:
            report["seeder"] = binary_metadata(seeder)
        text = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.output:
            output = args.output if args.output.is_absolute() else repo_root / args.output
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text, encoding="utf-8")
            print(f"wrote {output}", file=sys.stderr)
        sys.stdout.write(text)
        return 0 if summary["budget_passed"] or not protocol["authoritative"] else 1
    except BenchError as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
