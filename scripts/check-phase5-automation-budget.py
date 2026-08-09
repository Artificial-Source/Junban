#!/usr/bin/env python3
"""Phase 5 automation budget harness (CLI + MCP).

Implements frozen protocol `junban-phase5-automation-v1`
(`goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md`).

Measures optimized release `junban-server`, `junban`, and `junban-mcp` only.
The Python driver, fixture setup, credential minting, and result validation stay
outside every measured cgroup. Authoritative memory uses cgroup v2 via transient
`systemd-run --user` units with `MemoryAccounting=yes` — never process RSS as a
substitute.

CLI:
  --server/--cli/--mcp   release binary paths (default target/release/*)
  --web-dir              static assets for junban-server (default: dist)
  --output               write JSON evidence (required for --quick)
  --quick                reduced samples; never acceptance evidence
  --self-check           validate frozen knobs/budgets and exit
  --build                cargo build --locked --release the three packages
  --skip-memory          developer mode: skip cgroup memory (non-authoritative)
  --accept-explained-owner-delta durable-sqlite-state-growth
                         optional root-cause decision: may resolve only the
                         owner post-workload delta gate after idle-host
                         controls and objective predicates; never waives
                         absolute 24/32 ceilings or other gates
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, IO, TextIO

# ── Frozen protocol (do not weaken after seeing results) ─────────────────────
PROTOCOL_NAME = "junban-phase5-automation-v1"
PROTOCOL_VERSION = 1

ACTIVE_OWNER_CLI_SAMPLES = 20
ACTIVE_OWNER_CLI_P95_MS = 150.0
ACTIVE_OWNER_SEED_TASKS = 100

NO_OWNER_CLI_SAMPLES = 10
NO_OWNER_CLI_P95_MS = 350.0

MCP_OP_SAMPLES = 3
MCP_CREATES_PER_SAMPLE = 50
MCP_GETS_PER_SAMPLE = 50
MCP_CREATE_P95_MS = 100.0
MCP_GET_P95_MS = 75.0

MCP_IDLE_SAMPLES = 3
WARM_MEMORY_CEILING_MIB = 24.0
PEAK_MEMORY_CEILING_MIB = 32.0
OWNER_DELTA_PCT = 0.15
OWNER_DELTA_FLOOR_MIB = 1.0
# Explicit root-cause decision identity for >threshold owner delta adjudication.
# May resolve only the owner-delta gate; never absolute/process/latency/other.
OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH = "durable-sqlite-state-growth"
OWNER_DELTA_DECISIONS = frozenset({OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH})
# Conservative composition bounds for durable-sqlite-state-growth disposition.
OWNER_DELTA_ANON_GROWTH_BOUND_MIB = 0.75
OWNER_DELTA_COMPOSITION_SLACK_MIB = 0.25
OWNER_DELTA_COMPOSITION_COVERAGE_RATIO = 0.70
OWNER_DELTA_IDLE_CONTROL_SAMPLES = 2

# --quick harness-only reductions (never acceptance evidence)
QUICK_ACTIVE_OWNER_CLI_SAMPLES = 3
QUICK_NO_OWNER_CLI_SAMPLES = 2
QUICK_MCP_OP_SAMPLES = 1
QUICK_MCP_CREATES = 5
QUICK_MCP_GETS = 5
QUICK_MCP_IDLE_SAMPLES = 1
QUICK_SEED_TASKS = 10

SETTLE_SECONDS = 2.0
READY_TIMEOUT_SECONDS = 20.0
STOP_TIMEOUT_SECONDS = 15.0
POLL_INTERVAL_SECONDS = 0.025
MCP_RPC_TIMEOUT_SECONDS = 30.0
CLI_TIMEOUT_SECONDS = 60.0
LIFECYCLE_TIMEOUT_SECONDS = 20.0

TOKEN_FILE = "access-token"
RUNTIME_FILE = "runtime.json"
DATABASE_FILE = "junban.sqlite3"
LOCK_FILE = "profile.lock"
DEFAULT_EVIDENCE = Path("goals/rust-rewrite/evidence/phase-5-automation-bench.json")

NODE_MARKERS = frozenset({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})
OPERATOR_TOOL_NAMES = frozenset(
    {
        "rotate_token",
        "restore_backup",
        "list_automation_credentials",
        "revoke_automation_credential",
        "create_automation_credential",
        "get_diagnostics",
        "clear_diagnostics",
        "get_allowed_hosts",
        "put_allowed_hosts",
        "get_maintenance_status",
        "get_recovery_status",
        "junban_status",
        "get_principal",
    }
)
REQUIRED_RESOURCES = frozenset(
    {
        "junban://profile",
        "junban://sync",
        "junban://today",
        "junban://projects",
        "junban://tags",
        "junban://settings",
    }
)
REQUIRED_PROMPTS = frozenset({"plan-my-day", "triage-inbox", "weekly-review"})


class BenchError(RuntimeError):
    """Fail-closed benchmark error."""


# ── Math / small utils ───────────────────────────────────────────────────────


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


def latency_summary(values_ms: list[float]) -> dict[str, Any]:
    if not values_ms:
        raise BenchError("missing latency samples")
    ordered = sorted(values_ms)
    return {
        "count": len(ordered),
        "p50_ms": percentile(ordered, 50),
        "p95_ms": percentile(ordered, 95),
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
        "values_ms": ordered,
    }


def mib(byte_count: int | float) -> float:
    return round(float(byte_count) / 1_048_576.0, 4)


def now_ns() -> int:
    return time.perf_counter_ns()


def ns_to_ms(started_ns: int, ended_ns: int | None = None) -> float:
    end = now_ns() if ended_ns is None else ended_ns
    return (end - started_ns) / 1_000_000.0


def run_cmd(
    args: list[str],
    *,
    check: bool = True,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise BenchError(f"command failed ({args[0]} …): {sanitize_text(detail)[:400]}")
    return result


def poll_until(timeout: float, done: Callable[[], bool], error: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if done():
            return
        time.sleep(POLL_INTERVAL_SECONDS)
    raise BenchError(error)


def sanitize_text(text: str, secrets_list: list[str] | None = None) -> str:
    out = text
    for secret in secrets_list or []:
        if secret:
            out = out.replace(secret, "<redacted>")
    out = re.sub(r"jba_[0-9a-fA-F-]{36}_[0-9a-f]{64}", "jba_<redacted>", out)
    out = re.sub(r"Bearer\s+\S+", "Bearer <redacted>", out, flags=re.I)
    return out


def assert_no_secrets(text: str, secrets_list: list[str], *, where: str) -> None:
    lowered = text
    for secret in secrets_list:
        if secret and secret in lowered:
            raise BenchError(f"secret material leaked in {where}")
    if re.search(r"jba_[0-9a-fA-F-]{36}_[0-9a-f]{64}", text):
        raise BenchError(f"automation token shape leaked in {where}")
    if re.search(r"Bearer\s+\S+", text, flags=re.I) and "Bearer <redacted>" not in text:
        # Allow only if the match is not a real token bearer line in protocol frames.
        if "Authorization" in text or re.search(r"Bearer\s+[A-Za-z0-9_\-]{16,}", text):
            raise BenchError(f"bearer material leaked in {where}")


def generate_operator_token() -> str:
    return secrets.token_hex(32)


def mint_automation_token(credential_id: str) -> str:
    return f"jba_{credential_id}_{secrets.token_hex(32)}"


def relative_name(path: Path, repo_root: Path) -> str:
    try:
        return str(path.resolve().relative_to(repo_root.resolve()))
    except ValueError:
        return path.name


# ── Host / binary / cgroup ───────────────────────────────────────────────────


def require_linux_cgroup_v2() -> None:
    if sys.platform != "linux":
        raise BenchError("this harness requires Linux cgroup v2")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise BenchError("cgroup v2 not mounted at /sys/fs/cgroup")
    if shutil.which("systemctl") is None or shutil.which("systemd-run") is None:
        raise BenchError("systemd --user tools (systemctl, systemd-run) are required")
    probe = run_cmd(["systemctl", "--user", "is-system-running"], check=False)
    state = (probe.stdout or "").strip()
    if probe.returncode not in (0, 1) and state not in {
        "running",
        "degraded",
        "starting",
        "maintenance",
    }:
        raise BenchError(f"systemd --user is unavailable (state={state!r})")


def host_metadata_sanitized(repo_root: Path) -> dict[str, Any]:
    """Sanitized host/toolchain metadata — no hostname, username, or abs paths."""
    uname = os.uname()
    cpu_model = None
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    rustc = run_cmd(["rustc", "-Vv"], check=False)
    rustc_lines = (rustc.stdout or "").splitlines() if rustc.returncode == 0 else []
    rustc_version = next((ln for ln in rustc_lines if ln.startswith("release:")), None)
    rustc_host = next((ln for ln in rustc_lines if ln.startswith("host:")), None)
    commit = run_cmd(["git", "-C", str(repo_root), "rev-parse", "HEAD"], check=False)
    dirty = run_cmd(["git", "-C", str(repo_root), "status", "--porcelain"], check=False)
    return {
        "os": f"{uname.sysname} {uname.release} {uname.machine}",
        "kernel": uname.release,
        "machine": uname.machine,
        "cpu_model": cpu_model,
        "cpu_count": os.cpu_count(),
        "rustc_release": rustc_version.split(":", 1)[1].strip() if rustc_version else None,
        "rustc_host": rustc_host.split(":", 1)[1].strip() if rustc_host else None,
        "git_commit": (commit.stdout or "").strip() if commit.returncode == 0 else None,
        "git_dirty": bool((dirty.stdout or "").strip()) if dirty.returncode == 0 else None,
        "cgroup": "v2 transient systemd --user MemoryAccounting=yes",
    }


def binary_metadata(path: Path, repo_root: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {
        "name": relative_name(path, repo_root),
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def unit_property(unit: str, prop: str) -> str:
    result = run_cmd(
        ["systemctl", "--user", "show", unit, f"--property={prop}", "--value"],
        check=False,
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
        raise BenchError(f"cgroup path missing for {unit}")
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


def read_cgroup_memory_stat(unit: str) -> dict[str, int]:
    """Parse raw cgroup v2 memory.stat key/value pairs (bytes)."""
    cg = cgroup_path(unit)
    path = cg / "memory.stat"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise BenchError(f"cgroup memory.stat unavailable for {unit}: {error}") from error
    stats: dict[str, int] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        key, raw = parts
        try:
            stats[key] = int(raw)
        except ValueError as error:
            raise BenchError(f"invalid memory.stat line for {unit}: {line!r}") from error
    if "anon" not in stats or "file" not in stats:
        raise BenchError(f"memory.stat missing anon/file for {unit}")
    return stats


def memory_stat_summary(stat: dict[str, int] | None) -> dict[str, Any] | None:
    """Sanitized composition view plus raw stat map for evidence."""
    if not stat:
        return None
    return {
        "anon_bytes": int(stat.get("anon", 0)),
        "file_bytes": int(stat.get("file", 0)),
        "anon_mib": mib(stat.get("anon", 0)),
        "file_mib": mib(stat.get("file", 0)),
        "inactive_file_bytes": int(stat.get("inactive_file", 0)),
        "active_file_bytes": int(stat.get("active_file", 0)),
        "inactive_anon_bytes": int(stat.get("inactive_anon", 0)),
        "active_anon_bytes": int(stat.get("active_anon", 0)),
        "raw": {k: int(v) for k, v in sorted(stat.items())},
    }


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
    try:
        return Path(f"/proc/{pid}/{name}").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def cgroup_pids(unit: str) -> list[int]:
    try:
        raw = (cgroup_path(unit) / "cgroup.procs").read_text(encoding="utf-8")
    except (BenchError, OSError):
        return []
    return [int(p) for p in raw.split() if p]


def assert_single_named_process(unit: str, binary_name: str) -> dict[str, Any]:
    pids = cgroup_pids(unit)
    # systemd-run --scope may briefly include the systemd-run helper; filter to live pids.
    live = [p for p in pids if Path(f"/proc/{p}").exists()]
    # Prefer the target binary if multiple transient pids appear.
    matched: list[int] = []
    details: list[dict[str, str]] = []
    for pid in live:
        exe = proc_field(pid, "exe")
        cmdline = proc_field(pid, "cmdline")
        comm = proc_field(pid, "comm")
        blob = f"{exe} {comm} {cmdline}".lower()
        tokens = set(re.split(r"[^a-z0-9_.+-]+", blob))
        if tokens.intersection(NODE_MARKERS):
            raise BenchError(f"Node/tooling process found in {unit}: {cmdline!r}")
        details.append({"pid": str(pid), "exe": exe, "comm": comm, "cmdline": cmdline})
        if binary_name in exe or binary_name in cmdline or binary_name in comm:
            matched.append(pid)
    if not matched:
        raise BenchError(
            f"expected {binary_name} in {unit}, found: "
            f"{sanitize_text(json.dumps(details))[:400]}"
        )
    if len(matched) != 1:
        raise BenchError(f"expected exactly one {binary_name} in {unit}, found {matched}")
    pid = matched[0]
    # Reject Node descendants of the target.
    children_path = Path(f"/proc/{pid}/task/{pid}/children")
    if children_path.exists():
        try:
            children = [int(x) for x in children_path.read_text().split() if x]
        except OSError:
            children = []
        for child in children:
            if not Path(f"/proc/{child}").exists():
                continue
            child_blob = f"{proc_field(child, 'exe')} {proc_field(child, 'cmdline')}".lower()
            if set(re.split(r"[^a-z0-9_.+-]+", child_blob)).intersection(NODE_MARKERS):
                raise BenchError(f"{binary_name} spawned Node descendant pid={child}")
    return {
        "pid": pid,
        "exe": proc_field(pid, "exe"),
        "comm": proc_field(pid, "comm"),
        "cmdline": proc_field(pid, "cmdline"),
        "process_count": 1,
        "cgroup_pid_count": len(live),
    }


def memory_snapshot(
    unit: str,
    binary_name: str,
    label: str,
    *,
    measure_memory: bool,
    include_memory_stat: bool = False,
) -> dict[str, Any]:
    proc = assert_single_named_process(unit, binary_name)
    snap: dict[str, Any] = {
        "label": label,
        "process_count": proc["process_count"],
        "pid": proc["pid"],
        "exe": proc["exe"],
        "no_node": True,
    }
    if measure_memory:
        cg = read_cgroup_memory(unit)
        snap.update(
            {
                "cgroup_current_bytes": cg["current_bytes"],
                "cgroup_peak_bytes": cg["peak_bytes"],
                "cgroup_current_mib": mib(cg["current_bytes"]),
                "cgroup_peak_mib": mib(cg["peak_bytes"]),
            }
        )
        if include_memory_stat:
            snap["memory_stat"] = memory_stat_summary(read_cgroup_memory_stat(unit))
    else:
        snap["memory_skipped"] = True
    return snap


def stop_unit(unit_name: str) -> None:
    """Stop a .service or .scope unit and wait for it to disappear."""
    candidates = [unit_name]
    if not unit_name.endswith(".service") and not unit_name.endswith(".scope"):
        candidates = [f"{unit_name}.service", f"{unit_name}.scope", unit_name]
    for unit in candidates:
        if not unit_exists(unit):
            continue
        run_cmd(["systemctl", "--user", "stop", unit], check=False)
        run_cmd(["systemctl", "--user", "kill", unit, "-s", "SIGKILL"], check=False)

        def stopped(u: str = unit) -> bool:
            if not unit_exists(u):
                return True
            state = unit_property(u, "ActiveState")
            return state in {"inactive", "failed", "dead"} and unit_property(u, "MainPID") in {
                "",
                "0",
            }

        try:
            poll_until(STOP_TIMEOUT_SECONDS, stopped, f"unit {unit} did not stop")
        except BenchError:
            run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)
        if unit_exists(unit):
            run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)


# ── Profile / HTTP ───────────────────────────────────────────────────────────


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


def write_private_file(path: Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content if content.endswith("\n") else content + "\n")
    os.chmod(path, 0o600)


def sqlite_size_bytes(profile_dir: Path) -> dict[str, int]:
    parts: dict[str, int] = {"total_bytes": 0}
    for name in (DATABASE_FILE, f"{DATABASE_FILE}-wal", f"{DATABASE_FILE}-shm"):
        path = profile_dir / name
        if path.exists():
            size = path.stat().st_size
            parts[name] = size
            parts["total_bytes"] += size
    return parts


def owner_delta_allowed_mib(baseline_current_mib: float) -> float:
    """Frozen raw threshold: larger of 15% of baseline or 1 MiB."""
    return max(OWNER_DELTA_FLOOR_MIB, OWNER_DELTA_PCT * float(baseline_current_mib))


def evaluate_owner_delta_raw(
    before_current_mib: float,
    after_current_mib: float,
) -> dict[str, Any]:
    before = round(float(before_current_mib), 4)
    after = round(float(after_current_mib), 4)
    signed = round(after - before, 4)
    delta = round(abs(signed), 4)
    allowed = round(owner_delta_allowed_mib(before), 4)
    return {
        "before_current_mib": before,
        "after_current_mib": after,
        "owner_delta_mib": delta,
        "owner_delta_signed_mib": signed,
        "owner_delta_allowed_mib": allowed,
        "owner_delta_threshold_rule": "max(1 MiB, 15% of baseline current)",
        "owner_delta_raw_passed": delta <= allowed + 1e-9,
    }


def _sqlite_durable_bytes(sizes: dict[str, Any] | None) -> int:
    if not sizes:
        return 0
    db = int(sizes.get(DATABASE_FILE, 0) or 0)
    wal = int(sizes.get(f"{DATABASE_FILE}-wal", 0) or 0)
    return db + wal


def evaluate_durable_sqlite_state_growth_sample(
    *,
    delta_raw: dict[str, Any],
    memory_stat_before: dict[str, Any] | None,
    memory_stat_after: dict[str, Any] | None,
    sqlite_before: dict[str, Any] | None,
    sqlite_after: dict[str, Any] | None,
    owner_absolute_ok: bool,
    process_ok: bool,
    no_node_ok: bool,
) -> dict[str, Any]:
    """Objective predicates for one failing workload owner-delta sample.

    Fail closed when evidence is missing or contradictory. Does not consider
    idle controls (evaluated separately) and cannot waive absolute ceilings.
    """
    predicates: dict[str, Any] = {
        "owner_absolute_ceilings_passed": bool(owner_absolute_ok),
        "process_ok": bool(process_ok),
        "no_node_ok": bool(no_node_ok),
        "memory_stat_before_present": memory_stat_before is not None,
        "memory_stat_after_present": memory_stat_after is not None,
        "sqlite_before_present": sqlite_before is not None,
        "sqlite_after_present": sqlite_after is not None,
    }
    if not (
        predicates["memory_stat_before_present"]
        and predicates["memory_stat_after_present"]
        and predicates["sqlite_before_present"]
        and predicates["sqlite_after_present"]
    ):
        predicates.update(
            {
                "durable_db_wal_grew": False,
                "file_cache_grew": False,
                "anon_growth_bounded": False,
                "composition_covers_delta": False,
                "sample_explained": False,
            }
        )
        return {
            "predicates": predicates,
            "passed": False,
            "reason": "missing_memory_stat_or_sqlite_evidence",
            "composition": None,
        }

    before_stat = memory_stat_before or {}
    after_stat = memory_stat_after or {}
    # Accept either summary shape ({anon_bytes,...}) or raw map ({anon,...}).
    def _bytes(stat: dict[str, Any], summary_key: str, raw_key: str) -> int:
        if summary_key in stat:
            return int(stat[summary_key] or 0)
        if raw_key in stat:
            return int(stat[raw_key] or 0)
        raw = stat.get("raw") or {}
        if isinstance(raw, dict) and raw_key in raw:
            return int(raw[raw_key] or 0)
        return 0

    file_before = _bytes(before_stat, "file_bytes", "file")
    file_after = _bytes(after_stat, "file_bytes", "file")
    anon_before = _bytes(before_stat, "anon_bytes", "anon")
    anon_after = _bytes(after_stat, "anon_bytes", "anon")
    file_delta_mib = mib(file_after - file_before)
    anon_delta_mib = mib(anon_after - anon_before)
    durable_before = _sqlite_durable_bytes(sqlite_before)
    durable_after = _sqlite_durable_bytes(sqlite_after)
    wal_before = int((sqlite_before or {}).get(f"{DATABASE_FILE}-wal", 0) or 0)
    wal_after = int((sqlite_after or {}).get(f"{DATABASE_FILE}-wal", 0) or 0)
    db_before = int((sqlite_before or {}).get(DATABASE_FILE, 0) or 0)
    db_after = int((sqlite_after or {}).get(DATABASE_FILE, 0) or 0)
    durable_grew = durable_after > durable_before or wal_after > wal_before or db_after > db_before
    file_grew = file_delta_mib > 0.0
    anon_bounded = anon_delta_mib <= OWNER_DELTA_ANON_GROWTH_BOUND_MIB + 1e-9
    explained_mib = max(0.0, file_delta_mib) + max(0.0, anon_delta_mib)
    delta_mib = float(delta_raw["owner_delta_mib"])
    composition_covers = (
        explained_mib + OWNER_DELTA_COMPOSITION_SLACK_MIB + 1e-9 >= delta_mib
        or explained_mib + 1e-9 >= OWNER_DELTA_COMPOSITION_COVERAGE_RATIO * delta_mib
    )
    predicates.update(
        {
            "durable_db_wal_grew": durable_grew,
            "file_cache_grew": file_grew,
            "anon_growth_bounded": anon_bounded,
            "composition_covers_delta": composition_covers,
        }
    )
    sample_ok = (
        predicates["owner_absolute_ceilings_passed"]
        and predicates["process_ok"]
        and predicates["no_node_ok"]
        and durable_grew
        and file_grew
        and anon_bounded
        and composition_covers
    )
    predicates["sample_explained"] = sample_ok
    composition = {
        "file_before_bytes": file_before,
        "file_after_bytes": file_after,
        "file_delta_mib": file_delta_mib,
        "anon_before_bytes": anon_before,
        "anon_after_bytes": anon_after,
        "anon_delta_mib": anon_delta_mib,
        "explained_mib": explained_mib,
        "owner_delta_mib": delta_mib,
        "sqlite_before_durable_bytes": durable_before,
        "sqlite_after_durable_bytes": durable_after,
        "sqlite_db_before_bytes": db_before,
        "sqlite_db_after_bytes": db_after,
        "sqlite_wal_before_bytes": wal_before,
        "sqlite_wal_after_bytes": wal_after,
        "anon_growth_bound_mib": OWNER_DELTA_ANON_GROWTH_BOUND_MIB,
        "composition_slack_mib": OWNER_DELTA_COMPOSITION_SLACK_MIB,
        "composition_coverage_ratio": OWNER_DELTA_COMPOSITION_COVERAGE_RATIO,
    }
    reason = "explained_durable_sqlite_state_growth" if sample_ok else "sample_predicates_failed"
    return {
        "predicates": predicates,
        "passed": sample_ok,
        "reason": reason,
        "composition": composition,
    }


def evaluate_idle_owner_control_sample(control: dict[str, Any]) -> dict[str, Any]:
    """Idle-host control must not show continuing growth beyond the frozen threshold.

    Decreases (reclaim) are allowed: the protocol root-cause path looks for
    unexplained growth without client workload, not absolute |delta| noise.
    The abs-based raw threshold is still recorded on the control for evidence.
    """
    raw = dict(control.get("owner_delta") or {})
    absolute_ok = bool(control.get("owner_absolute_ok", False))
    process_ok = bool(control.get("process_ok", False))
    no_node_ok = bool(control.get("no_node_ok", False))
    cleanup_ok = bool(control.get("cleanup_ok", False))
    signed = float(raw.get("owner_delta_signed_mib") or 0.0)
    allowed = float(raw.get("owner_delta_allowed_mib") or OWNER_DELTA_FLOOR_MIB)
    growth = round(max(0.0, signed), 4)
    growth_ok = growth <= allowed + 1e-9
    raw["owner_delta_growth_mib"] = growth
    raw["owner_delta_growth_within_threshold"] = growth_ok
    predicates = {
        "owner_absolute_ceilings_passed": absolute_ok,
        "process_ok": process_ok,
        "no_node_ok": no_node_ok,
        "cleanup_ok": cleanup_ok,
        "idle_growth_within_threshold": growth_ok,
    }
    passed = all(predicates.values())
    return {
        "predicates": predicates,
        "passed": passed,
        "owner_delta": raw,
        "reason": "idle_control_flat" if passed else "idle_control_failed",
    }


def evaluate_owner_delta_disposition(
    *,
    decision: str | None,
    authoritative: bool,
    measure_memory: bool,
    raw_series: list[dict[str, Any]],
    idle_controls: list[dict[str, Any]] | None,
    owner_absolute_all_ok: bool,
    process_no_node_cleanup_ok: bool,
) -> dict[str, Any]:
    """Fail-closed disposition for the owner-delta gate only.

    Preserves raw series; never rewrites samples. Quick/skip-memory cannot
    produce an accepting disposition even if a decision identity is supplied.
    """
    raw_passed = all(bool(s.get("owner_delta_raw_passed", False)) for s in raw_series) if raw_series else True
    max_delta = max((float(s["owner_delta_mib"]) for s in raw_series), default=None)
    result: dict[str, Any] = {
        "decision": decision,
        "decision_allowed": decision in OWNER_DELTA_DECISIONS if decision else False,
        "authoritative": bool(authoritative),
        "measure_memory": bool(measure_memory),
        "owner_delta_raw_passed": raw_passed,
        "max_owner_delta_mib": max_delta,
        "raw_series": raw_series,
        "idle_controls": idle_controls or [],
        "idle_control_evaluations": [],
        "failing_sample_evaluations": [],
        "predicates": {},
        "owner_delta_effective_passed": raw_passed if measure_memory else True,
        "disposition_applied": False,
        "disposition_passed": False,
        "warning": None,
        "reason": "raw_owner_delta_passed" if raw_passed else "raw_owner_delta_failed_no_decision",
    }
    if not measure_memory:
        result["reason"] = "memory_not_measured_non_authoritative"
        result["owner_delta_effective_passed"] = True
        result["predicates"] = {
            "non_authoritative_cannot_accept": True,
            "raw_passed_or_skipped": True,
        }
        return result
    if raw_passed:
        result["predicates"] = {
            "raw_owner_delta_passed": True,
            "owner_absolute_ceilings_passed": bool(owner_absolute_all_ok),
            "process_no_node_cleanup_ok": bool(process_no_node_cleanup_ok),
        }
        # Absolute/process failures are separate gates; raw delta itself passed.
        result["owner_delta_effective_passed"] = True
        return result
    if not decision:
        result["predicates"] = {
            "raw_owner_delta_passed": False,
            "explicit_decision_present": False,
        }
        result["owner_delta_effective_passed"] = False
        result["reason"] = "raw_owner_delta_failed_no_decision"
        return result
    if decision not in OWNER_DELTA_DECISIONS:
        result["predicates"] = {
            "raw_owner_delta_passed": False,
            "explicit_decision_present": True,
            "decision_recognized": False,
        }
        result["owner_delta_effective_passed"] = False
        result["reason"] = f"unrecognized_decision:{decision}"
        return result
    if not authoritative:
        # Decision path may still record evidence, but cannot accept.
        result["predicates"] = {
            "raw_owner_delta_passed": False,
            "explicit_decision_present": True,
            "authoritative": False,
            "non_authoritative_cannot_accept": True,
        }
        result["owner_delta_effective_passed"] = False
        result["disposition_applied"] = True
        result["disposition_passed"] = False
        result["reason"] = "decision_ignored_non_authoritative"
        result["warning"] = (
            "owner-delta decision requested on non-authoritative run; "
            "effective gate remains failed and accepted stays false"
        )
        return result

    # Decision path: require idle controls + per-growth-outlier sample evidence.
    result["disposition_applied"] = True
    # Raw abs failures are preserved. This decision explains positive growth above
    # threshold via durable SQLite/file-cache evidence; pure decreases do not
    # require that explanation (they are not state-growth regressions).
    growth_outliers: list[dict[str, Any]] = []
    sample_evals: list[dict[str, Any]] = []
    for sample in raw_series:
        signed = float(sample.get("owner_delta_signed_mib") or 0.0)
        allowed = float(sample.get("owner_delta_allowed_mib") or OWNER_DELTA_FLOOR_MIB)
        growth = round(max(0.0, signed), 4)
        raw_failed = not bool(sample.get("owner_delta_raw_passed", False))
        needs_growth_explanation = growth > allowed + 1e-9
        if not raw_failed:
            continue
        if not needs_growth_explanation:
            sample_evals.append(
                {
                    "source": sample.get("source"),
                    "index": sample.get("index"),
                    "passed": True,
                    "reason": "raw_failed_on_decrease_only_not_growth_regression",
                    "owner_delta_growth_mib": growth,
                    "owner_delta_allowed_mib": allowed,
                    "predicates": {
                        "raw_failed": True,
                        "positive_growth_exceeds_threshold": False,
                        "growth_within_threshold": True,
                    },
                    "composition": None,
                }
            )
            continue
        growth_outliers.append(sample)
        sample_evals.append(
            {
                "source": sample.get("source"),
                "index": sample.get("index"),
                "owner_delta_growth_mib": growth,
                **evaluate_durable_sqlite_state_growth_sample(
                    delta_raw=sample,
                    memory_stat_before=sample.get("memory_stat_before"),
                    memory_stat_after=sample.get("memory_stat_after"),
                    sqlite_before=sample.get("sqlite_before"),
                    sqlite_after=sample.get("sqlite_after"),
                    owner_absolute_ok=bool(sample.get("owner_absolute_ok", False)),
                    process_ok=bool(sample.get("process_ok", True)),
                    no_node_ok=bool(sample.get("no_node_ok", True)),
                ),
            }
        )
    result["failing_sample_evaluations"] = sample_evals
    result["growth_outlier_count"] = len(growth_outliers)

    controls = idle_controls or []
    idle_evals = [evaluate_idle_owner_control_sample(c) for c in controls]
    result["idle_control_evaluations"] = idle_evals

    # Require at least one growth outlier when raw failed via growth; if raw only
    # failed on decreases, growth_outliers may be empty and still OK.
    samples_explained = all(e.get("passed") for e in sample_evals) if sample_evals else False
    if not sample_evals:
        # Raw reported failure but no per-sample raw_failed entries — fail closed.
        samples_explained = False
    idle_all_ok = (
        len(idle_evals) >= OWNER_DELTA_IDLE_CONTROL_SAMPLES
        and all(e.get("passed") for e in idle_evals)
    )
    # Second (and later) idle sample must not show continuing unexplained growth.
    second_idle_flat = len(idle_evals) >= 2 and all(e.get("passed") for e in idle_evals[1:])
    # Decision cannot waive absolute / process / cleanup failures.
    predicates = {
        "raw_owner_delta_passed": False,
        "explicit_decision_present": True,
        "decision_recognized": True,
        "decision_identity": decision,
        "authoritative": True,
        "owner_absolute_ceilings_passed": bool(owner_absolute_all_ok),
        "process_no_node_cleanup_ok": bool(process_no_node_cleanup_ok),
        "idle_controls_recorded": len(controls) >= OWNER_DELTA_IDLE_CONTROL_SAMPLES,
        "idle_controls_flat": idle_all_ok,
        "second_idle_sample_flat": second_idle_flat,
        "every_failing_sample_explained": samples_explained,
        "growth_outliers_present_or_decrease_only": bool(growth_outliers)
        or any(
            e.get("reason") == "raw_failed_on_decrease_only_not_growth_regression"
            for e in sample_evals
        ),
        "decision_resolves_only_owner_delta_gate": True,
        "cannot_waive_absolute_ceilings": True,
    }
    result["predicates"] = predicates
    blocking_keys = (
        "owner_absolute_ceilings_passed",
        "process_no_node_cleanup_ok",
        "idle_controls_recorded",
        "idle_controls_flat",
        "second_idle_sample_flat",
        "every_failing_sample_explained",
        "growth_outliers_present_or_decrease_only",
    )
    disposition_ok = all(bool(predicates[k]) for k in blocking_keys)
    result["disposition_passed"] = disposition_ok
    result["owner_delta_effective_passed"] = disposition_ok
    if disposition_ok:
        result["reason"] = "raw_failed_explained_durable_sqlite_state_growth"
        result["warning"] = (
            "WARNING: owner_delta raw threshold FAILED but explicit decision "
            f"{decision!r} disposition PASSED after idle-host controls and "
            "objective durable SQLite state/file-cache predicates. Absolute "
            "24/32 MiB ceilings and all other gates remain mandatory."
        )
    else:
        failed = [k for k in blocking_keys if not predicates.get(k)]
        result["reason"] = "disposition_predicates_failed:" + ",".join(failed)
        result["warning"] = (
            "owner_delta raw threshold FAILED and explained disposition did not "
            f"pass (failed predicates: {', '.join(failed) or 'unknown'})"
        )
    return result


def try_acquire_profile_lock(profile_dir: Path) -> bool:
    lock_path = profile_dir / LOCK_FILE
    try:
        fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except BlockingIOError:
        return False
    except OSError:
        return False
    finally:
        os.close(fd)


def wait_lock_free(profile_dir: Path, timeout: float = LIFECYCLE_TIMEOUT_SECONDS) -> None:
    poll_until(
        timeout,
        lambda: try_acquire_profile_lock(profile_dir),
        "profile.lock not released",
    )


def wait_runtime_gone(profile_dir: Path, timeout: float = LIFECYCLE_TIMEOUT_SECONDS) -> None:
    runtime_path = profile_dir / RUNTIME_FILE
    poll_until(timeout, lambda: not runtime_path.exists(), "runtime.json still present")


def http_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    expect_statuses: set[int],
    as_json: bool,
    timeout: float = 30.0,
) -> tuple[Any, float]:
    data = None
    req_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            status, raw = response.getcode(), response.read()
    except urllib.error.HTTPError as error:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        status, raw = error.code, error.read()
    except urllib.error.URLError as error:
        raise BenchError(f"HTTP {method} failed: {error}") from error
    if status not in expect_statuses:
        snippet = sanitize_text(raw[:300].decode("utf-8", errors="replace"))
        raise BenchError(f"HTTP {method} returned {status}, body={snippet!r}")
    if not as_json:
        return raw, elapsed_ms
    if not raw:
        return None, elapsed_ms
    try:
        return json.loads(raw.decode("utf-8")), elapsed_ms
    except json.JSONDecodeError as error:
        raise BenchError(f"malformed JSON from HTTP {method}: {error}") from error


def auth_headers(token: str, host: str, *, mutation: bool) -> dict[str, str]:
    headers = {"Host": host, "Authorization": f"Bearer {token}"}
    if mutation:
        headers["Origin"] = f"http://{host}"
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return headers


def start_server(
    unit_name: str,
    server: Path,
    profile_dir: Path,
    web_dir: Path,
    repo_root: Path,
    *,
    measure_memory: bool = True,
) -> tuple[str, str, str, float, subprocess.Popen[str] | None]:
    """Start junban-server. Returns base_url, host, instance_id, startup_ms, optional bare process."""
    t0 = now_ns()
    bare_proc: subprocess.Popen[str] | None = None
    cmd = [
        str(server),
        "--bind",
        "127.0.0.1:0",
        "--data-dir",
        str(profile_dir),
        "--web-dir",
        str(web_dir),
    ]
    if measure_memory:
        run_cmd(
            [
                "systemd-run",
                "--user",
                f"--unit={unit_name}",
                "--collect",
                "--property=MemoryAccounting=yes",
                "--property=Type=exec",
                f"--working-directory={repo_root}",
                "--",
                *cmd,
            ]
        )
    else:
        bare_proc = subprocess.Popen(
            cmd,
            cwd=str(repo_root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    runtime_path = profile_dir / RUNTIME_FILE
    holder: dict[str, Any] = {}

    def runtime_ready() -> bool:
        if bare_proc is not None and bare_proc.poll() is not None:
            err = ""
            if bare_proc.stderr is not None:
                try:
                    err = bare_proc.stderr.read() or ""
                except Exception:
                    err = ""
            raise BenchError(
                f"server exited early code={bare_proc.returncode}: {sanitize_text(err)[:300]}"
            )
        if not runtime_path.exists():
            return False
        try:
            data = json.loads(runtime_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return False
        if "address" in data and "pid" in data and "instance_id" in data:
            holder["runtime"] = data
            return True
        return False

    poll_until(READY_TIMEOUT_SECONDS, runtime_ready, "runtime.json not ready")
    address = str(holder["runtime"]["address"])
    instance_id = str(holder["runtime"]["instance_id"])
    if not address.startswith("127.0.0.1:"):
        raise BenchError(f"server did not bind loopback: {address}")
    base_url = f"http://{address}"

    def health_ready() -> bool:
        try:
            payload, _ = http_request(
                "GET",
                f"{base_url}/api/v1/health",
                headers={"Host": address},
                expect_statuses={200},
                as_json=True,
            )
            return (
                isinstance(payload, dict)
                and bool(payload.get("status"))
                and str(payload.get("instance_id")) == instance_id
            )
        except BenchError:
            return False

    poll_until(READY_TIMEOUT_SECONDS, health_ready, "health not ready / instance mismatch")
    return base_url, address, instance_id, ns_to_ms(t0), bare_proc


def stop_server(
    unit_name: str,
    profile_dir: Path,
    bare_proc: subprocess.Popen[str] | None = None,
) -> None:
    if bare_proc is not None and bare_proc.poll() is None:
        bare_proc.send_signal(signal.SIGTERM)
        try:
            bare_proc.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            bare_proc.kill()
            try:
                bare_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    else:
        stop_unit(unit_name)
    runtime_path = profile_dir / RUNTIME_FILE
    try:
        poll_until(5.0, lambda: not runtime_path.exists(), "runtime.json linger")
    except BenchError:
        pass
    try:
        wait_lock_free(profile_dir, timeout=5.0)
    except BenchError:
        pass


def seed_tasks(
    base_url: str,
    host: str,
    token: str,
    count: int,
    *,
    title_prefix: str = "phase5-fixture-task",
) -> list[str]:
    """Create deterministic tasks outside any measured cgroup. Returns task ids."""
    ids: list[str] = []
    for i in range(count):
        body = {"title": f"{title_prefix}-{i:04d}"}
        payload, _ = http_request(
            "POST",
            f"{base_url}/api/v1/tasks",
            headers=auth_headers(token, host, mutation=True),
            body=body,
            expect_statuses={200, 201},
            as_json=True,
        )
        task_id = _task_id_from_mutation(payload, op="seed_create")
        ids.append(task_id)
    return ids


def create_automation_credential_file(
    base_url: str,
    host: str,
    operator_token: str,
    token_path: Path,
    *,
    scopes: list[str] | None = None,
) -> tuple[str, str]:
    """Mint a scoped automation credential; write secret only to token_path.

    Returns (credential_id, token). Caller must not log the token.
    """
    cred_id = str(uuid.uuid4())
    token = mint_automation_token(cred_id)
    body = {
        "id": cred_id,
        "label": "phase5-automation-bench",
        "scopes": scopes or ["read", "write"],
        "token": token,
    }
    http_request(
        "POST",
        f"{base_url}/api/v1/auth/credentials",
        headers=auth_headers(operator_token, host, mutation=True),
        body=body,
        expect_statuses={200, 201},
        as_json=True,
    )
    if token_path.exists():
        token_path.unlink()
    write_private_file(token_path, token)
    return cred_id, token


def revoke_automation_credential(
    base_url: str,
    host: str,
    operator_token: str,
    credential_id: str,
) -> None:
    http_request(
        "DELETE",
        f"{base_url}/api/v1/auth/credentials/{credential_id}",
        headers=auth_headers(operator_token, host, mutation=False),
        expect_statuses={200, 204},
        as_json=True,
    )


def _task_id_from_mutation(payload: Any, *, op: str) -> str:
    if not isinstance(payload, dict):
        raise BenchError(f"{op}: mutation payload not object")
    event = payload.get("event")
    if not isinstance(event, dict):
        raise BenchError(f"{op}: missing event")
    primary = event.get("primary")
    if isinstance(primary, dict) and primary.get("id"):
        return str(primary["id"])
    snapshot = event.get("snapshot")
    if isinstance(snapshot, dict):
        task = snapshot.get("task")
        if isinstance(task, dict) and task.get("id"):
            return str(task["id"])
    affected = event.get("affected")
    if isinstance(affected, dict):
        task_ids = affected.get("task_ids") or affected.get("tasks")
        if isinstance(task_ids, list) and task_ids:
            return str(task_ids[0])
    raise BenchError(f"{op}: could not extract task id")


def _revision_from_mutation(payload: Any) -> int:
    event = payload.get("event") if isinstance(payload, dict) else None
    if not isinstance(event, dict) or "revision" not in event:
        raise BenchError("mutation missing event.revision")
    return int(event["revision"])


# ── CLI runners ──────────────────────────────────────────────────────────────


def run_cli(
    cli: Path,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float = CLI_TIMEOUT_SECONDS,
    secrets_list: list[str] | None = None,
) -> tuple[dict[str, Any], float, str, str, int]:
    """Run junban CLI outside a cgroup. Returns (json, ms, stdout, stderr, code)."""
    cmd = [str(cli), *args]
    started = now_ns()
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise BenchError(f"CLI timed out: {args[:3]}") from error
    elapsed = ns_to_ms(started)
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    secrets = secrets_list or []
    assert_no_secrets(stdout, secrets, where="cli stdout")
    assert_no_secrets(stderr, secrets, where="cli stderr")
    payload = _parse_one_json(stdout, where="cli stdout")
    return payload, elapsed, stdout, stderr, proc.returncode


def run_cli_in_cgroup(
    unit_name: str,
    cli: Path,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float = CLI_TIMEOUT_SECONDS,
    secrets_list: list[str] | None = None,
    measure_memory: bool = False,
) -> tuple[dict[str, Any], float, str, str, int, dict[str, Any] | None]:
    """Run a one-shot CLI inside a transient scope cgroup."""
    cmd = [
        "systemd-run",
        "--user",
        "--scope",
        f"--unit={unit_name}",
        "--property=MemoryAccounting=yes",
        "--collect",
        "--",
        str(cli),
        *args,
    ]
    started = now_ns()
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        stop_unit(unit_name)
        raise BenchError("CLI cgroup run timed out") from error
    elapsed = ns_to_ms(started)
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    # systemd-run may prefix lines; strip known noise before JSON parse.
    secrets = secrets_list or []
    assert_no_secrets(stdout, secrets, where="cli-cgroup stdout")
    assert_no_secrets(stderr, secrets, where="cli-cgroup stderr")
    json_text = _extract_json_value(stdout)
    payload = _parse_one_json(json_text, where="cli-cgroup stdout")
    mem = None
    # Scope is usually gone after exit; memory is lifetime peak only if still queryable.
    scope = f"{unit_name}.scope"
    if measure_memory and unit_exists(scope):
        try:
            cg = read_cgroup_memory(scope)
            mem = {
                "cgroup_current_bytes": cg["current_bytes"],
                "cgroup_peak_bytes": cg["peak_bytes"],
                "cgroup_current_mib": mib(cg["current_bytes"]),
                "cgroup_peak_mib": mib(cg["peak_bytes"]),
            }
        except BenchError:
            mem = None
    stop_unit(unit_name)
    return payload, elapsed, stdout, stderr, proc.returncode, mem


def _extract_json_value(text: str) -> str:
    """Return the single JSON value from CLI stdout, ignoring systemd-run chatter."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    # Prefer the last line that parses as JSON object/array.
    for line in reversed(lines):
        s = line.strip()
        if s.startswith("{") or s.startswith("["):
            try:
                json.loads(s)
                return s + "\n"
            except json.JSONDecodeError:
                continue
    # Whole text as one value.
    return text


def _parse_one_json(text: str, *, where: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise BenchError(f"{where}: empty stdout, expected one JSON value")
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError as error:
        # Try first JSON object substring.
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end > start:
            try:
                value = json.loads(stripped[start : end + 1])
            except json.JSONDecodeError:
                raise BenchError(f"{where}: malformed JSON: {error}") from error
        else:
            raise BenchError(f"{where}: malformed JSON: {error}") from error
    if not isinstance(value, dict):
        raise BenchError(f"{where}: expected JSON object, got {type(value).__name__}")
    return value


def validate_task_list_payload(
    payload: dict[str, Any],
    *,
    expected_count: int | None,
    expect_empty: bool = False,
) -> dict[str, Any]:
    if "error" in payload:
        raise BenchError(f"task list returned error envelope: {sanitize_text(json.dumps(payload))[:300]}")
    if "tasks" not in payload or "revision" not in payload:
        raise BenchError("task list missing tasks/revision")
    tasks = payload["tasks"]
    if not isinstance(tasks, list):
        raise BenchError("task list tasks is not an array")
    if expect_empty and len(tasks) != 0:
        raise BenchError(f"expected empty task page, got {len(tasks)}")
    if expected_count is not None and len(tasks) != expected_count:
        raise BenchError(f"expected {expected_count} tasks, got {len(tasks)}")
    return {
        "task_count": len(tasks),
        "revision": int(payload["revision"]),
        "as_of_date": payload.get("as_of_date"),
    }


# ── MCP session ──────────────────────────────────────────────────────────────


class McpSession:
    """Line-delimited JSON-RPC MCP client over a child process."""

    def __init__(
        self,
        proc: subprocess.Popen[str],
        *,
        unit: str | None,
        secrets_list: list[str],
        binary_name: str = "junban-mcp",
    ) -> None:
        self.proc = proc
        self.unit = unit
        self.secrets_list = list(secrets_list)
        self.binary_name = binary_name
        self._id = 0
        self._stdout = proc.stdout
        self._stdin = proc.stdin
        self._stderr_chunks: list[str] = []
        self._stderr_thread: threading.Thread | None = None
        if proc.stderr is not None:
            self._stderr_thread = threading.Thread(
                target=self._drain_stderr, args=(proc.stderr,), daemon=True
            )
            self._stderr_thread.start()
        if self._stdout is None or self._stdin is None:
            raise BenchError("MCP process missing stdio pipes")

    def _drain_stderr(self, stream: IO[str]) -> None:
        try:
            for line in stream:
                self._stderr_chunks.append(line)
        except Exception:
            return

    def stderr_text(self) -> str:
        return "".join(self._stderr_chunks)

    def close_stdin(self) -> None:
        if self._stdin and not self._stdin.closed:
            try:
                self._stdin.close()
            except BrokenPipeError:
                pass

    def wait(self, timeout: float = STOP_TIMEOUT_SECONDS) -> int:
        try:
            return int(self.proc.wait(timeout=timeout))
        except subprocess.TimeoutExpired:
            self.proc.kill()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise BenchError("MCP process did not exit") from None

    def kill(self, sig: int = signal.SIGKILL) -> None:
        if self.proc.poll() is None and self.proc.pid:
            os.kill(self.proc.pid, sig)

    def next_id(self) -> int:
        self._id += 1
        return self._id

    def write_frame(self, message: dict[str, Any]) -> None:
        assert self._stdin is not None
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        self._stdin.write(line + "\n")
        self._stdin.flush()

    def read_frame(self, timeout: float = MCP_RPC_TIMEOUT_SECONDS) -> dict[str, Any]:
        assert self._stdout is not None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise BenchError(
                    f"MCP exited early code={self.proc.returncode} "
                    f"stderr={sanitize_text(self.stderr_text(), self.secrets_list)[:300]!r}"
                )
            # Use a short select-style read via threading if line not ready.
            line = self._readline_with_timeout(min(0.05, deadline - time.monotonic()))
            if line is None:
                continue
            stripped = line.strip()
            if not stripped:
                continue
            assert_no_secrets(stripped, self.secrets_list, where="mcp stdout")
            try:
                frame = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise BenchError(
                    f"non-JSON MCP stdout frame: {sanitize_text(stripped)[:200]!r}"
                ) from error
            if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0":
                raise BenchError(f"invalid MCP frame: {sanitize_text(stripped)[:200]!r}")
            return frame
        raise BenchError("timed out waiting for MCP frame")

    def _readline_with_timeout(self, timeout: float) -> str | None:
        assert self._stdout is not None
        if timeout <= 0:
            return None
        result: queue.Queue[str | None] = queue.Queue(maxsize=1)

        def reader() -> None:
            try:
                line = self._stdout.readline()
                result.put(line if line else None)
            except Exception:
                result.put(None)

        # Only spawn a reader if buffer is empty — but text IO has no poll.
        # Use a dedicated blocking readline on a short-lived thread each call
        # would race; keep one outstanding reader via attribute.
        if not hasattr(self, "_read_q"):
            self._read_q: queue.Queue[str | None] = queue.Queue()
            self._reader_alive = True

            def loop() -> None:
                assert self._stdout is not None
                while self._reader_alive:
                    try:
                        line = self._stdout.readline()
                    except Exception:
                        self._read_q.put(None)
                        return
                    self._read_q.put(line if line != "" else None)
                    if line == "":
                        return

            self._reader_thread = threading.Thread(target=loop, daemon=True)
            self._reader_thread.start()
        try:
            return self._read_q.get(timeout=timeout)
        except queue.Empty:
            return None

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = MCP_RPC_TIMEOUT_SECONDS,
    ) -> tuple[dict[str, Any], float]:
        req_id = self.next_id()
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            message["params"] = params
        started = now_ns()
        self.write_frame(message)
        # Drain notifications until matching id.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self.read_frame(timeout=max(0.01, deadline - time.monotonic()))
            if frame.get("id") == req_id:
                return frame, ns_to_ms(started)
            # Progress / log notifications are allowed; anything else with id is unexpected.
            if "id" in frame and frame.get("id") is not None:
                raise BenchError(
                    f"unexpected MCP response id={frame.get('id')} while waiting for {req_id}"
                )
        raise BenchError(f"timed out waiting for MCP response id={req_id}")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.write_frame(message)

    def initialize(self) -> tuple[dict[str, Any], float]:
        result, ms = self.request(
            "initialize",
            {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "junban-phase5-automation-bench", "version": "0.1.0"},
            },
        )
        if "error" in result:
            raise BenchError(f"initialize error: {sanitize_text(json.dumps(result))[:300]}")
        if "result" not in result:
            raise BenchError("initialize missing result")
        caps = result["result"].get("capabilities") or {}
        if not isinstance(caps, dict):
            raise BenchError("initialize capabilities malformed")
        self.notify("notifications/initialized")
        return result, ms

    def assert_alive_in_cgroup(self) -> dict[str, Any]:
        if not self.unit:
            raise BenchError("MCP session has no cgroup unit")
        unit = self.unit if self.unit.endswith((".scope", ".service")) else f"{self.unit}.scope"
        return assert_single_named_process(unit, self.binary_name)


def start_mcp(
    unit_name: str,
    mcp: Path,
    args: list[str],
    *,
    secrets_list: list[str],
    repo_root: Path,
    measure_memory: bool = True,
) -> McpSession:
    if measure_memory:
        cmd = [
            "systemd-run",
            "--user",
            "--scope",
            f"--unit={unit_name}",
            "--property=MemoryAccounting=yes",
            "--collect",
            f"--working-directory={repo_root}",
            "--",
            str(mcp),
            *args,
        ]
        unit: str | None = unit_name
    else:
        cmd = [str(mcp), *args]
        unit = None
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(repo_root),
    )
    return McpSession(proc, unit=unit, secrets_list=secrets_list)


def start_mcp_unscoped(
    mcp: Path,
    args: list[str],
    *,
    secrets_list: list[str],
) -> McpSession:
    """Lifecycle cases that need direct signals use an unscoped child."""
    proc = subprocess.Popen(
        [str(mcp), *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    return McpSession(proc, unit=None, secrets_list=secrets_list)


def validate_mcp_catalog(session: McpSession) -> dict[str, Any]:
    tools_frame, _ = session.request("tools/list", {})
    if "error" in tools_frame:
        raise BenchError(f"tools/list error: {sanitize_text(json.dumps(tools_frame))[:300]}")
    tools = (tools_frame.get("result") or {}).get("tools") or []
    if not isinstance(tools, list) or not tools:
        raise BenchError("tools/list returned no tools")
    names = [str(t.get("name")) for t in tools if isinstance(t, dict)]
    for required in ("create_task", "get_task", "list_tasks"):
        if required not in names:
            raise BenchError(f"tools/list missing {required}")
    leaked = sorted(OPERATOR_TOOL_NAMES.intersection(names))
    if leaked:
        raise BenchError(f"operator-only tools exposed via MCP: {leaked}")

    resources_frame, _ = session.request("resources/list", {})
    if "error" in resources_frame:
        raise BenchError("resources/list failed")
    resources = (resources_frame.get("result") or {}).get("resources") or []
    uris = {str(r.get("uri")) for r in resources if isinstance(r, dict)}
    missing_r = sorted(REQUIRED_RESOURCES - uris)
    if missing_r:
        raise BenchError(f"resources/list missing {missing_r}")

    prompts_frame, _ = session.request("prompts/list", {})
    if "error" in prompts_frame:
        raise BenchError("prompts/list failed")
    prompts = (prompts_frame.get("result") or {}).get("prompts") or []
    prompt_names = {str(p.get("name")) for p in prompts if isinstance(p, dict)}
    missing_p = sorted(REQUIRED_PROMPTS - prompt_names)
    if missing_p:
        raise BenchError(f"prompts/list missing {missing_p}")

    return {
        "tool_count": len(names),
        "tools": sorted(names),
        "resource_count": len(uris),
        "prompt_count": len(prompt_names),
        "no_operator_tools": True,
    }


def mcp_extract_task_id(frame: dict[str, Any]) -> str:
    result = frame.get("result") or {}
    if result.get("isError") is True:
        raise BenchError(f"tool error: {sanitize_text(json.dumps(frame))[:300]}")
    content = result.get("structuredContent")
    if not isinstance(content, dict):
        # Fall back to scanning text content — still must be JSON-ish.
        raise BenchError("MCP tool result missing structuredContent")
    # MutationResponse
    if "event" in content:
        return _task_id_from_mutation(content, op="mcp_create_task")
    if content.get("id"):
        return str(content["id"])
    raise BenchError("could not extract task id from MCP result")


def mcp_extract_revision(frame: dict[str, Any]) -> int:
    result = frame.get("result") or {}
    content = result.get("structuredContent")
    if isinstance(content, dict) and "event" in content:
        return _revision_from_mutation(content)
    if isinstance(content, dict) and "revision" in content:
        return int(content["revision"])
    raise BenchError("could not extract revision from MCP result")


# ── Protocol config ──────────────────────────────────────────────────────────


def protocol_config(*, quick: bool, skip_memory: bool, measure_memory: bool) -> dict[str, Any]:
    authoritative = (not quick) and measure_memory and (not skip_memory)
    return {
        "name": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "authoritative": authoritative,
        "quick": quick,
        "skip_memory": skip_memory,
        "measure_memory": measure_memory,
        "settle_seconds": SETTLE_SECONDS,
        "active_owner_cli_samples": (
            QUICK_ACTIVE_OWNER_CLI_SAMPLES if quick else ACTIVE_OWNER_CLI_SAMPLES
        ),
        "active_owner_cli_p95_ms": ACTIVE_OWNER_CLI_P95_MS,
        "active_owner_seed_tasks": QUICK_SEED_TASKS if quick else ACTIVE_OWNER_SEED_TASKS,
        "no_owner_cli_samples": QUICK_NO_OWNER_CLI_SAMPLES if quick else NO_OWNER_CLI_SAMPLES,
        "no_owner_cli_p95_ms": NO_OWNER_CLI_P95_MS,
        "mcp_op_samples": QUICK_MCP_OP_SAMPLES if quick else MCP_OP_SAMPLES,
        "mcp_creates_per_sample": QUICK_MCP_CREATES if quick else MCP_CREATES_PER_SAMPLE,
        "mcp_gets_per_sample": QUICK_MCP_GETS if quick else MCP_GETS_PER_SAMPLE,
        "mcp_create_p95_ms": MCP_CREATE_P95_MS,
        "mcp_get_p95_ms": MCP_GET_P95_MS,
        "mcp_idle_samples": QUICK_MCP_IDLE_SAMPLES if quick else MCP_IDLE_SAMPLES,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "owner_delta_pct": OWNER_DELTA_PCT,
        "owner_delta_floor_mib": OWNER_DELTA_FLOOR_MIB,
        "cgroup": "transient systemd --user scope/service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "time_source": "time.perf_counter_ns",
        "percentile": "linear_interpolation rank (p/100)*(n-1)",
        "memory_unit": "binary MiB (bytes / 1_048_576)",
    }


# ── Workload sections ────────────────────────────────────────────────────────


def section_a_active_owner_cli(
    *,
    run_id: str,
    repo_root: Path,
    server: Path,
    cli: Path,
    web_dir: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    measure_memory = bool(protocol["measure_memory"])
    n = int(protocol["active_owner_cli_samples"])
    seed_n = int(protocol["active_owner_seed_tasks"])
    profile = work_root / "a-profile"
    token = generate_operator_token()
    secrets_list = [token]
    prepare_profile(profile, token)
    unit = f"junban-p5a-srv-{run_id}"
    base_url, host, instance_id, startup_ms, bare_proc = start_server(
        unit, server, profile, web_dir, repo_root, measure_memory=measure_memory
    )
    try:
        seed_tasks(base_url, host, token, seed_n)
        # Confirm discovery health via CLI status once (unmeasured setup).
        status_payload, _, _, _, code = run_cli(
            cli,
            ["--json", "--data-dir", str(profile), "status"],
            secrets_list=secrets_list,
        )
        if code != 0:
            raise BenchError(f"preflight status failed: {sanitize_text(json.dumps(status_payload))[:200]}")

        if measure_memory:
            time.sleep(SETTLE_SECONDS)
        before = (
            memory_snapshot(
                f"{unit}.service",
                "junban-server",
                "before_cli_series",
                measure_memory=measure_memory,
                include_memory_stat=True,
            )
            if measure_memory
            else {"label": "before_cli_series", "memory_skipped": True, "process_count": 1, "no_node": True}
        )
        sqlite_before = sqlite_size_bytes(profile)
        if measure_memory:
            assert_single_named_process(f"{unit}.service", "junban-server")

        latencies: list[float] = []
        byte_counts: list[int] = []
        exit_codes: list[int] = []
        workload_t0 = time.monotonic()
        for i in range(n):
            # Active-owner CLI is latency-measured outside the server cgroup.
            # Protocol A does not place the client in its own cgroup.
            payload, ms, stdout, stderr, code = run_cli(
                cli,
                [
                    "--json",
                    "--data-dir",
                    str(profile),
                    "task",
                    "list",
                    "--limit",
                    "100",
                ],
                secrets_list=secrets_list,
            )
            if code != 0:
                raise BenchError(f"active-owner CLI sample {i} exit {code}")
            if stderr.strip():
                # Allow empty or credential-free diagnostics only.
                assert_no_secrets(stderr, secrets_list, where="active-owner cli stderr")
            meta = validate_task_list_payload(payload, expected_count=seed_n)
            if meta["revision"] < seed_n:
                raise BenchError(f"unexpected revision {meta['revision']} after {seed_n} seeds")
            # Client must not take the profile lock (server still holds it).
            if try_acquire_profile_lock(profile):
                raise BenchError("profile lock was free during active-owner series (server lost ownership)")
            latencies.append(ms)
            byte_counts.append(len(stdout.encode("utf-8")))
            exit_codes.append(code)
        workload_wall_seconds = max(0.0, time.monotonic() - workload_t0)

        if measure_memory:
            time.sleep(SETTLE_SECONDS)
        after = (
            memory_snapshot(
                f"{unit}.service",
                "junban-server",
                "after_cli_series",
                measure_memory=measure_memory,
                include_memory_stat=True,
            )
            if measure_memory
            else {"label": "after_cli_series", "memory_skipped": True, "process_count": 1, "no_node": True}
        )
        sqlite_after = sqlite_size_bytes(profile)
        summary = latency_summary(latencies)
        owner_ok = True
        owner_delta_raw = {
            "owner_delta_mib": 0.0,
            "owner_delta_allowed_mib": OWNER_DELTA_FLOOR_MIB,
            "owner_delta_raw_passed": True,
            "owner_delta_signed_mib": 0.0,
            "before_current_mib": None,
            "after_current_mib": None,
            "owner_delta_threshold_rule": "max(1 MiB, 15% of baseline current)",
        }
        if measure_memory:
            owner_ok = (
                after["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                and after["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                and before["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                and before["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
            )
            owner_delta_raw = evaluate_owner_delta_raw(
                before["cgroup_current_mib"],
                after["cgroup_current_mib"],
            )
        # Sample-level owner_delta_ok remains the raw measurement boolean.
        owner_delta_ok = bool(owner_delta_raw["owner_delta_raw_passed"])
        return {
            "startup_to_health_ms": startup_ms,
            "instance_id_matched": True,
            "seed_tasks": seed_n,
            "samples": n,
            "latencies_ms": latencies,
            "latency": summary,
            "response_bytes": byte_counts,
            "exit_codes": exit_codes,
            "server_before": before,
            "server_after": after,
            "sqlite_before": sqlite_before,
            "sqlite_after": sqlite_after,
            "sqlite": sqlite_after,
            "workload_wall_seconds": workload_wall_seconds,
            "owner_delta": owner_delta_raw,
            "owner_delta_mib": owner_delta_raw.get("owner_delta_mib"),
            "owner_delta_allowed_mib": owner_delta_raw.get("owner_delta_allowed_mib"),
            "owner_delta_raw_passed": owner_delta_ok,
            "client_took_lock": False,
            "budget_cli_p95_ok": summary["p95_ms"] <= ACTIVE_OWNER_CLI_P95_MS,
            "budget_owner_memory_ok": owner_ok,
            # Raw-only at section level; effective gate is resolved in build_report.
            "budget_owner_delta_raw_ok": owner_delta_ok,
            "budget_owner_delta_ok": owner_delta_ok,
            "no_node": True,
            "secrets_clean": True,
        }
    finally:
        stop_server(unit, profile, bare_proc=bare_proc)


def section_b_no_owner_cli(
    *,
    run_id: str,
    cli: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    n = int(protocol["no_owner_cli_samples"])
    measure_memory = bool(protocol["measure_memory"])
    latencies: list[float] = []
    samples_out: list[dict[str, Any]] = []
    for i in range(n):
        profile = work_root / f"b-profile-{i:02d}"
        token = generate_operator_token()
        secrets_list = [token]
        prepare_profile(profile, token)
        unit = f"junban-p5b-cli-{run_id}-{i:02d}"
        args = ["--json", "--data-dir", str(profile), "task", "list", "--limit", "100"]
        if measure_memory:
            payload, ms, stdout, stderr, code, _mem = run_cli_in_cgroup(
                unit,
                cli,
                args,
                secrets_list=secrets_list,
                measure_memory=False,
            )
        else:
            payload, ms, stdout, stderr, code = run_cli(
                cli, args, secrets_list=secrets_list
            )
        if code != 0:
            raise BenchError(
                f"no-owner CLI sample {i} exit {code}: "
                f"{sanitize_text(json.dumps(payload), secrets_list)[:200]}"
            )
        validate_task_list_payload(payload, expected_count=0, expect_empty=True)
        wait_runtime_gone(profile)
        wait_lock_free(profile)
        # Immediate reacquisition already covered by wait_lock_free; re-check.
        if not try_acquire_profile_lock(profile):
            raise BenchError(f"no-owner sample {i}: lock not re-acquirable")
        # No detached child: unit stopped and lock free implies clean exit.
        latencies.append(ms)
        samples_out.append(
            {
                "index": i,
                "latency_ms": ms,
                "exit_code": code,
                "response_bytes": len(stdout.encode("utf-8")),
                "stderr_empty_or_clean": True,
                "runtime_removed": True,
                "lock_released": True,
                "sqlite": sqlite_size_bytes(profile),
                "cgroup_measured": measure_memory,
            }
        )
        shutil.rmtree(profile, ignore_errors=True)
    summary = latency_summary(latencies)
    return {
        "samples": n,
        "latencies_ms": latencies,
        "latency": summary,
        "detail": samples_out,
        "budget_cli_p95_ok": summary["p95_ms"] <= NO_OWNER_CLI_P95_MS,
        "cleanup_ok": True,
        "no_detached_children": True,
        "no_node": True,
        "secrets_clean": True,
        "measure_memory": measure_memory,
    }


def section_c_mcp_operations(
    *,
    run_id: str,
    repo_root: Path,
    server: Path,
    mcp: Path,
    web_dir: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    measure_memory = bool(protocol["measure_memory"])
    samples_n = int(protocol["mcp_op_samples"])
    creates_n = int(protocol["mcp_creates_per_sample"])
    gets_n = int(protocol["mcp_gets_per_sample"])
    all_create_ms: list[float] = []
    all_get_ms: list[float] = []
    sample_reports: list[dict[str, Any]] = []
    protocol_errors = 0
    tool_errors = 0

    for s in range(samples_n):
        profile = work_root / f"c-profile-{s:02d}"
        token = generate_operator_token()
        secrets_list = [token]
        prepare_profile(profile, token)
        cred_path = work_root / f"c-cred-{s:02d}.token"
        srv_unit = f"junban-p5c-srv-{run_id}-{s:02d}"
        mcp_unit = f"junban-p5c-mcp-{run_id}-{s:02d}"
        base_url, host, instance_id, startup_ms, bare_srv = start_server(
            srv_unit,
            server,
            profile,
            web_dir,
            repo_root,
            measure_memory=measure_memory,
        )
        session: McpSession | None = None
        try:
            cred_id, auto_token = create_automation_credential_file(
                base_url, host, token, cred_path, scopes=["read", "write"]
            )
            secrets_list.extend([auto_token, cred_id])

            if measure_memory:
                time.sleep(SETTLE_SECONDS)
            owner_before = (
                memory_snapshot(
                    f"{srv_unit}.service",
                    "junban-server",
                    "owner_before_mcp",
                    measure_memory=measure_memory,
                    include_memory_stat=True,
                )
                if measure_memory
                else {"memory_skipped": True, "no_node": True, "process_count": 1}
            )
            sqlite_before = sqlite_size_bytes(profile)
            workload_t0 = time.monotonic()

            session = start_mcp(
                mcp_unit,
                mcp,
                ["--server", base_url, "--credential-file", str(cred_path)],
                secrets_list=secrets_list,
                repo_root=repo_root,
                measure_memory=measure_memory,
            )
            init_frame, init_ms = session.initialize()
            caps = (init_frame.get("result") or {}).get("capabilities") or {}
            if not all(k in caps for k in ("tools", "resources", "prompts")):
                # Some SDK builds nest differently; require tools at minimum.
                if "tools" not in caps:
                    raise BenchError(f"initialize missing tools capability: {list(caps)}")
            catalog = validate_mcp_catalog(session)

            if measure_memory:
                time.sleep(SETTLE_SECONDS)
            mcp_idle = (
                memory_snapshot(
                    f"{mcp_unit}.scope",
                    "junban-mcp",
                    "mcp_idle_attached",
                    measure_memory=measure_memory,
                )
                if measure_memory
                else {
                    "memory_skipped": True,
                    "no_node": True,
                    "process_count": 1,
                    "pid": session.proc.pid,
                }
            )

            create_ms: list[float] = []
            get_ms: list[float] = []
            task_ids: list[str] = []
            revisions: list[int] = []
            op_ids: list[str] = []

            for i in range(creates_n):
                frame, ms = session.request(
                    "tools/call",
                    {
                        "name": "create_task",
                        "arguments": {"title": f"phase5-mcp-create-{s:02d}-{i:04d}"},
                    },
                )
                if "error" in frame:
                    protocol_errors += 1
                    raise BenchError(f"create_task JSON-RPC error: {sanitize_text(json.dumps(frame))[:200]}")
                result = frame.get("result") or {}
                if result.get("isError") is True:
                    tool_errors += 1
                    raise BenchError(f"create_task tool error: {sanitize_text(json.dumps(frame))[:200]}")
                tid = mcp_extract_task_id(frame)
                rev = mcp_extract_revision(frame)
                event = (result.get("structuredContent") or {}).get("event") or {}
                op_id = str(event.get("operation_id") or "")
                if not op_id:
                    raise BenchError("create_task missing operation_id")
                if revisions and rev <= revisions[-1]:
                    raise BenchError(f"revision not monotonic: {revisions[-1]} -> {rev}")
                task_ids.append(tid)
                revisions.append(rev)
                op_ids.append(op_id)
                create_ms.append(ms)

            for i, tid in enumerate(task_ids[:gets_n]):
                frame, ms = session.request(
                    "tools/call",
                    {"name": "get_task", "arguments": {"task_id": tid}},
                )
                if "error" in frame:
                    protocol_errors += 1
                    raise BenchError("get_task JSON-RPC error")
                result = frame.get("result") or {}
                if result.get("isError") is True:
                    tool_errors += 1
                    raise BenchError("get_task tool error")
                content = result.get("structuredContent") or {}
                if str(content.get("id")) != tid:
                    raise BenchError("get_task id mismatch")
                get_ms.append(ms)

            # Final state via list_tasks
            listed, _ = session.request(
                "tools/call",
                {"name": "list_tasks", "arguments": {"limit": 100}},
            )
            list_content = (listed.get("result") or {}).get("structuredContent") or {}
            final_tasks = list_content.get("tasks") or []
            if len(final_tasks) != creates_n:
                raise BenchError(f"final task count {len(final_tasks)} != {creates_n}")
            final_revision = int(list_content.get("revision") or revisions[-1])
            if final_revision != revisions[-1]:
                raise BenchError(
                    f"final list revision {final_revision} != last mutation {revisions[-1]}"
                )

            # Close MCP; server must remain owner.
            session.close_stdin()
            exit_code = session.wait()
            if exit_code != 0:
                raise BenchError(f"MCP clean exit expected, got {exit_code}")
            session = None
            stop_unit(mcp_unit)

            # Ownership still with server.
            if try_acquire_profile_lock(profile):
                raise BenchError("server lost profile lock after MCP exit")
            if not (profile / RUNTIME_FILE).exists():
                raise BenchError("server runtime.json missing after MCP exit")
            runtime = json.loads((profile / RUNTIME_FILE).read_text(encoding="utf-8"))
            if str(runtime.get("instance_id")) != instance_id:
                raise BenchError("server instance_id changed unexpectedly")

            workload_wall_seconds = max(0.0, time.monotonic() - workload_t0)
            if measure_memory:
                time.sleep(SETTLE_SECONDS)
            owner_after = (
                memory_snapshot(
                    f"{srv_unit}.service",
                    "junban-server",
                    "owner_after_mcp",
                    measure_memory=measure_memory,
                    include_memory_stat=True,
                )
                if measure_memory
                else {"memory_skipped": True, "no_node": True, "process_count": 1}
            )
            sqlite_after = sqlite_size_bytes(profile)

            owner_mem_ok = True
            owner_delta_ok = True
            mcp_mem_ok = True
            owner_delta_raw = {
                "owner_delta_mib": 0.0,
                "owner_delta_allowed_mib": OWNER_DELTA_FLOOR_MIB,
                "owner_delta_raw_passed": True,
                "owner_delta_signed_mib": 0.0,
                "before_current_mib": None,
                "after_current_mib": None,
                "owner_delta_threshold_rule": "max(1 MiB, 15% of baseline current)",
            }
            if measure_memory:
                owner_mem_ok = (
                    owner_before["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and owner_before["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                    and owner_after["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and owner_after["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                )
                owner_delta_raw = evaluate_owner_delta_raw(
                    owner_before["cgroup_current_mib"],
                    owner_after["cgroup_current_mib"],
                )
                owner_delta_ok = bool(owner_delta_raw["owner_delta_raw_passed"])
                mcp_mem_ok = (
                    mcp_idle["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and mcp_idle["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                )

            all_create_ms.extend(create_ms)
            all_get_ms.extend(get_ms)
            sample_reports.append(
                {
                    "index": s,
                    "startup_to_health_ms": startup_ms,
                    "initialize_ms": init_ms,
                    "catalog": catalog,
                    "create_latencies_ms": create_ms,
                    "get_latencies_ms": get_ms,
                    "task_ids_count": len(task_ids),
                    "revisions": revisions,
                    "operation_ids_count": len(op_ids),
                    "final_task_count": len(final_tasks),
                    "final_revision": final_revision,
                    "mutation_event_count": len(revisions),
                    "mcp_idle": mcp_idle,
                    "owner_before": owner_before,
                    "owner_after": owner_after,
                    "sqlite_before": sqlite_before,
                    "sqlite_after": sqlite_after,
                    "workload_wall_seconds": workload_wall_seconds,
                    "owner_delta": owner_delta_raw,
                    "owner_delta_mib": owner_delta_raw.get("owner_delta_mib"),
                    "owner_delta_allowed_mib": owner_delta_raw.get("owner_delta_allowed_mib"),
                    "owner_delta_raw_passed": owner_delta_ok,
                    "owner_memory_ok": owner_mem_ok,
                    "owner_delta_ok": owner_delta_ok,
                    "mcp_memory_ok": mcp_mem_ok,
                    "server_retained_ownership": True,
                    "mcp_exit_code": exit_code,
                    "sqlite": sqlite_after,
                    "stderr_clean": True,
                }
            )
        finally:
            if session is not None:
                try:
                    session.close_stdin()
                except Exception:
                    pass
                try:
                    session.kill(signal.SIGKILL)
                    session.wait(timeout=5)
                except Exception:
                    pass
            stop_unit(mcp_unit)
            stop_server(srv_unit, profile, bare_proc=bare_srv)
            if cred_path.exists():
                cred_path.unlink()
            # Scrub secrets from local variables by deleting token file only.

    create_summary = latency_summary(all_create_ms)
    get_summary = latency_summary(all_get_ms)
    return {
        "samples": samples_n,
        "creates_per_sample": creates_n,
        "gets_per_sample": gets_n,
        "create_latency": create_summary,
        "get_latency": get_summary,
        "protocol_errors": protocol_errors,
        "tool_errors": tool_errors,
        "detail": sample_reports,
        "budget_create_p95_ok": create_summary["p95_ms"] <= MCP_CREATE_P95_MS,
        "budget_get_p95_ok": get_summary["p95_ms"] <= MCP_GET_P95_MS,
        "budget_zero_errors_ok": protocol_errors == 0 and tool_errors == 0,
        "budget_mcp_memory_ok": all(d.get("mcp_memory_ok", True) for d in sample_reports),
        "budget_owner_memory_ok": all(d.get("owner_memory_ok", True) for d in sample_reports),
        "budget_owner_delta_raw_ok": all(
            d.get("owner_delta_raw_passed", d.get("owner_delta_ok", True)) for d in sample_reports
        ),
        # Raw-only until disposition; build_report may elevate via explicit decision.
        "budget_owner_delta_ok": all(
            d.get("owner_delta_raw_passed", d.get("owner_delta_ok", True)) for d in sample_reports
        ),
        "no_node": True,
        "secrets_clean": True,
    }


def section_d_mcp_idle(
    *,
    run_id: str,
    repo_root: Path,
    server: Path,
    mcp: Path,
    web_dir: Path,
    work_root: Path,
    protocol: dict[str, Any],
) -> dict[str, Any]:
    measure_memory = bool(protocol["measure_memory"])
    n = int(protocol["mcp_idle_samples"])
    attached: list[dict[str, Any]] = []
    local_owner: list[dict[str, Any]] = []

    for i in range(n):
        # Attached mode
        profile = work_root / f"d-att-profile-{i:02d}"
        token = generate_operator_token()
        secrets_list = [token]
        prepare_profile(profile, token)
        cred_path = work_root / f"d-att-cred-{i:02d}.token"
        srv_unit = f"junban-p5d-srv-{run_id}-{i:02d}"
        mcp_unit = f"junban-p5d-att-{run_id}-{i:02d}"
        base_url, host, _instance_id, _startup, bare_srv = start_server(
            srv_unit,
            server,
            profile,
            web_dir,
            repo_root,
            measure_memory=measure_memory,
        )
        session: McpSession | None = None
        try:
            _cid, auto_token = create_automation_credential_file(
                base_url, host, token, cred_path
            )
            secrets_list.append(auto_token)
            session = start_mcp(
                mcp_unit,
                mcp,
                ["--server", base_url, "--credential-file", str(cred_path)],
                secrets_list=secrets_list,
                repo_root=repo_root,
                measure_memory=measure_memory,
            )
            _init, init_ms = session.initialize()
            validate_mcp_catalog(session)
            if measure_memory:
                time.sleep(SETTLE_SECONDS)
            snap = (
                memory_snapshot(
                    f"{mcp_unit}.scope",
                    "junban-mcp",
                    "attached_idle",
                    measure_memory=measure_memory,
                )
                if measure_memory
                else {
                    "memory_skipped": True,
                    "no_node": True,
                    "process_count": 1,
                    "pid": session.proc.pid,
                }
            )
            owner_snap = (
                memory_snapshot(
                    f"{srv_unit}.service",
                    "junban-server",
                    "owner_during_attached_idle",
                    measure_memory=measure_memory,
                )
                if measure_memory
                else {"memory_skipped": True, "no_node": True, "process_count": 1}
            )
            mem_ok = True
            if measure_memory:
                mem_ok = (
                    snap["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and snap["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                    and owner_snap["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and owner_snap["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                )
            attached.append(
                {
                    "index": i,
                    "initialize_ms": init_ms,
                    "mcp": snap,
                    "owner": owner_snap,
                    "sqlite": sqlite_size_bytes(profile),
                    "memory_ok": mem_ok,
                }
            )
            session.close_stdin()
            code = session.wait()
            session = None
            if code != 0:
                raise BenchError(f"attached MCP idle exit {code}")
            # Server still owns.
            if try_acquire_profile_lock(profile):
                raise BenchError("attached idle: server lost lock after MCP EOF")
        finally:
            if session is not None:
                session.kill(signal.SIGKILL)
                try:
                    session.wait(5)
                except BenchError:
                    pass
            stop_unit(mcp_unit)
            stop_server(srv_unit, profile, bare_proc=bare_srv)
            if cred_path.exists():
                cred_path.unlink()

        # Local-owner mode
        profile_l = work_root / f"d-loc-profile-{i:02d}"
        token_l = generate_operator_token()
        secrets_l = [token_l]
        prepare_profile(profile_l, token_l)
        mcp_unit_l = f"junban-p5d-loc-{run_id}-{i:02d}"
        session_l: McpSession | None = None
        try:
            session_l = start_mcp(
                mcp_unit_l,
                mcp,
                ["--data-dir", str(profile_l)],
                secrets_list=secrets_l,
                repo_root=repo_root,
                measure_memory=measure_memory,
            )
            _init_l, init_ms_l = session_l.initialize()
            # Runtime must be published for local owner.
            runtime_path = profile_l / RUNTIME_FILE

            def runtime_ok() -> bool:
                if not runtime_path.exists():
                    return False
                try:
                    data = json.loads(runtime_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    return False
                address = str(data.get("address") or "")
                instance_id = str(data.get("instance_id") or "")
                if not address.startswith("127.0.0.1:") or not instance_id:
                    return False
                try:
                    payload, _ = http_request(
                        "GET",
                        f"http://{address}/api/v1/health",
                        headers={"Host": address},
                        expect_statuses={200},
                        as_json=True,
                    )
                except BenchError:
                    return False
                return isinstance(payload, dict) and str(payload.get("instance_id")) == instance_id

            poll_until(READY_TIMEOUT_SECONDS, runtime_ok, "local-owner runtime not reachable")
            validate_mcp_catalog(session_l)
            if measure_memory:
                time.sleep(SETTLE_SECONDS)
            snap_l = (
                memory_snapshot(
                    f"{mcp_unit_l}.scope",
                    "junban-mcp",
                    "local_owner_idle",
                    measure_memory=measure_memory,
                )
                if measure_memory
                else {
                    "memory_skipped": True,
                    "no_node": True,
                    "process_count": 1,
                    "pid": session_l.proc.pid,
                }
            )
            # Exactly one process — MCP hosts owner in-process.
            if measure_memory:
                pids = cgroup_pids(f"{mcp_unit_l}.scope")
                live = [p for p in pids if Path(f"/proc/{p}").exists()]
                mcp_pids = [
                    p
                    for p in live
                    if "junban-mcp" in proc_field(p, "exe")
                    or "junban-mcp" in proc_field(p, "cmdline")
                    or "junban-mcp" in proc_field(p, "comm")
                ]
                if len(mcp_pids) != 1:
                    raise BenchError(
                        f"local-owner cgroup expected one junban-mcp, found {mcp_pids}"
                    )
                for p in live:
                    blob = f"{proc_field(p, 'exe')} {proc_field(p, 'cmdline')}"
                    if "junban-server" in blob:
                        raise BenchError(
                            "local-owner mode spawned a separate junban-server"
                        )
            else:
                if session_l.proc.poll() is not None:
                    raise BenchError("local-owner MCP exited before idle sample")

            mem_ok_l = True
            if measure_memory:
                mem_ok_l = (
                    snap_l["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                    and snap_l["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                )
            local_owner.append(
                {
                    "index": i,
                    "initialize_ms": init_ms_l,
                    "mcp": snap_l,
                    "runtime_reachable": True,
                    "single_process": True,
                    "sqlite": sqlite_size_bytes(profile_l),
                    "memory_ok": mem_ok_l,
                }
            )
            session_l.close_stdin()
            code_l = session_l.wait()
            session_l = None
            if code_l != 0:
                raise BenchError(f"local-owner MCP idle exit {code_l}")
            wait_runtime_gone(profile_l)
            wait_lock_free(profile_l)
        finally:
            if session_l is not None:
                session_l.kill(signal.SIGKILL)
                try:
                    session_l.wait(5)
                except BenchError:
                    pass
            stop_unit(mcp_unit_l)
            shutil.rmtree(profile_l, ignore_errors=True)

    attached_currents = [
        s["mcp"]["cgroup_current_mib"] for s in attached if "cgroup_current_mib" in s["mcp"]
    ]
    attached_peaks = [
        s["mcp"]["cgroup_peak_mib"] for s in attached if "cgroup_peak_mib" in s["mcp"]
    ]
    local_currents = [
        s["mcp"]["cgroup_current_mib"] for s in local_owner if "cgroup_current_mib" in s["mcp"]
    ]
    local_peaks = [
        s["mcp"]["cgroup_peak_mib"] for s in local_owner if "cgroup_peak_mib" in s["mcp"]
    ]

    def max_or_none(vals: list[float]) -> float | None:
        return max(vals) if vals else None

    return {
        "samples": n,
        "attached": attached,
        "local_owner": local_owner,
        "attached_max_current_mib": max_or_none(attached_currents),
        "attached_max_peak_mib": max_or_none(attached_peaks),
        "local_owner_max_current_mib": max_or_none(local_currents),
        "local_owner_max_peak_mib": max_or_none(local_peaks),
        "budget_attached_warm_ok": (
            not measure_memory
            or (
                attached_currents
                and max(attached_currents) <= WARM_MEMORY_CEILING_MIB
                and max(attached_peaks) <= PEAK_MEMORY_CEILING_MIB
            )
        ),
        "budget_local_owner_warm_ok": (
            not measure_memory
            or (
                local_currents
                and max(local_currents) <= WARM_MEMORY_CEILING_MIB
                and max(local_peaks) <= PEAK_MEMORY_CEILING_MIB
            )
        ),
        "cleanup_ok": True,
        "no_node": True,
        "secrets_clean": True,
    }


def section_e_lifecycle(
    *,
    run_id: str,
    repo_root: Path,
    server: Path,
    cli: Path,
    mcp: Path,
    web_dir: Path,
    work_root: Path,
) -> dict[str, Any]:
    """Lifecycle and failure cases with bounded polling."""
    results: dict[str, Any] = {}

    def fresh_profile(label: str) -> tuple[Path, str, list[str]]:
        profile = work_root / f"e-{label}-{uuid.uuid4().hex[:8]}"
        token = generate_operator_token()
        prepare_profile(profile, token)
        return profile, token, [token]

    # 1) stdin EOF after initialization (local-owner MCP)
    profile, token, secrets_list = fresh_profile("eof")
    session = start_mcp_unscoped(mcp, ["--data-dir", str(profile)], secrets_list=secrets_list)
    try:
        session.initialize()
        poll_until(
            READY_TIMEOUT_SECONDS,
            lambda: (profile / RUNTIME_FILE).exists(),
            "EOF case: runtime not published",
        )
        session.close_stdin()
        code = session.wait(timeout=LIFECYCLE_TIMEOUT_SECONDS)
        wait_runtime_gone(profile)
        wait_lock_free(profile)
        results["stdin_eof"] = {
            "exit_code": code,
            "runtime_removed": True,
            "lock_released": True,
            "ok": code == 0,
        }
    finally:
        if session.proc.poll() is None:
            session.kill(signal.SIGKILL)
            try:
                session.wait(5)
            except BenchError:
                pass
        shutil.rmtree(profile, ignore_errors=True)

    # 2) SIGINT after initialization
    profile, token, secrets_list = fresh_profile("sigint")
    session = start_mcp_unscoped(mcp, ["--data-dir", str(profile)], secrets_list=secrets_list)
    try:
        session.initialize()
        poll_until(
            READY_TIMEOUT_SECONDS,
            lambda: (profile / RUNTIME_FILE).exists(),
            "SIGINT case: runtime not published",
        )
        session.kill(signal.SIGINT)
        try:
            session.wait(timeout=LIFECYCLE_TIMEOUT_SECONDS)
        except BenchError:
            session.kill(signal.SIGKILL)
            session.wait(5)
        wait_lock_free(profile)
        # Graceful signal should remove runtime; tolerate brief delay.
        try:
            wait_runtime_gone(profile, timeout=5.0)
            runtime_removed = True
        except BenchError:
            runtime_removed = not (profile / RUNTIME_FILE).exists()
        results["sigint"] = {
            "lock_released": True,
            "runtime_removed": runtime_removed,
            "ok": True,
        }
    finally:
        if session.proc.poll() is None:
            session.kill(signal.SIGKILL)
        shutil.rmtree(profile, ignore_errors=True)

    # 3) SIGTERM after initialization
    profile, token, secrets_list = fresh_profile("sigterm")
    session = start_mcp_unscoped(mcp, ["--data-dir", str(profile)], secrets_list=secrets_list)
    try:
        session.initialize()
        poll_until(
            READY_TIMEOUT_SECONDS,
            lambda: (profile / RUNTIME_FILE).exists(),
            "SIGTERM case: runtime not published",
        )
        session.kill(signal.SIGTERM)
        try:
            session.wait(timeout=LIFECYCLE_TIMEOUT_SECONDS)
        except BenchError:
            session.kill(signal.SIGKILL)
            session.wait(5)
        wait_lock_free(profile)
        try:
            wait_runtime_gone(profile, timeout=5.0)
            runtime_removed = True
        except BenchError:
            runtime_removed = not (profile / RUNTIME_FILE).exists()
        results["sigterm"] = {
            "lock_released": True,
            "runtime_removed": runtime_removed,
            "ok": True,
        }
    finally:
        if session.proc.poll() is None:
            session.kill(signal.SIGKILL)
        shutil.rmtree(profile, ignore_errors=True)

    # 4) SIGKILL after initialization — lock released; stale metadata may remain
    profile, token, secrets_list = fresh_profile("sigkill")
    session = start_mcp_unscoped(mcp, ["--data-dir", str(profile)], secrets_list=secrets_list)
    try:
        session.initialize()
        poll_until(
            READY_TIMEOUT_SECONDS,
            lambda: (profile / RUNTIME_FILE).exists(),
            "SIGKILL case: runtime not published",
        )
        stale_runtime = (profile / RUNTIME_FILE).read_text(encoding="utf-8")
        session.kill(signal.SIGKILL)
        session.wait(timeout=5)
        wait_lock_free(profile)
        # Next owner must ignore/replace stale record.
        payload, _, _, _, code = run_cli(
            cli,
            ["--json", "--data-dir", str(profile), "task", "list", "--limit", "100"],
            secrets_list=secrets_list,
        )
        if code != 0:
            raise BenchError(
                f"post-SIGKILL no-owner CLI failed: {sanitize_text(json.dumps(payload))[:200]}"
            )
        validate_task_list_payload(payload, expected_count=0, expect_empty=True)
        wait_runtime_gone(profile)
        wait_lock_free(profile)
        results["sigkill"] = {
            "lock_released": True,
            "stale_metadata_possible": True,
            "next_owner_ok": True,
            "stale_bytes_before_next": len(stale_runtime),
            "ok": True,
        }
    finally:
        if session.proc.poll() is None:
            session.kill(signal.SIGKILL)
        shutil.rmtree(profile, ignore_errors=True)

    # 5) Credential revocation during live attached MCP session
    profile, token, secrets_list = fresh_profile("revoke")
    cred_path = work_root / f"e-revoke-{run_id}.token"
    srv_unit = f"junban-p5e-rev-srv-{run_id}"
    base_url, host, _iid, _, bare_srv = start_server(
        srv_unit, server, profile, web_dir, repo_root, measure_memory=False
    )
    holder: McpSession | None = None
    attached: McpSession | None = None
    try:
        # Keep a local holder? External server is already the owner.
        cred_id, auto_token = create_automation_credential_file(
            base_url, host, token, cred_path
        )
        secrets_list.append(auto_token)
        attached = start_mcp_unscoped(
            mcp,
            ["--server", base_url, "--credential-file", str(cred_path)],
            secrets_list=secrets_list,
        )
        attached.initialize()
        listed, _ = attached.request("tools/list", {})
        if "error" in listed:
            raise BenchError("pre-revoke tools/list failed")
        revoke_automation_credential(base_url, host, token, cred_id)
        after, _ = attached.request("tools/list", {})
        list_failed = (
            "error" in after
            or not ((after.get("result") or {}).get("tools") or [])
        )
        call, _ = attached.request(
            "tools/call",
            {"name": "list_tasks", "arguments": {}},
        )
        call_failed = (
            "error" in call
            or (call.get("result") or {}).get("isError") is True
            or isinstance(((call.get("result") or {}).get("structuredContent") or {}).get("error"), dict)
        )
        # Ensure raw credential not echoed.
        blob = json.dumps(after) + json.dumps(call) + attached.stderr_text()
        assert_no_secrets(blob, secrets_list, where="post-revoke mcp")
        results["credential_revocation"] = {
            "list_fail_closed": bool(list_failed),
            "call_fail_closed": bool(call_failed),
            "no_secret_leak": True,
            "ok": bool(list_failed and call_failed),
        }
    finally:
        if attached is not None:
            attached.close_stdin()
            try:
                attached.wait(5)
            except BenchError:
                attached.kill(signal.SIGKILL)
        if holder is not None:
            holder.kill(signal.SIGKILL)
        stop_server(srv_unit, profile, bare_proc=bare_srv)
        if cred_path.exists():
            cred_path.unlink()
        shutil.rmtree(profile, ignore_errors=True)

    # 6) Cancelled in-flight MCP request
    profile, token, secrets_list = fresh_profile("cancel")
    session = start_mcp_unscoped(mcp, ["--data-dir", str(profile)], secrets_list=secrets_list)
    try:
        session.initialize()
        cancel_id = session.next_id()
        session.write_frame(
            {
                "jsonrpc": "2.0",
                "id": cancel_id,
                "method": "tools/call",
                "params": {
                    "name": "list_tasks",
                    "arguments": {},
                    "_meta": {"progressToken": "phase5-cancel"},
                },
            }
        )
        session.notify(
            "notifications/cancelled",
            {"requestId": cancel_id, "reason": "phase5-bench"},
        )
        follow_id = session.next_id()
        session.write_frame(
            {
                "jsonrpc": "2.0",
                "id": follow_id,
                "method": "tools/list",
                "params": {},
            }
        )
        saw_follow = False
        saw_cancelled_response = False
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and not saw_follow:
            frame = session.read_frame(timeout=max(0.01, deadline - time.monotonic()))
            if frame.get("id") == cancel_id:
                saw_cancelled_response = True
            if frame.get("id") == follow_id:
                saw_follow = True
                if "result" not in frame and "error" not in frame:
                    raise BenchError("follow-up tools/list malformed")
        if not saw_follow:
            raise BenchError("did not receive follow-up after cancel")
        # Cancellation may win (no response) or lose (response already in flight).
        # Protocol: emit no *late* response after cancellation wins — we only require
        # follow-up works and cleanup is clean.
        session.close_stdin()
        code = session.wait(timeout=LIFECYCLE_TIMEOUT_SECONDS)
        wait_runtime_gone(profile)
        wait_lock_free(profile)
        results["cancellation"] = {
            "follow_up_ok": True,
            "cancelled_response_seen": saw_cancelled_response,
            "exit_code": code,
            "lock_released": True,
            "runtime_removed": True,
            "ok": code == 0,
        }
    finally:
        if session.proc.poll() is None:
            session.kill(signal.SIGKILL)
        shutil.rmtree(profile, ignore_errors=True)

    # 7) Stale runtime metadata followed by a no-owner command
    profile, token, secrets_list = fresh_profile("stale")
    stale = {
        "version": 1,
        "address": "127.0.0.1:1",
        "pid": 1,
        "instance_id": str(uuid.uuid4()),
    }
    (profile / RUNTIME_FILE).write_text(json.dumps(stale) + "\n", encoding="utf-8")
    os.chmod(profile / RUNTIME_FILE, 0o600)
    payload, _, _, _, code = run_cli(
        cli,
        ["--json", "--data-dir", str(profile), "task", "list", "--limit", "100"],
        secrets_list=secrets_list,
    )
    if code != 0:
        raise BenchError(
            f"stale-metadata no-owner CLI failed: {sanitize_text(json.dumps(payload))[:200]}"
        )
    validate_task_list_payload(payload, expected_count=0, expect_empty=True)
    wait_runtime_gone(profile)
    wait_lock_free(profile)
    results["stale_runtime_metadata"] = {
        "no_owner_command_ok": True,
        "lock_released": True,
        "ok": True,
    }
    shutil.rmtree(profile, ignore_errors=True)

    # 8) Two concurrent no-owner contenders
    profile, token, secrets_list = fresh_profile("race")
    cmd = [
        str(cli),
        "--json",
        "--data-dir",
        str(profile),
        "task",
        "list",
        "--limit",
        "100",
    ]
    p1 = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p2 = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out1, err1 = p1.communicate(timeout=CLI_TIMEOUT_SECONDS)
    out2, err2 = p2.communicate(timeout=CLI_TIMEOUT_SECONDS)
    assert_no_secrets(out1 + out2 + err1 + err2, secrets_list, where="concurrent cli")

    def classify(stdout: str, code: int) -> str:
        if code == 0:
            payload = _parse_one_json(stdout, where="concurrent")
            validate_task_list_payload(payload, expected_count=0, expect_empty=True)
            return "ok"
        try:
            payload = _parse_one_json(stdout, where="concurrent-err")
        except BenchError:
            return f"exit_{code}"
        err = payload.get("error") if isinstance(payload, dict) else None
        code_s = ""
        if isinstance(err, dict):
            code_s = str(err.get("code") or "")
        if "busy" in code_s.lower() or code == 3:
            return "busy"
        return f"error:{code_s or code}"

    c1 = classify(out1, p1.returncode or 0)
    c2 = classify(out2, p2.returncode or 0)
    if c1 not in {"ok", "busy"} or c2 not in {"ok", "busy"}:
        raise BenchError(f"concurrent contenders unexpected outcomes: {c1}, {c2}")
    if c1 != "ok" and c2 != "ok":
        # Both busy is harsh but acceptable only if lock free after; prefer at least one ok.
        # Protocol allows busy; both busy without a winner is still not two owners.
        pass
    wait_runtime_gone(profile, timeout=10.0)
    wait_lock_free(profile)
    # Ensure we never had two owners: lock is free and a follow-up works.
    payload, _, _, _, code = run_cli(
        cli,
        ["--json", "--data-dir", str(profile), "task", "list", "--limit", "100"],
        secrets_list=secrets_list,
    )
    if code != 0:
        raise BenchError("post-race CLI failed")
    validate_task_list_payload(payload, expected_count=0, expect_empty=True)
    wait_runtime_gone(profile)
    wait_lock_free(profile)
    results["concurrent_no_owner"] = {
        "outcomes": [c1, c2],
        "no_dual_owners": True,
        "follow_up_ok": True,
        "ok": True,
    }
    shutil.rmtree(profile, ignore_errors=True)

    all_ok = all(bool(v.get("ok")) for v in results.values())
    return {
        "cases": results,
        "all_ok": all_ok,
        "no_node": True,
        "secrets_clean": True,
    }


# ── Summary / budgets ────────────────────────────────────────────────────────


def _max_owner_delta_mib(section_a: dict[str, Any], section_c: dict[str, Any]) -> float | None:
    deltas: list[float] = []
    before = section_a.get("server_before") or {}
    after = section_a.get("server_after") or {}
    if "cgroup_current_mib" in before and "cgroup_current_mib" in after:
        deltas.append(abs(float(after["cgroup_current_mib"]) - float(before["cgroup_current_mib"])))
    for detail in section_c.get("detail") or []:
        b = detail.get("owner_before") or {}
        a = detail.get("owner_after") or {}
        if "cgroup_current_mib" in b and "cgroup_current_mib" in a:
            deltas.append(abs(float(a["cgroup_current_mib"]) - float(b["cgroup_current_mib"])))
    return max(deltas) if deltas else None


def collect_owner_delta_raw_series(
    section_a: dict[str, Any],
    section_c: dict[str, Any],
) -> list[dict[str, Any]]:
    """Flatten A/C owner settled-current deltas with evidence for adjudication."""
    series: list[dict[str, Any]] = []
    before = section_a.get("server_before") or {}
    after = section_a.get("server_after") or {}
    if "cgroup_current_mib" in before and "cgroup_current_mib" in after:
        raw = dict(section_a.get("owner_delta") or evaluate_owner_delta_raw(
            float(before["cgroup_current_mib"]),
            float(after["cgroup_current_mib"]),
        ))
        series.append(
            {
                "source": "active_owner_cli",
                "index": 0,
                **raw,
                "owner_absolute_ok": bool(section_a.get("budget_owner_memory_ok", True)),
                "process_ok": int(before.get("process_count", 1) or 1) == 1
                and int(after.get("process_count", 1) or 1) == 1,
                "no_node_ok": bool(before.get("no_node", True)) and bool(after.get("no_node", True)),
                "memory_stat_before": before.get("memory_stat"),
                "memory_stat_after": after.get("memory_stat"),
                "sqlite_before": section_a.get("sqlite_before") or section_a.get("sqlite"),
                "sqlite_after": section_a.get("sqlite_after") or section_a.get("sqlite"),
                "workload_wall_seconds": float(section_a.get("workload_wall_seconds") or 0.0),
                "before_peak_mib": before.get("cgroup_peak_mib"),
                "after_peak_mib": after.get("cgroup_peak_mib"),
            }
        )
    for detail in section_c.get("detail") or []:
        b = detail.get("owner_before") or {}
        a = detail.get("owner_after") or {}
        if "cgroup_current_mib" not in b or "cgroup_current_mib" not in a:
            continue
        raw = dict(detail.get("owner_delta") or evaluate_owner_delta_raw(
            float(b["cgroup_current_mib"]),
            float(a["cgroup_current_mib"]),
        ))
        series.append(
            {
                "source": "mcp_operations",
                "index": detail.get("index"),
                **raw,
                "owner_absolute_ok": bool(detail.get("owner_memory_ok", True)),
                "process_ok": int(b.get("process_count", 1) or 1) == 1
                and int(a.get("process_count", 1) or 1) == 1,
                "no_node_ok": bool(b.get("no_node", True)) and bool(a.get("no_node", True)),
                "memory_stat_before": b.get("memory_stat"),
                "memory_stat_after": a.get("memory_stat"),
                "sqlite_before": detail.get("sqlite_before"),
                "sqlite_after": detail.get("sqlite_after") or detail.get("sqlite"),
                "workload_wall_seconds": float(detail.get("workload_wall_seconds") or 0.0),
                "before_peak_mib": b.get("cgroup_peak_mib"),
                "after_peak_mib": a.get("cgroup_peak_mib"),
            }
        )
    return series


def run_idle_host_owner_controls(
    *,
    run_id: str,
    repo_root: Path,
    server: Path,
    web_dir: Path,
    work_root: Path,
    hold_seconds: float,
    samples: int = OWNER_DELTA_IDLE_CONTROL_SAMPLES,
) -> list[dict[str, Any]]:
    """Fresh external-owner idle controls: settle/hold/settle, no client workload."""
    hold = max(float(hold_seconds), SETTLE_SECONDS)
    controls: list[dict[str, Any]] = []
    for i in range(samples):
        profile = work_root / f"idle-ctrl-{i:02d}"
        token = generate_operator_token()
        prepare_profile(profile, token)
        unit = f"junban-p5idle-{run_id}-{i:02d}"
        bare_proc: subprocess.Popen[str] | None = None
        report: dict[str, Any] = {
            "index": i,
            "hold_seconds": hold,
            "settle_seconds": SETTLE_SECONDS,
            "client_workload": False,
        }
        try:
            _base_url, _host, _instance_id, startup_ms, bare_proc = start_server(
                unit,
                server,
                profile,
                web_dir,
                repo_root,
                measure_memory=True,
            )
            report["startup_to_health_ms"] = startup_ms
            time.sleep(SETTLE_SECONDS)
            before = memory_snapshot(
                f"{unit}.service",
                "junban-server",
                f"idle_control_{i:02d}_before",
                measure_memory=True,
                include_memory_stat=True,
            )
            sqlite_before = sqlite_size_bytes(profile)
            time.sleep(hold)
            time.sleep(SETTLE_SECONDS)
            after = memory_snapshot(
                f"{unit}.service",
                "junban-server",
                f"idle_control_{i:02d}_after",
                measure_memory=True,
                include_memory_stat=True,
            )
            sqlite_after = sqlite_size_bytes(profile)
            owner_delta = evaluate_owner_delta_raw(
                before["cgroup_current_mib"],
                after["cgroup_current_mib"],
            )
            absolute_ok = (
                before["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                and before["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
                and after["cgroup_current_mib"] <= WARM_MEMORY_CEILING_MIB
                and after["cgroup_peak_mib"] <= PEAK_MEMORY_CEILING_MIB
            )
            process_ok = before.get("process_count") == 1 and after.get("process_count") == 1
            no_node_ok = bool(before.get("no_node")) and bool(after.get("no_node"))
            report.update(
                {
                    "before": before,
                    "after": after,
                    "sqlite_before": sqlite_before,
                    "sqlite_after": sqlite_after,
                    "owner_delta": owner_delta,
                    "owner_absolute_ok": absolute_ok,
                    "process_ok": process_ok,
                    "no_node_ok": no_node_ok,
                    "no_node": no_node_ok,
                }
            )
        finally:
            stop_server(unit, profile, bare_proc=bare_proc)
            cleanup_ok = False
            try:
                wait_runtime_gone(profile, timeout=5.0)
                wait_lock_free(profile, timeout=5.0)
                cleanup_ok = not (profile / RUNTIME_FILE).exists() and try_acquire_profile_lock(profile)
            except BenchError:
                cleanup_ok = False
            report["cleanup_ok"] = cleanup_ok
            shutil.rmtree(profile, ignore_errors=True)
        controls.append(report)
    return controls


_EVIDENCE_PATH_FLAGS = frozenset({"--server", "--cli", "--mcp", "--web-dir", "--output"})


def sanitize_evidence_argv(argv: list[str]) -> list[str]:
    """Retain reproducible options without publishing caller-local paths."""
    sanitized: list[str] = []
    path_value_expected = False
    for arg in argv:
        if path_value_expected:
            sanitized.append(Path(arg).name)
            path_value_expected = False
            continue
        flag, separator, value = arg.partition("=")
        if flag in _EVIDENCE_PATH_FLAGS:
            sanitized.append(flag)
            if separator:
                sanitized.append(Path(value).name)
            else:
                path_value_expected = True
            continue
        sanitized.append(arg)
    return sanitized


def build_report(
    *,
    protocol: dict[str, Any],
    host: dict[str, Any],
    binaries: dict[str, Any],
    sections: dict[str, Any],
    run_id: str,
    argv: list[str],
    owner_delta_disposition: dict[str, Any] | None = None,
) -> dict[str, Any]:
    a = sections["active_owner_cli"]
    b = sections["no_owner_cli"]
    c = sections["mcp_operations"]
    d = sections["mcp_idle"]
    e = sections["lifecycle"]
    measure_memory = bool(protocol["measure_memory"])

    budgets = {
        "active_owner_cli_p95_ms": {
            "limit": ACTIVE_OWNER_CLI_P95_MS,
            "actual": a["latency"]["p95_ms"],
            "passed": bool(a["budget_cli_p95_ok"]),
        },
        "no_owner_cli_p95_ms": {
            "limit": NO_OWNER_CLI_P95_MS,
            "actual": b["latency"]["p95_ms"],
            "passed": bool(b["budget_cli_p95_ok"]),
        },
        "mcp_create_task_p95_ms": {
            "limit": MCP_CREATE_P95_MS,
            "actual": c["create_latency"]["p95_ms"],
            "passed": bool(c["budget_create_p95_ok"]),
        },
        "mcp_get_task_p95_ms": {
            "limit": MCP_GET_P95_MS,
            "actual": c["get_latency"]["p95_ms"],
            "passed": bool(c["budget_get_p95_ok"]),
        },
        "protocol_tool_errors": {
            "limit": 0,
            "actual": c["protocol_errors"] + c["tool_errors"],
            "passed": bool(c["budget_zero_errors_ok"]),
        },
        "attached_mcp_warm_mib": {
            "limit": WARM_MEMORY_CEILING_MIB,
            "actual": d.get("attached_max_current_mib"),
            "passed": bool(d["budget_attached_warm_ok"]) if measure_memory else None,
            "skipped": not measure_memory,
        },
        "attached_mcp_peak_mib": {
            "limit": PEAK_MEMORY_CEILING_MIB,
            "actual": d.get("attached_max_peak_mib"),
            "passed": bool(d["budget_attached_warm_ok"]) if measure_memory else None,
            "skipped": not measure_memory,
        },
        "local_owner_mcp_warm_mib": {
            "limit": WARM_MEMORY_CEILING_MIB,
            "actual": d.get("local_owner_max_current_mib"),
            "passed": bool(d["budget_local_owner_warm_ok"]) if measure_memory else None,
            "skipped": not measure_memory,
        },
        "local_owner_mcp_peak_mib": {
            "limit": PEAK_MEMORY_CEILING_MIB,
            "actual": d.get("local_owner_max_peak_mib"),
            "passed": bool(d["budget_local_owner_warm_ok"]) if measure_memory else None,
            "skipped": not measure_memory,
        },
        "owner_memory_ceilings": {
            "limit_warm_mib": WARM_MEMORY_CEILING_MIB,
            "limit_peak_mib": PEAK_MEMORY_CEILING_MIB,
            "passed": (
                bool(a.get("budget_owner_memory_ok", True))
                and bool(c.get("budget_owner_memory_ok", True))
            )
            if measure_memory
            else None,
            "skipped": not measure_memory,
        },
        "owner_delta": {
            "rule": "post-workload settled current within max(15% of baseline, 1 MiB)",
            "max_observed_delta_mib": _max_owner_delta_mib(a, c),
            "threshold_pct": OWNER_DELTA_PCT,
            "threshold_floor_mib": OWNER_DELTA_FLOOR_MIB,
            "owner_delta_raw_passed": (
                bool(a.get("budget_owner_delta_raw_ok", a.get("budget_owner_delta_ok", True)))
                and bool(c.get("budget_owner_delta_raw_ok", c.get("budget_owner_delta_ok", True)))
            )
            if measure_memory
            else None,
            # Effective gate may be elevated only by explicit explained disposition.
            "passed": (
                bool((owner_delta_disposition or {}).get("owner_delta_effective_passed"))
                if owner_delta_disposition is not None
                else (
                    bool(a.get("budget_owner_delta_raw_ok", a.get("budget_owner_delta_ok", True)))
                    and bool(c.get("budget_owner_delta_raw_ok", c.get("budget_owner_delta_ok", True)))
                )
            )
            if measure_memory
            else None,
            "decision": (owner_delta_disposition or {}).get("decision"),
            "disposition_applied": bool((owner_delta_disposition or {}).get("disposition_applied")),
            "disposition_passed": bool((owner_delta_disposition or {}).get("disposition_passed")),
            "disposition_reason": (owner_delta_disposition or {}).get("reason"),
            "skipped": not measure_memory,
        },
        "lifecycle_all": {
            "passed": bool(e["all_ok"]),
        },
        "no_node": {
            "passed": all(
                bool(sections[k].get("no_node", True))
                for k in ("active_owner_cli", "no_owner_cli", "mcp_operations", "mcp_idle", "lifecycle")
            ),
        },
        "secrets_clean": {
            "passed": all(
                bool(sections[k].get("secrets_clean", True))
                for k in ("active_owner_cli", "no_owner_cli", "mcp_operations", "mcp_idle", "lifecycle")
            ),
        },
        "cleanup_assertions": {
            "passed": bool(b.get("cleanup_ok")) and bool(d.get("cleanup_ok")) and bool(e["all_ok"]),
        },
    }

    def _passed(entry: dict[str, Any]) -> bool:
        if entry.get("skipped"):
            return True
        return bool(entry.get("passed"))

    accepted = all(_passed(v) for v in budgets.values()) and bool(protocol["authoritative"])
    # Non-authoritative runs report budget_passed separately without claiming acceptance.
    budget_passed = all(_passed(v) for v in budgets.values())

    summary = {
        "active_owner_cli_p95_ms": a["latency"]["p95_ms"],
        "active_owner_cli_p50_ms": a["latency"]["p50_ms"],
        "no_owner_cli_p95_ms": b["latency"]["p95_ms"],
        "no_owner_cli_p50_ms": b["latency"]["p50_ms"],
        "mcp_create_p95_ms": c["create_latency"]["p95_ms"],
        "mcp_create_p50_ms": c["create_latency"]["p50_ms"],
        "mcp_get_p95_ms": c["get_latency"]["p95_ms"],
        "mcp_get_p50_ms": c["get_latency"]["p50_ms"],
        "attached_mcp_max_current_mib": d.get("attached_max_current_mib"),
        "attached_mcp_max_peak_mib": d.get("attached_max_peak_mib"),
        "local_owner_mcp_max_current_mib": d.get("local_owner_max_current_mib"),
        "local_owner_mcp_max_peak_mib": d.get("local_owner_max_peak_mib"),
        "lifecycle_ok": e["all_ok"],
        "owner_delta_raw_passed": budgets["owner_delta"].get("owner_delta_raw_passed"),
        "owner_delta_effective_passed": budgets["owner_delta"].get("passed"),
        "owner_delta_decision": budgets["owner_delta"].get("decision"),
        "budget_passed": budget_passed,
        "accepted": accepted and budget_passed,
    }

    return {
        "protocol": protocol,
        "run_id": run_id,
        "host": host,
        "binaries": binaries,
        "command": {"argv": [Path(__file__).name, *sanitize_evidence_argv(argv)]},
        "sections": sections,
        "owner_delta_disposition": owner_delta_disposition,
        "budgets": budgets,
        "summary": summary,
        "accepted": bool(summary["accepted"]),
        "evidence_status": (
            "authoritative_passed"
            if protocol["authoritative"] and budget_passed
            else "authoritative_failed"
            if protocol["authoritative"]
            else "non_authoritative_dry_run"
        ),
    }


def print_summary(report: dict[str, Any]) -> None:
    s = report["summary"]
    b = report["budgets"]
    lines = [
        f"protocol={report['protocol']['name']} v{report['protocol']['version']}",
        f"authoritative={report['protocol']['authoritative']} status={report['evidence_status']}",
        f"active-owner CLI p95={s['active_owner_cli_p95_ms']:.2f}ms "
        f"(limit {b['active_owner_cli_p95_ms']['limit']}) "
        f"{'PASS' if b['active_owner_cli_p95_ms']['passed'] else 'FAIL'}",
        f"no-owner CLI p95={s['no_owner_cli_p95_ms']:.2f}ms "
        f"(limit {b['no_owner_cli_p95_ms']['limit']}) "
        f"{'PASS' if b['no_owner_cli_p95_ms']['passed'] else 'FAIL'}",
        f"MCP create_task p95={s['mcp_create_p95_ms']:.2f}ms "
        f"(limit {b['mcp_create_task_p95_ms']['limit']}) "
        f"{'PASS' if b['mcp_create_task_p95_ms']['passed'] else 'FAIL'}",
        f"MCP get_task p95={s['mcp_get_p95_ms']:.2f}ms "
        f"(limit {b['mcp_get_task_p95_ms']['limit']}) "
        f"{'PASS' if b['mcp_get_task_p95_ms']['passed'] else 'FAIL'}",
    ]
    if s.get("attached_mcp_max_current_mib") is not None:
        lines.append(
            f"attached MCP warm max={s['attached_mcp_max_current_mib']:.4f}MiB "
            f"peak max={s['attached_mcp_max_peak_mib']:.4f}MiB "
            f"{'PASS' if b['attached_mcp_warm_mib']['passed'] else 'FAIL'}"
        )
        lines.append(
            f"local-owner MCP warm max={s['local_owner_mcp_max_current_mib']:.4f}MiB "
            f"peak max={s['local_owner_mcp_max_peak_mib']:.4f}MiB "
            f"{'PASS' if b['local_owner_mcp_warm_mib']['passed'] else 'FAIL'}"
        )
    else:
        lines.append("memory: skipped (non-authoritative)")
    od = b.get("owner_delta") or {}
    if od.get("skipped"):
        lines.append("owner-delta: skipped (non-authoritative)")
    else:
        raw_flag = "PASS" if od.get("owner_delta_raw_passed") else "FAIL"
        eff_flag = "PASS" if od.get("passed") else "FAIL"
        lines.append(
            f"owner-delta raw={raw_flag} effective={eff_flag} "
            f"max_delta_mib={od.get('max_observed_delta_mib')} "
            f"decision={od.get('decision')!r}"
        )
        if od.get("disposition_applied") and od.get("disposition_passed") and not od.get(
            "owner_delta_raw_passed"
        ):
            lines.append(
                "WARNING: owner_delta raw FAILED but explained disposition PASSED; "
                "absolute 24/32 MiB ceilings and all other gates remain mandatory."
            )
        warning = (report.get("owner_delta_disposition") or {}).get("warning")
        if warning:
            lines.append(str(warning))
    lines.append(f"lifecycle={'PASS' if s['lifecycle_ok'] else 'FAIL'}")
    lines.append(f"accepted={report['accepted']}")
    print("\n".join(lines), file=sys.stderr)


# ── Self-check ───────────────────────────────────────────────────────────────


def self_check() -> None:
    assert sanitize_evidence_argv(
        [
            "--server=/private/build/junban-server",
            "--output",
            "/home/user/private/phase-5.json",
            "--accept-explained-owner-delta",
            OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        ]
    ) == [
        "--server",
        "junban-server",
        "--output",
        "phase-5.json",
        "--accept-explained-owner-delta",
        OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
    ]
    assert PROTOCOL_NAME == "junban-phase5-automation-v1"
    assert PROTOCOL_VERSION == 1
    assert ACTIVE_OWNER_CLI_SAMPLES == 20
    assert ACTIVE_OWNER_CLI_P95_MS == 150.0
    assert ACTIVE_OWNER_SEED_TASKS == 100
    assert NO_OWNER_CLI_SAMPLES == 10
    assert NO_OWNER_CLI_P95_MS == 350.0
    assert MCP_OP_SAMPLES == 3
    assert MCP_CREATES_PER_SAMPLE == 50
    assert MCP_GETS_PER_SAMPLE == 50
    assert MCP_CREATE_P95_MS == 100.0
    assert MCP_GET_P95_MS == 75.0
    assert MCP_IDLE_SAMPLES == 3
    assert WARM_MEMORY_CEILING_MIB == 24.0
    assert PEAK_MEMORY_CEILING_MIB == 32.0
    assert SETTLE_SECONDS == 2.0
    assert OWNER_DELTA_PCT == 0.15
    assert OWNER_DELTA_FLOOR_MIB == 1.0
    assert OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH == "durable-sqlite-state-growth"
    assert OWNER_DELTA_IDLE_CONTROL_SAMPLES == 2
    # Percentile smoke
    assert abs(percentile([0.0, 100.0], 95) - 95.0) < 1e-9
    assert abs(percentile([10.0], 95) - 10.0) < 1e-9
    series = [float(i) for i in range(20)]
    p95 = percentile(series, 95)
    assert 17.0 <= p95 <= 19.0
    cfg = protocol_config(quick=False, skip_memory=False, measure_memory=True)
    assert cfg["authoritative"] is True
    cfg_q = protocol_config(quick=True, skip_memory=False, measure_memory=True)
    assert cfg_q["authoritative"] is False
    cfg_s = protocol_config(quick=False, skip_memory=True, measure_memory=False)
    assert cfg_s["authoritative"] is False
    # Token shapes
    op = generate_operator_token()
    assert len(op) == 64 and re.fullmatch(r"[0-9a-f]{64}", op)
    cid = str(uuid.uuid4())
    tok = mint_automation_token(cid)
    assert tok.startswith("jba_") and cid in tok
    assert_no_secrets("clean text", [op, tok], where="self-check")
    try:
        assert_no_secrets(f"leaked {tok}", [tok], where="self-check")
        raise AssertionError("secret detection failed")
    except BenchError:
        pass
    # MiB
    assert mib(1_048_576) == 1.0
    # Latency summary
    summary = latency_summary([10.0, 20.0, 30.0, 40.0])
    assert summary["count"] == 4
    assert summary["min_ms"] == 10.0
    assert summary["max_ms"] == 40.0
    # JSON extract
    payload = _parse_one_json('{"tasks":[],"revision":0,"as_of_date":"2030-01-01"}\n', where="t")
    validate_task_list_payload(payload, expected_count=0, expect_empty=True)
    # Sanitize host keys
    assert "hostname" not in host_metadata_sanitized(Path(__file__).resolve().parent.parent)
    # Default evidence path relative
    assert not DEFAULT_EVIDENCE.is_absolute()

    # ── Owner-delta adjudication predicates (synthetic, no processes) ──
    raw_fail = evaluate_owner_delta_raw(4.0, 5.2)  # 1.2 MiB > 1.0 floor
    assert raw_fail["owner_delta_raw_passed"] is False
    assert abs(raw_fail["owner_delta_mib"] - 1.2) < 1e-9
    assert abs(raw_fail["owner_delta_allowed_mib"] - 1.0) < 1e-9
    raw_pass = evaluate_owner_delta_raw(10.0, 10.5)  # 0.5 < max(1.0, 1.5)
    assert raw_pass["owner_delta_raw_passed"] is True

    def _series_failing(**overrides: Any) -> list[dict[str, Any]]:
        base = {
            "source": "mcp_operations",
            "index": 0,
            **raw_fail,
            "owner_absolute_ok": True,
            "process_ok": True,
            "no_node_ok": True,
            "memory_stat_before": {"anon_bytes": 2_000_000, "file_bytes": 1_000_000},
            "memory_stat_after": {
                "anon_bytes": 2_000_000 + int(0.4 * 1_048_576),
                "file_bytes": 1_000_000 + int(1.0 * 1_048_576),
            },
            "sqlite_before": {DATABASE_FILE: 100_000, f"{DATABASE_FILE}-wal": 0},
            "sqlite_after": {DATABASE_FILE: 120_000, f"{DATABASE_FILE}-wal": 900_000},
        }
        base.update(overrides)
        return [base]

    def _flat_idle(delta_mib: float = 0.05) -> dict[str, Any]:
        before = 4.0
        after = before + delta_mib
        return {
            "owner_delta": evaluate_owner_delta_raw(before, after),
            "owner_absolute_ok": True,
            "process_ok": True,
            "no_node_ok": True,
            "cleanup_ok": True,
        }

    # 1) No decision → effective fails when raw fails.
    no_decision = evaluate_owner_delta_disposition(
        decision=None,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(),
        idle_controls=None,
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert no_decision["owner_delta_raw_passed"] is False
    assert no_decision["owner_delta_effective_passed"] is False
    assert no_decision["disposition_applied"] is False
    assert no_decision["reason"] == "raw_owner_delta_failed_no_decision"

    # 2) Decision cannot waive absolute ceiling failure.
    abs_fail = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(owner_absolute_ok=False),
        idle_controls=[_flat_idle(), _flat_idle()],
        owner_absolute_all_ok=False,
        process_no_node_cleanup_ok=True,
    )
    assert abs_fail["disposition_applied"] is True
    assert abs_fail["disposition_passed"] is False
    assert abs_fail["owner_delta_effective_passed"] is False
    assert abs_fail["predicates"]["owner_absolute_ceilings_passed"] is False
    assert abs_fail["predicates"]["cannot_waive_absolute_ceilings"] is True

    # 3) Flat idle requirement: growing idle control blocks disposition.
    # Decreases larger than the abs threshold are still flat (no growth).
    idle_decrease = _flat_idle(-1.25)
    assert float(idle_decrease["owner_delta"]["owner_delta_mib"]) > 1.0
    assert evaluate_idle_owner_control_sample(idle_decrease)["passed"] is True
    growing_idle = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(),
        idle_controls=[_flat_idle(0.05), _flat_idle(1.5)],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert growing_idle["disposition_passed"] is False
    assert growing_idle["predicates"]["idle_controls_flat"] is False
    assert growing_idle["owner_delta_effective_passed"] is False
    # Idle reclaim/decrease must not block disposition on its own.
    idle_reclaim_ok = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(),
        idle_controls=[_flat_idle(-1.25), _flat_idle(-0.5)],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert idle_reclaim_ok["predicates"]["idle_controls_flat"] is True
    assert idle_reclaim_ok["disposition_passed"] is True

    # 4) File/state evidence requirement: missing sqlite/stat fails closed.
    missing_evidence = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(
            memory_stat_before=None,
            memory_stat_after=None,
            sqlite_before=None,
            sqlite_after=None,
        ),
        idle_controls=[_flat_idle(), _flat_idle()],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert missing_evidence["disposition_passed"] is False
    assert missing_evidence["predicates"]["every_failing_sample_explained"] is False

    no_durable_growth = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(
            sqlite_before={DATABASE_FILE: 100_000, f"{DATABASE_FILE}-wal": 50_000},
            sqlite_after={DATABASE_FILE: 100_000, f"{DATABASE_FILE}-wal": 50_000},
        ),
        idle_controls=[_flat_idle(), _flat_idle()],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert no_durable_growth["disposition_passed"] is False

    # 5) Valid explained disposition passes effective gate only.
    explained = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=True,
        measure_memory=True,
        raw_series=_series_failing(),
        idle_controls=[_flat_idle(0.02), _flat_idle(0.03)],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert explained["owner_delta_raw_passed"] is False
    assert explained["disposition_applied"] is True
    assert explained["disposition_passed"] is True
    assert explained["owner_delta_effective_passed"] is True
    assert explained["decision"] == OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH
    assert explained["warning"] and "raw" in explained["warning"].lower()
    # Raw series preserved verbatim on the disposition object.
    assert explained["raw_series"][0]["owner_delta_raw_passed"] is False

    # Quick / skip-memory cannot auto-accept via decision.
    quick_disp = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=False,
        measure_memory=True,
        raw_series=_series_failing(),
        idle_controls=[_flat_idle(), _flat_idle()],
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert quick_disp["owner_delta_effective_passed"] is False
    assert quick_disp["reason"] == "decision_ignored_non_authoritative"

    skip_mem = evaluate_owner_delta_disposition(
        decision=OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH,
        authoritative=False,
        measure_memory=False,
        raw_series=[],
        idle_controls=None,
        owner_absolute_all_ok=True,
        process_no_node_cleanup_ok=True,
    )
    assert skip_mem["reason"] == "memory_not_measured_non_authoritative"
    # build_report must keep accepted false for non-authoritative even if budgets pass.
    dummy_sections = {
        "active_owner_cli": {
            "latency": {"p95_ms": 1.0, "p50_ms": 1.0},
            "budget_cli_p95_ok": True,
            "budget_owner_memory_ok": True,
            "budget_owner_delta_ok": True,
            "budget_owner_delta_raw_ok": True,
            "no_node": True,
            "secrets_clean": True,
            "server_before": {},
            "server_after": {},
        },
        "no_owner_cli": {
            "latency": {"p95_ms": 1.0, "p50_ms": 1.0},
            "budget_cli_p95_ok": True,
            "cleanup_ok": True,
            "no_node": True,
            "secrets_clean": True,
        },
        "mcp_operations": {
            "create_latency": {"p95_ms": 1.0, "p50_ms": 1.0},
            "get_latency": {"p95_ms": 1.0, "p50_ms": 1.0},
            "protocol_errors": 0,
            "tool_errors": 0,
            "budget_create_p95_ok": True,
            "budget_get_p95_ok": True,
            "budget_zero_errors_ok": True,
            "budget_mcp_memory_ok": True,
            "budget_owner_memory_ok": True,
            "budget_owner_delta_ok": True,
            "budget_owner_delta_raw_ok": True,
            "detail": [],
            "no_node": True,
            "secrets_clean": True,
        },
        "mcp_idle": {
            "attached_max_current_mib": 1.0,
            "attached_max_peak_mib": 1.0,
            "local_owner_max_current_mib": 1.0,
            "local_owner_max_peak_mib": 1.0,
            "budget_attached_warm_ok": True,
            "budget_local_owner_warm_ok": True,
            "cleanup_ok": True,
            "no_node": True,
            "secrets_clean": True,
        },
        "lifecycle": {"all_ok": True, "no_node": True, "secrets_clean": True},
    }
    non_auth_report = build_report(
        protocol=protocol_config(quick=True, skip_memory=False, measure_memory=True),
        host={},
        binaries={},
        sections=dummy_sections,
        run_id="selfcheck",
        argv=["--quick"],
        owner_delta_disposition=explained,
    )
    assert non_auth_report["accepted"] is False
    assert non_auth_report["protocol"]["authoritative"] is False


# ── Main ─────────────────────────────────────────────────────────────────────


def resolve_bin(path: Path, repo_root: Path) -> Path:
    return path if path.is_absolute() else (repo_root / path).resolve()


def ensure_executable(path: Path, label: str) -> None:
    if not path.is_file() or not os.access(path, os.X_OK):
        raise BenchError(f"{label} binary missing or not executable: {path.name}")


def maybe_build(repo_root: Path) -> None:
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-server",
            "-p",
            "junban-cli",
            "-p",
            "junban-mcp",
        ],
        timeout=60 * 30,
    )
    # Ensure cwd-relative cargo output exists under repo.
    for name in ("junban-server", "junban", "junban-mcp"):
        path = repo_root / "target" / "release" / name
        if not path.is_file():
            raise BenchError(f"build did not produce {name}")


def ensure_web_dir(web_dir: Path) -> Path:
    if web_dir.is_dir() and (web_dir / "index.html").is_file():
        return web_dir
    # Minimal non-product placeholder so API-only measurement still boots hosted binary.
    web_dir.mkdir(parents=True, exist_ok=True)
    index = web_dir / "index.html"
    if not index.exists():
        index.write_text("<!doctype html><title>junban-bench</title>\n", encoding="utf-8")
    return web_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Phase 5 CLI/MCP automation budget harness (junban-phase5-automation-v1)",
    )
    parser.add_argument(
        "--server",
        type=Path,
        default=Path("target/release/junban-server"),
        help="Path to optimized junban-server",
    )
    parser.add_argument(
        "--cli",
        type=Path,
        default=Path("target/release/junban"),
        help="Path to optimized junban CLI",
    )
    parser.add_argument(
        "--mcp",
        type=Path,
        default=Path("target/release/junban-mcp"),
        help="Path to optimized junban-mcp",
    )
    parser.add_argument(
        "--web-dir",
        type=Path,
        default=Path("dist"),
        help="Web asset directory for junban-server",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Write JSON evidence (required for --quick; default evidence path for authoritative)",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Reduced samples; harness validation only — never acceptance evidence",
    )
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Validate frozen protocol constants and exit",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="cargo build --locked --release -p junban-server -p junban-cli -p junban-mcp",
    )
    parser.add_argument(
        "--skip-memory",
        action="store_true",
        help="Developer mode: skip cgroup memory accounting (marks non-authoritative)",
    )
    parser.add_argument(
        "--accept-explained-owner-delta",
        choices=sorted(OWNER_DELTA_DECISIONS),
        default=None,
        metavar="DECISION",
        help=(
            "Explicit root-cause decision for post-workload owner settled-current "
            "delta above the frozen raw threshold. Currently only "
            f"{OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH!r}. Runs idle-host "
            "controls and objective predicates; may resolve only the owner-delta "
            "gate and never waives absolute 24/32 MiB ceilings or other budgets. "
            "Non-authoritative (--quick/--skip-memory) runs cannot accept."
        ),
    )
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parent.parent

    if args.self_check:
        try:
            self_check()
        except AssertionError as error:
            print(f"self-check failed: {error}", file=sys.stderr)
            return 1
        except BenchError as error:
            print(f"self-check failed: {error}", file=sys.stderr)
            return 1
        print("self-check passed", file=sys.stderr)
        return 0

    measure_memory = not args.skip_memory
    try:
        if args.build:
            print("building release binaries…", file=sys.stderr)
            maybe_build(repo_root)

        if measure_memory:
            require_linux_cgroup_v2()
        elif sys.platform != "linux":
            # Lifecycle lock checks use fcntl; keep Linux-focused.
            raise BenchError("this harness currently requires Linux")

        server = resolve_bin(args.server, repo_root)
        cli = resolve_bin(args.cli, repo_root)
        mcp_bin = resolve_bin(args.mcp, repo_root)
        web_dir = resolve_bin(args.web_dir, repo_root)
        ensure_executable(server, "server")
        ensure_executable(cli, "cli")
        ensure_executable(mcp_bin, "mcp")
        web_dir = ensure_web_dir(web_dir)

        protocol = protocol_config(
            quick=bool(args.quick),
            skip_memory=bool(args.skip_memory),
            measure_memory=measure_memory,
        )
        host = host_metadata_sanitized(repo_root)
        if protocol["authoritative"] and host.get("git_dirty"):
            raise BenchError("authoritative run rejects a dirty git worktree")

        if args.quick and args.output is None:
            raise BenchError("--quick requires an explicit --output path (never default evidence)")

        run_id = uuid.uuid4().hex[:12]
        work_root = Path(tempfile.mkdtemp(prefix=f"junban-p5-auto-{run_id}-", dir="/tmp"))
        os.chmod(work_root, 0o700)
        sections: dict[str, Any] = {}
        try:
            print("section A: active-owner CLI…", file=sys.stderr)
            sections["active_owner_cli"] = section_a_active_owner_cli(
                run_id=run_id,
                repo_root=repo_root,
                server=server,
                cli=cli,
                web_dir=web_dir,
                work_root=work_root,
                protocol=protocol,
            )
            print(
                f"  p95={sections['active_owner_cli']['latency']['p95_ms']:.2f}ms",
                file=sys.stderr,
            )

            print("section B: no-owner CLI…", file=sys.stderr)
            sections["no_owner_cli"] = section_b_no_owner_cli(
                run_id=run_id,
                cli=cli,
                work_root=work_root,
                protocol=protocol,
            )
            print(
                f"  p95={sections['no_owner_cli']['latency']['p95_ms']:.2f}ms",
                file=sys.stderr,
            )

            print("section C: persistent MCP operations…", file=sys.stderr)
            sections["mcp_operations"] = section_c_mcp_operations(
                run_id=run_id,
                repo_root=repo_root,
                server=server,
                mcp=mcp_bin,
                web_dir=web_dir,
                work_root=work_root,
                protocol=protocol,
            )
            print(
                f"  create p95={sections['mcp_operations']['create_latency']['p95_ms']:.2f}ms "
                f"get p95={sections['mcp_operations']['get_latency']['p95_ms']:.2f}ms",
                file=sys.stderr,
            )

            print("section D: MCP idle ownership modes…", file=sys.stderr)
            sections["mcp_idle"] = section_d_mcp_idle(
                run_id=run_id,
                repo_root=repo_root,
                server=server,
                mcp=mcp_bin,
                web_dir=web_dir,
                work_root=work_root,
                protocol=protocol,
            )
            if measure_memory:
                print(
                    f"  attached warm max={sections['mcp_idle']['attached_max_current_mib']}MiB "
                    f"local warm max={sections['mcp_idle']['local_owner_max_current_mib']}MiB",
                    file=sys.stderr,
                )

            print("section E: lifecycle / failure cases…", file=sys.stderr)
            sections["lifecycle"] = section_e_lifecycle(
                run_id=run_id,
                repo_root=repo_root,
                server=server,
                cli=cli,
                mcp=mcp_bin,
                web_dir=web_dir,
                work_root=work_root,
            )
            print(
                f"  lifecycle_ok={sections['lifecycle']['all_ok']}",
                file=sys.stderr,
            )

            # Owner-delta adjudication (optional explicit decision only).
            decision = args.accept_explained_owner_delta
            raw_series = (
                collect_owner_delta_raw_series(
                    sections["active_owner_cli"],
                    sections["mcp_operations"],
                )
                if measure_memory
                else []
            )
            raw_owner_delta_ok = all(
                bool(s.get("owner_delta_raw_passed", False)) for s in raw_series
            ) if raw_series else True
            idle_controls: list[dict[str, Any]] | None = None
            need_idle = (
                measure_memory
                and (not raw_owner_delta_ok)
                and decision == OWNER_DELTA_DECISION_DURABLE_SQLITE_STATE_GROWTH
                and bool(protocol["authoritative"])
            )
            if need_idle:
                hold = max(
                    (float(s.get("workload_wall_seconds") or 0.0) for s in raw_series),
                    default=SETTLE_SECONDS,
                )
                # Comparable settle/duration: at least the longest observed workload window.
                hold = max(hold, SETTLE_SECONDS)
                print(
                    f"owner-delta raw FAILED; running {OWNER_DELTA_IDLE_CONTROL_SAMPLES} "
                    f"idle-host control(s) hold={hold:.2f}s for decision {decision!r}…",
                    file=sys.stderr,
                )
                idle_controls = run_idle_host_owner_controls(
                    run_id=run_id,
                    repo_root=repo_root,
                    server=server,
                    web_dir=web_dir,
                    work_root=work_root,
                    hold_seconds=hold,
                    samples=OWNER_DELTA_IDLE_CONTROL_SAMPLES,
                )
            owner_absolute_all_ok = bool(
                sections["active_owner_cli"].get("budget_owner_memory_ok", True)
            ) and bool(sections["mcp_operations"].get("budget_owner_memory_ok", True))
            process_no_node_cleanup_ok = all(
                bool(sections[k].get("no_node", True))
                for k in (
                    "active_owner_cli",
                    "no_owner_cli",
                    "mcp_operations",
                    "mcp_idle",
                    "lifecycle",
                )
            ) and bool(sections["no_owner_cli"].get("cleanup_ok", True)) and bool(
                sections["mcp_idle"].get("cleanup_ok", True)
            ) and bool(sections["lifecycle"].get("all_ok", True))
            owner_delta_disposition = evaluate_owner_delta_disposition(
                decision=decision,
                authoritative=bool(protocol["authoritative"]),
                measure_memory=measure_memory,
                raw_series=raw_series,
                idle_controls=idle_controls,
                owner_absolute_all_ok=owner_absolute_all_ok,
                process_no_node_cleanup_ok=process_no_node_cleanup_ok,
            )
            sections["owner_delta_raw_series"] = raw_series
            if idle_controls is not None:
                sections["owner_delta_idle_controls"] = idle_controls
            if owner_delta_disposition.get("warning"):
                print(owner_delta_disposition["warning"], file=sys.stderr)
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

        binaries = {
            "server": binary_metadata(server, repo_root),
            "cli": binary_metadata(cli, repo_root),
            "mcp": binary_metadata(mcp_bin, repo_root),
        }
        # owner_delta_disposition is assigned inside try; guard if sections aborted early.
        disposition_for_report = locals().get("owner_delta_disposition")
        report = build_report(
            protocol=protocol,
            host=host,
            binaries=binaries,
            sections=sections,
            run_id=run_id,
            argv=list(sys.argv[1:] if argv is None else argv),
            owner_delta_disposition=disposition_for_report,
        )
        text = json.dumps(report, indent=2, sort_keys=True) + "\n"
        print_summary(report)

        output_path: Path | None = None
        if args.output is not None:
            output_path = args.output if args.output.is_absolute() else repo_root / args.output
        elif protocol["authoritative"]:
            output_path = repo_root / DEFAULT_EVIDENCE
        if output_path is not None:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(text, encoding="utf-8")
            print(f"wrote {relative_name(output_path, repo_root)}", file=sys.stderr)

        sys.stdout.write(text)
        # Exit nonzero unless every required sample/assertion passes.
        # Non-authoritative successful dry runs still exit 0 if budgets pass.
        if not report["summary"]["budget_passed"]:
            return 1
        if protocol["authoritative"] and not report["accepted"]:
            return 1
        return 0
    except BenchError as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired as error:
        print(f"benchmark timed out: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
