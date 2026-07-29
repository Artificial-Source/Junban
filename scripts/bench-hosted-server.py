#!/usr/bin/env python3
"""Phase 1 hosted-server memory/startup/latency benchmark harness.

Optimized junban-server only, inside a transient systemd --user cgroup.
Authoritative: 5 samples / 100 tasks / 20 cycles. --quick: 1 / 10 / 5 (not evidence).
CLI: --server, --web-dir, --output, --quick. Ceiling fields stay null.
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable
PROTOCOL_NAME = "junban-phase1-hosted-server-v1"
PROTOCOL_VERSION = 1
SAMPLES, TASK_COUNT, MUTATION_CYCLES, STATIC_READS, LIST_READS = 5, 100, 20, 20, 20
QUICK_SAMPLES, QUICK_TASKS, QUICK_CYCLES, QUICK_STATIC, QUICK_LIST = 1, 10, 5, 5, 5
# Only intentional fixed sleep; readiness/shutdown are condition-polled.
SETTLE_SECONDS = 2.0
READY_TIMEOUT_SECONDS = 15.0
STOP_TIMEOUT_SECONDS = 15.0
POLL_INTERVAL_SECONDS = 0.025
TOKEN_FILE, RUNTIME_FILE, DATABASE_FILE = "access-token", "runtime.json", "junban.sqlite3"
NODE_MARKERS = frozenset({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})
LATENCY_OPS = ("static_read", "create", "list", "replace", "complete", "uncomplete", "delete")
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
        task = payload.get("task") if isinstance(payload, dict) else None
        if not isinstance(task, dict) or not task.get("id"):
            raise BenchError(f"create response missing task.id: {payload!r}")
        task_ids.append(str(task["id"]))
        buckets["create"].append(ms)
    for _ in range(list_reads):
        payload, ms = http_request(
            "GET", f"{base_url}/api/v1/tasks",
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
        for name, method, path, body, key in (
            ("replace", "PUT", f"/api/v1/tasks/{tid}",
             {"title": f"bench-task-{i:04d}-updated", "due_date": None}, "task"),
            ("complete", "POST", f"/api/v1/tasks/{tid}/complete", None, "task"),
            ("uncomplete", "POST", f"/api/v1/tasks/{tid}/uncomplete", None, "task"),
            ("delete", "DELETE", f"/api/v1/tasks/{tid}", None, "event"),
        ):
            payload, ms = http_request(
                method, f"{base_url}{path}",
                headers=auth_headers(token, host, origin, mutation=True),
                body=body, expect_statuses={200}, as_json=True,
            )
            if not isinstance(payload, dict) or key not in payload:
                raise BenchError(f"{name} response malformed: {payload!r}")
            buckets[name].append(ms)
    payload, ms = http_request(
        "GET", f"{base_url}/api/v1/tasks",
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
        "memory_ceiling_mib": None, "variance_rule": None, "regression_rule": None,
    })
    return summary

def protocol_config(quick: bool) -> dict[str, Any]:
    if quick:
        samples, tasks, cycles = QUICK_SAMPLES, QUICK_TASKS, QUICK_CYCLES
        static_reads, list_reads = QUICK_STATIC, QUICK_LIST
    else:
        samples, tasks, cycles = SAMPLES, TASK_COUNT, MUTATION_CYCLES
        static_reads, list_reads = STATIC_READS, LIST_READS
    return {
        "name": PROTOCOL_NAME, "version": PROTOCOL_VERSION,
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
        "memory_ceiling_mib": None, "variance_rule": None, "regression_rule": None,
        "notes": [
            "Optimized release junban-server + production dist only; fail closed on protocol violations.",
            "Do not freeze quick-mode; main agent freezes ceiling/variance/regression after 5-sample run.",
        ],
    }

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Junban Phase 1 hosted-server benchmark harness")
    parser.add_argument("--server", type=Path, default=Path("target/release/junban-server"))
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    parser.add_argument(
        "--quick", action="store_true",
        help="Non-authoritative dry run: 1 sample, 10 tasks, 5 mutation cycles",
    )
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent
    server = (args.server if args.server.is_absolute() else repo_root / args.server).resolve()
    web_dir = (args.web_dir if args.web_dir.is_absolute() else repo_root / args.web_dir).resolve()
    try:
        require_linux_cgroup_v2()
        if not server.is_file() or not os.access(server, os.X_OK):
            raise BenchError(f"server binary missing or not executable: {server}")
        if not web_dir.is_dir() or not (web_dir / "index.html").is_file():
            raise BenchError(f"web-dir missing or lacks index.html: {web_dir}")
        protocol = protocol_config(bool(args.quick))
        run_id = uuid.uuid4().hex[:12]
        work_root = Path(tempfile.mkdtemp(prefix=f"junban-bench-{run_id}-", dir="/tmp"))
        os.chmod(work_root, 0o700)
        samples: list[dict[str, Any]] = []
        try:
            for i in range(protocol["samples"]):
                sample = run_sample(i, run_id, repo_root, server, web_dir, work_root, protocol)
                samples.append(sample)
                print(
                    f"sample {i}: startup={sample['startup_to_health_ms']:.1f}ms "
                    f"idle={sample['idle']['cgroup_current_mib']:.2f}MiB "
                    f"warm={sample['warm']['cgroup_current_mib']:.2f}MiB "
                    f"peak={sample['warm']['cgroup_peak_mib']:.2f}MiB",
                    file=sys.stderr,
                )
        finally:
            shutil.rmtree(work_root, ignore_errors=True)
        status = "authoritative_candidate" if protocol["authoritative"] else "non_authoritative_dry_run"
        report = {
            "protocol": protocol, "run_id": run_id,
            "host": host_metadata(repo_root), "binary": binary_metadata(server),
            "web_dir": str(web_dir),
            "command": {"argv": [Path(__file__).name, *map(str, sys.argv[1:])], "cwd": str(Path.cwd())},
            "samples": samples, "summary": build_summary(samples), "evidence_status": status,
        }
        text = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if args.output:
            output = args.output if args.output.is_absolute() else repo_root / args.output
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text, encoding="utf-8")
            print(f"wrote {output}", file=sys.stderr)
        sys.stdout.write(text)
        return 0
    except BenchError as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
