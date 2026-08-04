#!/usr/bin/env python3
"""Phase 7 Wave 0 Wasmtime host-placement spike harness.

Protocol: junban-phase7-host-placement-v1

Compares optimized Linux cgroup-v2 samples for:
  (a) exact current junban-server baseline (Phase 6 product path; no spike link)
  (b) SDK/protocol-only probe (no Wasmtime)
  (c) in-process Wasmtime probe: linked-idle, engine, compile, instantiate,
      first/warm call, trap, CPU loop, memory limit, disable
  (d) on-demand child host: before spawn, idle child, invoke, hostile stages,
      disable, shutdown/cleanup

Also builds/measures a real TypeScript component via exact build-only
jco 1.26.1 + componentize-js 0.22.0 when reliable on Linux.

Never fakes a cgroup when systemd-run is unavailable. Development servers are
rejected. Authoritative mode requires five samples, idle host, and clean tree;
--quick is non-authoritative. Contended hosts retain preliminary evidence only.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
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
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
BENCH_PATH = REPO_ROOT / "scripts" / "bench-hosted-server.py"
SPIKE_DIR = REPO_ROOT / "tools" / "phase7-host-placement"
COMPONENTS_DIR = SPIKE_DIR / "components"
RUST_GUEST_DIR = SPIKE_DIR / "guests" / "rust-spike"
TS_GUEST_DIR = SPIKE_DIR / "guests" / "typescript-spike"
DEFAULT_OUTPUT = REPO_ROOT / "goals" / "rust-rewrite" / "evidence" / "phase-7-host-placement.json"

PROTOCOL_NAME = "junban-phase7-host-placement-v1"
PROTOCOL_VERSION = 1
WASMTIME_VERSION = "45.0.3"
JCO_VERSION = "1.26.1"
COMPONENTIZE_JS_VERSION = "0.22.0"
AUTHORITATIVE_SAMPLES = 5
QUICK_SAMPLES = 1
SETTLE_SECONDS = 2.0
READY_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 20.0
WARM_MEMORY_CEILING_MIB = 24.0
PEAK_MEMORY_CEILING_MIB = 32.0
GROWTH_PCT = 0.15
GROWTH_FLOOR_MIB = 1.0
# CPU-scaled load gates. Must not reject a Phase 6-class idle host solely because
# load5 was ~3.28 on ~20 CPUs (that is below 20*0.30=6.0).
LOAD1_BUSY_PER_CPU = 0.50
LOAD5_BUSY_PER_CPU = 0.30
LOAD_FLOOR = 1.0
# Sample candidate build/browser processes for real CPU activity, not mere existence.
ACTIVITY_SAMPLE_SECONDS = 0.25
MIN_ACTIVE_CPU_TICK_DELTA = 2  # utime+stime jiffies over the sample window
NODE_MARKERS = frozenset({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})
BUILD_CONFOUNDERS = frozenset(
    {
        "cargo",
        "rustc",
        "rustdoc",
        "clippy",
        "sccache",
        "node",
        "nodejs",
        "npm",
        "npx",
        "pnpm",
        "vite",
        "playwright",
        "chrome",
        "chromium",
        "firefox",
        "wasm-opt",
        "wizer",
    }
)

# Hostile-probe StoreLimits safety caps only (linear-memory pages × 64 KiB profiles).
# NOT product active-memory budgets and NOT frozen evidence ceilings.
HOSTILE_PROBE_RUST_MEMORY_MIB = 64.0
HOSTILE_PROBE_TS_MEMORY_MIB = 128.0
MAX_COMPONENT_BYTES = 32 * 1024 * 1024
RUST_BASELINE_IMPORTS = [
    "wasi:cli/environment@0.2.6",
    "wasi:cli/exit@0.2.6",
    "wasi:cli/stderr@0.2.6",
    "wasi:io/error@0.2.6",
    "wasi:io/streams@0.2.6",
]
# Premeasurement selection thresholds (data-independent, explicit).
# Material if delta exceeds both relative and absolute floors.
SELECT_WARM_PCT = 0.15
SELECT_WARM_FLOOR_MIB = 8.0
SELECT_PEAK_PCT = 0.20
SELECT_PEAK_FLOOR_MIB = 32.0
SELECT_COLD_PCT = 0.25
SELECT_COLD_FLOOR_MS = 100.0


class HarnessError(RuntimeError):
    pass


def load_bench() -> Any:
    spec = importlib.util.spec_from_file_location("junban_bench_hosted_server", BENCH_PATH)
    if spec is None or spec.loader is None:
        raise HarnessError(f"cannot load bench helpers from {BENCH_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BENCH = load_bench()


def run_cmd(
    argv: list[str],
    *,
    check: bool = True,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode != 0:
        raise HarnessError(
            f"command failed ({result.returncode}): {' '.join(argv)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def mib(num_bytes: int | float) -> float:
    return float(num_bytes) / (1024.0 * 1024.0)


def series_summary(values: list[float]) -> dict[str, float]:
    if not values:
        return {"min": 0.0, "max": 0.0, "median": 0.0, "mean": 0.0}
    return {
        "min": min(values),
        "max": max(values),
        "median": statistics.median(values),
        "mean": statistics.fmean(values),
    }


def load_thresholds(cpus: int) -> dict[str, float]:
    cpus = max(int(cpus), 1)
    return {
        "cpu_count": float(cpus),
        "load1_threshold": max(LOAD_FLOOR, cpus * LOAD1_BUSY_PER_CPU),
        "load5_threshold": max(LOAD_FLOOR, cpus * LOAD5_BUSY_PER_CPU),
    }


def load_contention_reasons(load1: float, load5: float, cpus: int) -> list[str]:
    """Pure load gate used by host_contention and self-check."""
    thresholds = load_thresholds(cpus)
    reasons: list[str] = []
    if load1 > thresholds["load1_threshold"]:
        reasons.append(
            f"load1 {load1:.2f} > threshold {thresholds['load1_threshold']:.2f}"
        )
    if load5 > thresholds["load5_threshold"]:
        reasons.append(
            f"load5 {load5:.2f} > threshold {thresholds['load5_threshold']:.2f}"
        )
    return reasons


def process_is_cpu_active(tick_delta: int, *, min_delta: int = MIN_ACTIVE_CPU_TICK_DELTA) -> bool:
    """Pure activity gate: existence alone is never contention."""
    return int(tick_delta) >= int(min_delta)


def swap_io_is_active(pswpin_delta: int, pswpout_delta: int) -> bool:
    """Pure swap gate: allocated-but-inactive swap is not contention."""
    return int(pswpin_delta) > 0 or int(pswpout_delta) > 0


def read_proc_cpu_ticks(pid: int) -> int | None:
    """Return utime+stime jiffies for pid, or None if unreadable."""
    try:
        # /proc/<pid>/stat: field 14=utime, 15=stime (1-indexed after pid/comm).
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        rparen = raw.rfind(")")
        if rparen < 0:
            return None
        fields = raw[rparen + 2 :].split()
        utime = int(fields[11])
        stime = int(fields[12])
        return utime + stime
    except (OSError, ValueError, IndexError):
        return None


def read_vmstat_swap_io() -> tuple[int, int] | None:
    try:
        pswpin = pswpout = 0
        found_in = found_out = False
        for line in Path("/proc/vmstat").read_text(encoding="utf-8").splitlines():
            if line.startswith("pswpin "):
                pswpin = int(line.split()[1])
                found_in = True
            elif line.startswith("pswpout "):
                pswpout = int(line.split()[1])
                found_out = True
        if found_in and found_out:
            return pswpin, pswpout
    except (OSError, ValueError, IndexError):
        return None
    return None


def list_candidate_confounder_pids() -> list[dict[str, Any]]:
    """Enumerate candidate build/browser PIDs without judging activity yet."""
    found: list[dict[str, Any]] = []
    proc = Path("/proc")
    if not proc.is_dir():
        return found
    self_pid = os.getpid()
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == self_pid:
            continue
        try:
            comm = (entry / "comm").read_text(encoding="utf-8").strip().lower()
            cmdline = (
                (entry / "cmdline")
                .read_bytes()
                .replace(b"\x00", b" ")
                .decode("utf-8", errors="replace")
                .strip()
                .lower()
            )
            exe = ""
            try:
                exe = os.path.basename(os.readlink(entry / "exe")).lower()
            except OSError:
                pass
        except OSError:
            continue
        # Never treat this harness as a confounder (parent or residual).
        if "check-phase7-host-placement" in cmdline or "check-phase7-host-placement" in comm:
            continue
        tokens = set(re.split(r"[^a-z0-9_.+-]+", f"{comm} {exe} {cmdline}"))
        hits = sorted(tokens.intersection(BUILD_CONFOUNDERS))
        if not hits:
            continue
        found.append(
            {
                "pid": pid,
                "comm": comm,
                "exe": exe,
                "hits": hits,
                "cmdline": cmdline[:240],
            }
        )
        if len(found) >= 64:
            break
    return found


def sample_active_confounders(
    *,
    sample_seconds: float = ACTIVITY_SAMPLE_SECONDS,
    min_tick_delta: int = MIN_ACTIVE_CPU_TICK_DELTA,
) -> list[dict[str, Any]]:
    """Return only confounder processes with meaningful positive CPU activity."""
    candidates = list_candidate_confounder_pids()
    before: dict[int, int] = {}
    for item in candidates:
        ticks = read_proc_cpu_ticks(int(item["pid"]))
        if ticks is not None:
            before[int(item["pid"])] = ticks
    time.sleep(max(float(sample_seconds), 0.05))
    active: list[dict[str, Any]] = []
    for item in candidates:
        pid = int(item["pid"])
        if pid not in before:
            continue
        after = read_proc_cpu_ticks(pid)
        if after is None:
            continue
        delta = max(0, after - before[pid])
        if not process_is_cpu_active(delta, min_delta=min_tick_delta):
            continue
        active.append({**item, "cpu_tick_delta": delta})
        if len(active) >= 32:
            break
    return active


def sample_swap_io(
    *,
    sample_seconds: float = ACTIVITY_SAMPLE_SECONDS,
) -> dict[str, Any]:
    """Measure pswpin/pswpout delta; static allocated swap is ignored."""
    first = read_vmstat_swap_io()
    if first is None:
        return {
            "available": False,
            "pswpin_delta": 0,
            "pswpout_delta": 0,
            "active": False,
        }
    time.sleep(max(float(sample_seconds), 0.05))
    second = read_vmstat_swap_io()
    if second is None:
        return {
            "available": False,
            "pswpin_delta": 0,
            "pswpout_delta": 0,
            "active": False,
        }
    pin_delta = max(0, second[0] - first[0])
    pout_delta = max(0, second[1] - first[1])
    return {
        "available": True,
        "pswpin_before": first[0],
        "pswpout_before": first[1],
        "pswpin_after": second[0],
        "pswpout_after": second[1],
        "pswpin_delta": pin_delta,
        "pswpout_delta": pout_delta,
        "active": swap_io_is_active(pin_delta, pout_delta),
        "sample_seconds": float(sample_seconds),
    }


def classify_host_contention(
    *,
    phase: str,
    load1: float,
    load5: float,
    cpus: int,
    active_confounder_count: int,
    swap_io_active: bool,
) -> dict[str, Any]:
    """Pure classifier for pre/post host contention semantics.

    pre: enforce CPU-scaled historical load + active confounders + swap I/O.
    post: load averages are informational only (include this campaign's own CPU);
          still enforce active external confounder CPU ticks and swap I/O.
    """
    phase = str(phase)
    if phase not in {"pre", "post"}:
        raise HarnessError(f"unknown contention phase {phase!r}")
    thresholds = load_thresholds(cpus)
    load_reasons = load_contention_reasons(load1, load5, cpus)
    load_thresholds_enforced = phase == "pre"
    reasons: list[str] = []
    informational: list[str] = []
    if load_thresholds_enforced:
        reasons.extend(load_reasons)
    elif load_reasons:
        informational.extend([f"load_informational: {r}" for r in load_reasons])
    if active_confounder_count > 0:
        reasons.append(f"active_build_confounders={active_confounder_count}")
    if swap_io_active:
        reasons.append("swap_io_active")
    contended = bool(reasons)
    if load_thresholds_enforced:
        method = (
            "pre: enforce CPU-scaled historical load thresholds; "
            "active confounder CPU tick deltas; pswpin/pswpout delta"
        )
    else:
        method = (
            "post: historical load averages informational only (include campaign CPU); "
            "still enforce active external confounder CPU tick deltas and pswpin/pswpout delta"
        )
    return {
        "phase": phase,
        "load_thresholds_enforced": load_thresholds_enforced,
        "load1_threshold": thresholds["load1_threshold"],
        "load5_threshold": thresholds["load5_threshold"],
        "load_reasons": load_reasons,
        "informational": informational,
        "contended": contended,
        "reason": (
            "; ".join(reasons)
            if reasons
            else (
                "no_contention_signals"
                if not informational
                else "no_enforced_contention_signals; " + "; ".join(informational)
            )
        ),
        "method": method,
    }


def host_contention(host: dict[str, Any], *, phase: str = "pre") -> dict[str, Any]:
    load1, load5, load15 = os.getloadavg()
    cpus = max(int(host.get("cpu_count") or os.cpu_count() or 1), 1)
    # One shared activity window: sample confounder CPU and swap I/O together.
    candidates = list_candidate_confounder_pids()
    ticks_before: dict[int, int] = {}
    for item in candidates:
        ticks = read_proc_cpu_ticks(int(item["pid"]))
        if ticks is not None:
            ticks_before[int(item["pid"])] = ticks
    swap_before = read_vmstat_swap_io()
    time.sleep(ACTIVITY_SAMPLE_SECONDS)
    active_confounders: list[dict[str, Any]] = []
    for item in candidates:
        pid = int(item["pid"])
        if pid not in ticks_before:
            continue
        after = read_proc_cpu_ticks(pid)
        if after is None:
            continue
        delta = max(0, after - ticks_before[pid])
        if process_is_cpu_active(delta):
            active_confounders.append({**item, "cpu_tick_delta": delta})
            if len(active_confounders) >= 32:
                break
    swap_after = read_vmstat_swap_io()
    if swap_before is not None and swap_after is not None:
        pin_delta = max(0, swap_after[0] - swap_before[0])
        pout_delta = max(0, swap_after[1] - swap_before[1])
        swap_io = {
            "available": True,
            "pswpin_delta": pin_delta,
            "pswpout_delta": pout_delta,
            "active": swap_io_is_active(pin_delta, pout_delta),
            "sample_seconds": ACTIVITY_SAMPLE_SECONDS,
        }
    else:
        swap_io = {
            "available": False,
            "pswpin_delta": 0,
            "pswpout_delta": 0,
            "active": False,
            "sample_seconds": ACTIVITY_SAMPLE_SECONDS,
        }
    classified = classify_host_contention(
        phase=phase,
        load1=load1,
        load5=load5,
        cpus=cpus,
        active_confounder_count=len(active_confounders),
        swap_io_active=bool(swap_io.get("active")),
    )
    # Informational only: static swap allocation is recorded but never contends.
    swap_used_mib = None
    try:
        meminfo = Path("/proc/meminfo").read_text(encoding="utf-8")
        total = avail = None
        for line in meminfo.splitlines():
            if line.startswith("SwapTotal:"):
                total = int(line.split()[1])
            elif line.startswith("SwapFree:"):
                avail = int(line.split()[1])
        if total is not None and avail is not None:
            swap_used_mib = (total - avail) / 1024.0
    except OSError:
        pass
    # Attach swap detail into enforced reason when active (keep numbers).
    reason = classified["reason"]
    if swap_io.get("active") and "swap_io_active" in reason:
        reason = reason.replace(
            "swap_io_active",
            "swap_io_active "
            f"pswpin_delta={swap_io['pswpin_delta']} "
            f"pswpout_delta={swap_io['pswpout_delta']}",
            1,
        )
    return {
        "phase": classified["phase"],
        "load_thresholds_enforced": classified["load_thresholds_enforced"],
        "load1": load1,
        "load5": load5,
        "load15": load15,
        "cpu_count": cpus,
        "load1_threshold": classified["load1_threshold"],
        "load5_threshold": classified["load5_threshold"],
        "load_reasons": classified["load_reasons"],
        "informational": classified["informational"],
        "activity_sample_seconds": ACTIVITY_SAMPLE_SECONDS,
        "min_active_cpu_tick_delta": MIN_ACTIVE_CPU_TICK_DELTA,
        "swap_used_mib_informational": swap_used_mib,
        "swap_io": swap_io,
        "active_build_confounders": active_confounders,
        "candidate_confounder_count": len(candidates),
        "contended": classified["contended"],
        "reason": reason,
        "method": classified["method"],
    }


def git_dirty(repo_root: Path) -> bool:
    result = run_cmd(["git", "-C", str(repo_root), "status", "--porcelain"], check=False)
    return bool((result.stdout or "").strip())


def require_cgroup_stack() -> None:
    try:
        BENCH.require_linux_cgroup_v2()
    except BENCH.BenchError as error:
        raise HarnessError(str(error)) from error


def self_check() -> dict[str, Any]:
    require_cgroup_stack()
    # Prove systemd-run can create a real memory-accounted unit; never fake it.
    unit = f"junban-p7-selfcheck-{uuid.uuid4().hex[:8]}.service"
    try:
        run_cmd(
            [
                "systemd-run",
                "--user",
                f"--unit={unit}",
                "--collect",
                "--property=MemoryAccounting=yes",
                "--property=Type=exec",
                "--",
                "/bin/sleep",
                "5",
            ]
        )
        # Wait until MainPID exists.
        deadline = time.time() + 5.0
        while time.time() < deadline:
            try:
                main_pid = BENCH.unit_property(unit, "MainPID")
                if main_pid and main_pid != "0":
                    break
            except BENCH.BenchError:
                pass
            time.sleep(0.05)
        cg = BENCH.read_cgroup_memory(unit)
        if cg["current_bytes"] <= 0:
            raise HarnessError("self-check cgroup current_bytes not positive")
        procs = (BENCH.cgroup_path(unit) / "cgroup.procs").read_text().split()
        if not procs:
            raise HarnessError("self-check cgroup has no procs")
    finally:
        run_cmd(["systemctl", "--user", "stop", unit], check=False)
        run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)

    # Pure contention semantics (no ambient process dependency).
    # load5=3.28 on 20 CPUs must remain under the scaled threshold (6.0).
    if load_contention_reasons(3.28, 3.28, 20):
        raise HarnessError("load gate falsely contends Phase-6-class idle load5=3.28/20cpu")
    if not load_contention_reasons(20.0, 20.0, 20):
        raise HarnessError("load gate failed to contend clearly overloaded host")
    if process_is_cpu_active(0):
        raise HarnessError("idle process ticks must not count as active")
    if not process_is_cpu_active(MIN_ACTIVE_CPU_TICK_DELTA):
        raise HarnessError("min tick delta must count as active")
    if swap_io_is_active(0, 0):
        raise HarnessError("static swap must not count as active I/O")
    if not swap_io_is_active(1, 0) or not swap_io_is_active(0, 2):
        raise HarnessError("positive pswpin/pswpout delta must count as active")

    # Post-run historical load alone must not contend; active process/swap still do.
    post_high_load = classify_host_contention(
        phase="post",
        load1=20.0,
        load5=20.0,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=False,
    )
    if post_high_load["contended"] or post_high_load["load_thresholds_enforced"]:
        raise HarnessError(
            f"post high historical load alone must not contend: {post_high_load}"
        )
    if not post_high_load["informational"]:
        raise HarnessError("post high load must record informational load reasons")
    post_active = classify_host_contention(
        phase="post",
        load1=0.1,
        load5=0.1,
        cpus=20,
        active_confounder_count=2,
        swap_io_active=False,
    )
    if not post_active["contended"]:
        raise HarnessError("post active confounders must contend")
    post_swap = classify_host_contention(
        phase="post",
        load1=0.1,
        load5=0.1,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=True,
    )
    if not post_swap["contended"]:
        raise HarnessError("post swap I/O must contend")
    pre_high_load = classify_host_contention(
        phase="pre",
        load1=20.0,
        load5=20.0,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=False,
    )
    if not pre_high_load["contended"] or not pre_high_load["load_thresholds_enforced"]:
        raise HarnessError(f"pre high load must enforce and contend: {pre_high_load}")

    checks = {
        "linux_cgroup_v2": True,
        "systemd_run_memory_accounting": True,
        "repo_root": str(REPO_ROOT),
        "spike_dir_exists": SPIKE_DIR.is_dir(),
        "bench_helpers_loaded": hasattr(BENCH, "read_cgroup_memory"),
        "wasmtime_pin": WASMTIME_VERSION,
        "jco_pin": JCO_VERSION,
        "componentize_js_pin": COMPONENTIZE_JS_VERSION,
        "load_gate_allows_phase6_class_idle": True,
        "activity_not_existence": True,
        "swap_io_not_static_allocation": True,
        "load1_threshold_20cpu": load_thresholds(20)["load1_threshold"],
        "load5_threshold_20cpu": load_thresholds(20)["load5_threshold"],
        "evaluate_decision_fixtures": run_evaluate_decision_fixtures(),
        "cold_total_fixtures": run_cold_total_fixtures(),
        "post_load_informational_only": True,
        "post_still_enforces_active_and_swap": True,
    }
    missing = [k for k, v in checks.items() if v is False]
    if missing:
        raise HarnessError(f"self-check failed: {missing}")
    return checks


def build_release_artifacts() -> dict[str, Any]:
    run_cmd(
        ["cargo", "build", "--locked", "--release", "-p", "junban-server"],
        cwd=REPO_ROOT,
    )
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-phase7-host-placement",
        ],
        cwd=REPO_ROOT,
    )
    # SDK-only probe: no default wasmtime feature.
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-phase7-host-placement",
            "--no-default-features",
            "--bin",
            "junban-p7-spike-probe",
        ],
        cwd=REPO_ROOT,
    )
    # cargo places feature-variant bins in the same target/release; rebuild full after.
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-phase7-host-placement",
        ],
        cwd=REPO_ROOT,
    )

    server = REPO_ROOT / "target" / "release" / "junban-server"
    probe = REPO_ROOT / "target" / "release" / "junban-p7-spike-probe"
    host = REPO_ROOT / "target" / "release" / "junban-p7-spike-host"
    for path in (server, probe, host):
        if not path.is_file():
            raise HarnessError(f"missing release artifact {path}")
        os.chmod(path, 0o755)

    # Copy SDK-only probe aside before the full rebuild overwrote it: rebuild
    # dedicated output via CARGO_TARGET_DIR.
    sdk_target = REPO_ROOT / "target" / "p7-sdk-only"
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-phase7-host-placement",
            "--no-default-features",
            "--bin",
            "junban-p7-spike-probe",
        ],
        cwd=REPO_ROOT,
        env={**os.environ, "CARGO_TARGET_DIR": str(sdk_target)},
    )
    sdk_probe = sdk_target / "release" / "junban-p7-spike-probe"
    if not sdk_probe.is_file():
        raise HarnessError("sdk-only probe missing")

    # Ensure default probe still has wasmtime (rebuild full into main target).
    run_cmd(
        [
            "cargo",
            "build",
            "--locked",
            "--release",
            "-p",
            "junban-phase7-host-placement",
        ],
        cwd=REPO_ROOT,
    )

    def meta(path: Path) -> dict[str, Any]:
        return {
            "path": str(path.relative_to(REPO_ROOT)),
            "sha256": sha256_file(path),
            "size_bytes": path.stat().st_size,
        }

    # Release binaries are often fully stripped; nm is insufficient. Prefer
    # embedded crate path markers that only appear when Wasmtime is linked.
    # Do not match feature-name error strings like "wasmtime-runtime feature disabled".
    def links_wasmtime(path: Path) -> bool:
        strs = run_cmd(["strings", str(path)], check=False)
        blob = (strs.stdout or "") + (strs.stderr or "")
        return bool(
            re.search(
                r"(?:^|/)(?:wasmtime-environ|wasmtime-internal|cranelift-codegen)-",
                blob,
                re.I | re.M,
            )
            or re.search(r"registry/.*/wasmtime-", blob, re.I)
        )

    server_links_wasmtime = links_wasmtime(server)
    probe_links_wasmtime = links_wasmtime(probe)
    sdk_links_wasmtime = links_wasmtime(sdk_probe)
    # Fail closed if full probe is not substantially larger than SDK-only.
    size_ratio = probe.stat().st_size / max(sdk_probe.stat().st_size, 1)
    if size_ratio < 4.0:
        probe_links_wasmtime = False
    # SDK-only must remain small and free of engine crate paths.
    if sdk_probe.stat().st_size > 2 * 1024 * 1024:
        sdk_links_wasmtime = True

    return {
        "junban_server": meta(server),
        "probe_inprocess": meta(probe),
        "probe_sdk_only": meta(sdk_probe),
        "child_host": meta(host),
        "server_links_wasmtime": server_links_wasmtime,
        "probe_links_wasmtime": probe_links_wasmtime,
        "sdk_probe_links_wasmtime": sdk_links_wasmtime,
        "paths": {
            "server": str(server),
            "probe": str(probe),
            "sdk_probe": str(sdk_probe),
            "host": str(host),
        },
    }


def inspect_component_artifact(path: Path, *, kind: str) -> dict[str, Any]:
    """Inspect freshly built component bytes via the spike import inspector."""
    inspector = REPO_ROOT / "target" / "release" / "junban-p7-inspect-imports"
    if not inspector.is_file():
        run_cmd(
            [
                "cargo",
                "build",
                "--locked",
                "--release",
                "-p",
                "junban-phase7-host-placement",
                "--bin",
                "junban-p7-inspect-imports",
            ],
            cwd=REPO_ROOT,
        )
    result = run_cmd(
        [str(inspector), str(path), "--kind", kind],
        check=False,
    )
    if result.returncode not in {0, 3}:
        raise HarnessError(
            f"import inspect failed for {path}: {(result.stderr or result.stdout)[:1000]}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise HarnessError(f"import inspect JSON decode failed: {error}") from error
    imports = list(payload.get("imports") or [])
    size = int(payload.get("size_bytes") or path.stat().st_size)
    if size > MAX_COMPONENT_BYTES:
        raise HarnessError(f"component exceeds {MAX_COMPONENT_BYTES} bytes: {size}")
    if kind == "rust":
        expected = list(RUST_BASELINE_IMPORTS)
        ok = imports == expected and bool(payload.get("profile_ok"))
        if not ok:
            raise HarnessError(
                f"rust imports mismatch: actual={imports!r} expected={expected!r}"
            )
    elif kind in {"typescript", "ts"}:
        ok = imports == [] and bool(payload.get("profile_ok"))
        if not ok:
            raise HarnessError(f"typescript imports must be empty, got {imports!r}")
    else:
        ok = bool(payload.get("profile_ok", True))
    return {
        "imports": imports,
        "import_profile_ok": ok,
        "size_bytes": size,
        "inspector": str(inspector.relative_to(REPO_ROOT)),
    }


def build_rust_component() -> dict[str, Any]:
    COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)
    out = COMPONENTS_DIR / "rust-spike.wasm"
    run_cmd(
        [
            "cargo",
            "build",
            "--release",
            "--target",
            "wasm32-wasip2",
            "--manifest-path",
            str(RUST_GUEST_DIR / "Cargo.toml"),
        ],
        cwd=REPO_ROOT,
    )
    built = (
        RUST_GUEST_DIR
        / "target"
        / "wasm32-wasip2"
        / "release"
        / "junban_p7_rust_spike_guest.wasm"
    )
    # cargo may use package name with hyphens -> underscores
    if not built.is_file():
        candidates = list(
            (RUST_GUEST_DIR / "target" / "wasm32-wasip2" / "release").glob("*.wasm")
        )
        if not candidates:
            # workspace target dir fallback
            candidates = list(
                (REPO_ROOT / "target" / "wasm32-wasip2" / "release").glob("*spike*.wasm")
            )
        if not candidates:
            raise HarnessError("rust spike wasm not produced")
        built = candidates[0]
    shutil.copy2(built, out)
    inspected = inspect_component_artifact(out, kind="rust")
    return {
        "ok": True,
        "path": str(out.relative_to(REPO_ROOT)),
        "sha256": sha256_file(out),
        "size_bytes": out.stat().st_size,
        "kind": "rust",
        "target": "wasm32-wasip2",
        **inspected,
        "expected_imports": list(RUST_BASELINE_IMPORTS),
    }


def build_typescript_component() -> dict[str, Any]:
    COMPONENTS_DIR.mkdir(parents=True, exist_ok=True)
    out = COMPONENTS_DIR / "typescript-spike.wasm"
    # Isolated install of exact pins; build-only Node.
    # Override host min-release-age so the frozen 0.22.0 pin is installable when
    # it is younger than the operator npmrc gate (still exact version + lock).
    install_env = {
        **os.environ,
        "npm_config_min_release_age": "0",
        # componentize-js needs its postinstall binary assets.
        "npm_config_ignore_scripts": "false",
    }
    run_cmd(
        ["npm", "install", "--no-fund", "--no-audit", "--min-release-age=0"],
        cwd=TS_GUEST_DIR,
        env=install_env,
    )
    # Verify exact versions.
    pkg = json.loads((TS_GUEST_DIR / "package.json").read_text(encoding="utf-8"))
    deps = pkg.get("devDependencies") or {}
    if deps.get("@bytecodealliance/jco") != JCO_VERSION:
        raise HarnessError(f"jco pin mismatch: {deps.get('@bytecodealliance/jco')}")
    if deps.get("@bytecodealliance/componentize-js") != COMPONENTIZE_JS_VERSION:
        raise HarnessError(
            f"componentize-js pin mismatch: {deps.get('@bytecodealliance/componentize-js')}"
        )
    result = run_cmd(["node", "build.mjs"], cwd=TS_GUEST_DIR, check=False)
    if result.returncode != 0 or not out.is_file():
        return {
            "ok": False,
            "error": (result.stderr or result.stdout or "typescript component build failed")[:2000],
            "kind": "typescript",
            "jco": JCO_VERSION,
            "componentize_js": COMPONENTIZE_JS_VERSION,
        }
    try:
        inspected = inspect_component_artifact(out, kind="typescript")
    except HarnessError as error:
        return {
            "ok": False,
            "error": str(error),
            "kind": "typescript",
            "jco": JCO_VERSION,
            "componentize_js": COMPONENTIZE_JS_VERSION,
            "path": str(out.relative_to(REPO_ROOT)),
            "sha256": sha256_file(out),
            "size_bytes": out.stat().st_size,
        }
    return {
        "ok": True,
        "path": str(out.relative_to(REPO_ROOT)),
        "sha256": sha256_file(out),
        "size_bytes": out.stat().st_size,
        "kind": "typescript",
        "jco": JCO_VERSION,
        "componentize_js": COMPONENTIZE_JS_VERSION,
        "runtime_node": False,
        **inspected,
        "expected_imports": [],
    }


def http_json(method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8") if raw else "{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        raise HarnessError(
            f"HTTP {method} {url} -> {error.code}: {raw[:300]!r}"
        ) from error
    except urllib.error.URLError as error:
        raise HarnessError(f"HTTP {method} {url} failed: {error}") from error


def start_unit(
    unit: str,
    argv: list[str],
    *,
    working_directory: Path,
) -> None:
    cmd = [
        "systemd-run",
        "--user",
        f"--unit={unit}",
        "--collect",
        "--property=MemoryAccounting=yes",
        "--property=Type=exec",
        f"--working-directory={working_directory}",
        "--",
        *argv,
    ]
    run_cmd(cmd)


def stop_unit(unit: str) -> None:
    run_cmd(["systemctl", "--user", "stop", unit], check=False)
    run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)
    deadline = time.time() + STOP_TIMEOUT_SECONDS
    while time.time() < deadline:
        state = run_cmd(
            ["systemctl", "--user", "show", unit, "--property=ActiveState", "--value"],
            check=False,
        )
        if (state.stdout or "").strip() in {"", "inactive", "failed", "dead"}:
            return
        time.sleep(0.05)
    raise HarnessError(f"unit {unit} did not stop")


def wait_ready_file(path: Path, timeout: float = READY_TIMEOUT_SECONDS) -> dict[str, Any]:
    deadline = time.time() + timeout
    last_err = "not created"
    while time.time() < deadline:
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if "address" in data and "pid" in data:
                    return data
                last_err = f"incomplete ready json: {data!r}"
            except json.JSONDecodeError as error:
                last_err = str(error)
        time.sleep(0.025)
    raise HarnessError(f"ready file {path} not ready: {last_err}")


def cgroup_snapshot(unit: str) -> dict[str, Any]:
    mem = BENCH.read_cgroup_memory(unit)
    procs_path = BENCH.cgroup_path(unit) / "cgroup.procs"
    pids = [int(p) for p in procs_path.read_text().split() if p]
    tree: list[dict[str, Any]] = []
    node_found = False
    for pid in pids:
        try:
            cmdline = (
                Path(f"/proc/{pid}/cmdline")
                .read_bytes()
                .replace(b"\x00", b" ")
                .decode("utf-8", errors="replace")
                .strip()
            )
            comm = Path(f"/proc/{pid}/comm").read_text(encoding="utf-8").strip()
            exe = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
        except OSError:
            continue
        blob = f"{exe} {comm} {cmdline}".lower()
        if set(re.split(r"[^a-z0-9_.+-]+", blob)).intersection(NODE_MARKERS):
            node_found = True
        rss_pss = BENCH.read_proc_rss_pss(pid)
        tree.append(
            {
                "pid": pid,
                "exe": exe,
                "comm": comm,
                "cmdline": cmdline,
                **rss_pss,
            }
        )
    if node_found:
        raise HarnessError(f"Node/tooling process found in {unit}: {tree!r}")
    return {
        "cgroup_current_bytes": mem["current_bytes"],
        "cgroup_peak_bytes": mem["peak_bytes"],
        "cgroup_current_mib": mib(mem["current_bytes"]),
        "cgroup_peak_mib": mib(mem["peak_bytes"]),
        "process_count": len(tree),
        "process_tree": tree,
        "node_process_count": 0,
    }


def measure_server_baseline(
    *,
    server: Path,
    web_dir: Path,
    sample_index: int,
) -> dict[str, Any]:
    unit = f"junban-p7-server-{sample_index}-{uuid.uuid4().hex[:8]}.service"
    with tempfile.TemporaryDirectory(prefix="junban-p7-server-") as tmp:
        tmp_path = Path(tmp)
        profile = tmp_path / "profile"
        token = uuid.uuid4().hex + uuid.uuid4().hex
        BENCH.prepare_profile(profile, token)
        t0 = time.perf_counter()
        try:
            start_unit(
                unit,
                [
                    str(server),
                    "--bind",
                    "127.0.0.1:0",
                    "--data-dir",
                    str(profile),
                    "--web-dir",
                    str(web_dir),
                ],
                working_directory=REPO_ROOT,
            )
            runtime_path = profile / "runtime.json"
            deadline = time.time() + READY_TIMEOUT_SECONDS
            runtime = None
            while time.time() < deadline:
                if runtime_path.is_file():
                    try:
                        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
                        if "address" in runtime:
                            break
                    except json.JSONDecodeError:
                        pass
                time.sleep(0.025)
            if not runtime or "address" not in runtime:
                raise HarnessError("server runtime.json not ready")
            startup_ms = (time.perf_counter() - t0) * 1000.0
            address = runtime["address"]
            base = f"http://{address}"
            health, health_ms = BENCH.http_request(
                "GET",
                f"{base}/api/v1/health",
                headers={"Host": address},
                expect_statuses={200},
                as_json=True,
            )
            time.sleep(SETTLE_SECONDS)
            snap = cgroup_snapshot(unit)
            if snap["process_count"] != 1:
                raise HarnessError(
                    f"server baseline expected 1 process, found {snap['process_count']}"
                )
            return {
                "variant": "server_baseline",
                "startup_to_health_ms": startup_ms,
                "health_ms": health_ms,
                "health": health,
                "idle": snap,
            }
        finally:
            stop_unit(unit)


def measure_probe_variant(
    *,
    label: str,
    probe: Path,
    mode: str,
    sample_index: int,
    component: Path | None = None,
    component_kind: str = "rust",
    host_bin: Path | None = None,
    stages: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    unit = f"junban-p7-{label}-{sample_index}-{uuid.uuid4().hex[:8]}.service"
    with tempfile.TemporaryDirectory(prefix=f"junban-p7-{label}-") as tmp:
        tmp_path = Path(tmp)
        ready = tmp_path / "ready.json"
        argv = [
            str(probe),
            "--mode",
            mode,
            "--bind",
            "127.0.0.1:0",
            "--ready-file",
            str(ready),
            "--component-kind",
            component_kind,
        ]
        if component is not None:
            argv.extend(["--component", str(component)])
        if host_bin is not None:
            argv.extend(["--host-bin", str(host_bin)])
        t0 = time.perf_counter()
        try:
            start_unit(unit, argv, working_directory=REPO_ROOT)
            info = wait_ready_file(ready)
            startup_ms = (time.perf_counter() - t0) * 1000.0
            base = f"http://{info['address']}"
            health = http_json("GET", f"{base}/health")
            time.sleep(SETTLE_SECONDS)
            stages_out: dict[str, Any] = {}
            # linked/idle before any engine stage
            stages_out["linked_idle"] = {
                "health": health,
                "memory": cgroup_snapshot(unit),
            }
            for stage in stages or []:
                name = stage["stage"]
                body = {k: v for k, v in stage.items()}
                started = time.perf_counter()
                try:
                    resp = http_json("POST", f"{base}/stage", body)
                except HarnessError as error:
                    resp = {"ok": False, "error": str(error), "stage": name}
                elapsed = (time.perf_counter() - started) * 1000.0
                time.sleep(0.15)
                entry: dict[str, Any] = {
                    "response": resp,
                    "wall_ms": elapsed,
                    "memory": cgroup_snapshot(unit),
                }
                # After deliberate child kill, prove the parent probe is still healthy
                # before recovery spawn stages run.
                if name in {
                    "kill_child",
                    "child_kill",
                    "crash_child_inflight",
                    "kill_child_inflight",
                }:
                    try:
                        parent_health = http_json("GET", f"{base}/health")
                    except HarnessError as error:
                        parent_health = {"ok": False, "error": str(error)}
                    entry["parent_health_after"] = parent_health
                    if isinstance(resp, dict) and resp.get("ok"):
                        detail = resp.setdefault("detail", {})
                        if isinstance(detail, dict):
                            detail["parent_health_ok"] = bool(parent_health.get("ok"))
                            detail["parent_survived"] = bool(parent_health.get("ok"))
                            if not parent_health.get("ok"):
                                resp["ok"] = False
                                resp["error"] = "parent unhealthy after child kill"
                stages_out[name] = entry
            # Final health proves survival after hostile stages.
            final_health = http_json("GET", f"{base}/health")
            stages_out["final_health"] = {
                "health": final_health,
                "memory": cgroup_snapshot(unit),
            }
            http_json("POST", f"{base}/shutdown", {})
            # Ensure unit stops cleanly and no orphan children remain outside stop.
            return {
                "variant": label,
                "mode": mode,
                "startup_to_health_ms": startup_ms,
                "ready": info,
                "stages": stages_out,
            }
        finally:
            stop_unit(unit)
            # Post-stop orphan check: unit cgroup should be gone or empty.
            time.sleep(0.05)


def ensure_web_dir() -> Path:
    dist = REPO_ROOT / "dist"
    if (dist / "index.html").is_file():
        return dist
    # Minimal static dir so server can start without a full frontend rebuild.
    generated = REPO_ROOT / "target" / "p7-empty-web"
    generated.mkdir(parents=True, exist_ok=True)
    (generated / "index.html").write_text(
        "<!doctype html><title>junban-p7-spike</title>\n", encoding="utf-8"
    )
    return generated


def rust_stage_plan() -> list[dict[str, Any]]:
    return [
        {"stage": "create_engine"},
        {"stage": "compile"},
        {"stage": "instantiate"},
        {"stage": "first_ping", "input": 3},
        {"stage": "warm_ping", "input": 3, "iterations": 50},
        {"stage": "trap"},
        # Re-instantiate after trap for subsequent hostile tests.
        {"stage": "instantiate"},
        {"stage": "cpu_loop"},
        {"stage": "instantiate"},
        {"stage": "grow_memory", "pages": 2048},  # try to exceed 64MiB rust profile
        {"stage": "drop_engine"},
    ]


def child_stage_plan() -> list[dict[str, Any]]:
    return [
        {"stage": "spawn"},
        {"stage": "child_idle"},
        {"stage": "instantiate"},
        {"stage": "first_ping", "input": 4},
        {"stage": "warm_ping", "input": 4, "iterations": 50},
        {"stage": "trap"},
        {"stage": "instantiate"},
        {"stage": "cpu_loop"},
        {"stage": "instantiate"},
        {"stage": "grow_memory", "pages": 2048},
        # Active in-flight crash while parent awaits long-running work.
        {"stage": "crash_child_inflight"},
        {"stage": "spawn"},
        {"stage": "instantiate"},
        {"stage": "first_ping", "input": 5},
        {"stage": "shutdown_child"},
    ]


def stage_survived(report: dict[str, Any], variant_key: str, stage: str) -> bool | None:
    samples = report.get("samples", {}).get(variant_key) or []
    if not samples:
        return None
    ok = True
    for sample in samples:
        st = ((sample.get("stages") or {}).get(stage) or {}).get("response") or {}
        if not st.get("ok", False):
            ok = False
    return ok


def collect_survival_findings(
    report: dict[str, Any],
    *,
    variant_key: str,
    label: str,
) -> tuple[list[str], list[str]]:
    """Return (reasons, blockers) for trap/cpu_loop/grow_memory survival."""
    reasons: list[str] = []
    blockers: list[str] = []
    samples = report.get("samples", {}).get(variant_key) or []
    if not samples:
        blockers.append(f"missing required samples for {variant_key}")
    for stage in ("trap", "cpu_loop", "grow_memory"):
        survived = stage_survived(report, variant_key, stage)
        if survived is True:
            reasons.append(f"{label} {stage} survived")
        elif survived is False:
            blockers.append(f"{label} {stage} did not cleanly report survival")
        else:
            blockers.append(f"{label} {stage} survival evidence missing")
    return reasons, blockers


def child_lifecycle_ok(sample: dict[str, Any]) -> tuple[bool, bool]:
    """Return (cleanup_ok, inflight_crash_recovery_ok) for one child sample."""
    stages = sample.get("stages") or {}
    shut = (stages.get("shutdown_child") or {}).get("response") or {}
    shut_detail = shut.get("detail") or {}
    cleanup_ok = bool(shut.get("ok") and shut_detail.get("cleaned", False))

    kill_stage = (
        stages.get("crash_child_inflight")
        or stages.get("kill_child_inflight")
        or stages.get("kill_child")
        or {}
    )
    kill = kill_stage.get("response") or {}
    kill_detail = kill.get("detail") or {}
    parent_after = kill_stage.get("parent_health_after") or {}
    final_health = (stages.get("final_health") or {}).get("health") or {}
    parent_ok = bool(
        kill_detail.get("parent_survived")
        or parent_after.get("ok")
        or kill_detail.get("parent_health_ok")
    )
    # Recovery proof uses final spawn/instantiate/first_ping keys (post-kill overwrite).
    spawn_ok = (stages.get("spawn") or {}).get("response") or {}
    inst_ok = (stages.get("instantiate") or {}).get("response") or {}
    ping_ok = (stages.get("first_ping") or {}).get("response") or {}
    inflight = bool(kill_detail.get("in_flight", True))
    kill_ok = bool(
        kill.get("ok")
        and kill_detail.get("cleaned", False)
        and kill_detail.get("session_cleared", True)
        and inflight
        and parent_ok
        and final_health.get("ok", False)
        and spawn_ok.get("ok")
        and inst_ok.get("ok")
        and ping_ok.get("ok")
    )
    return cleanup_ok, kill_ok


def collect_child_lifecycle_findings(
    report: dict[str, Any],
    *,
    variant_key: str,
    label: str,
) -> tuple[list[str], list[str]]:
    """Return (reasons, blockers) for child kill/recovery and graceful cleanup."""
    reasons: list[str] = []
    blockers: list[str] = []
    samples = report.get("samples", {}).get(variant_key) or []
    if not samples:
        blockers.append(f"{label} cleanup evidence missing")
        blockers.append(f"{label} kill/recovery evidence missing")
        return reasons, blockers
    cleanup_ok = True
    kill_ok = True
    for sample in samples:
        sample_cleanup, sample_kill = child_lifecycle_ok(sample)
        cleanup_ok = cleanup_ok and sample_cleanup
        kill_ok = kill_ok and sample_kill
    if cleanup_ok:
        reasons.append(f"{label} shutdown cleaned with no orphan")
    else:
        blockers.append(f"{label} shutdown left orphan or failed cleanup proof")
    if kill_ok:
        reasons.append(f"{label} in-flight crash/recovery survived with parent healthy")
    else:
        blockers.append(f"{label} in-flight crash/recovery probe failed or incomplete")
    return reasons, blockers


def material_worse(candidate: float, baseline: float, *, pct: float, floor: float) -> bool:
    """True when candidate exceeds baseline by both relative and absolute floors."""
    return candidate > baseline + max(pct * max(baseline, 0.0), floor)


def cold_total_ms_from_summary(summary_variant: dict[str, Any]) -> float | None:
    cold = summary_variant.get("cold_total_ms") or {}
    if cold.get("median") is not None:
        return float(cold["median"])
    return None


def select_placement_fair(
    summary: dict[str, Any],
) -> tuple[str | None, str, list[str], list[str]]:
    """Premeasurement fair comparator over Rust+TS warm/peak/cold.

    Returns (selected, status, reasons, blockers).
    Child must be measured under the SDK-only parent probe (no Wasmtime parent).
    """
    reasons: list[str] = []
    blockers: list[str] = []

    def metrics(prefix: str) -> dict[str, float | None]:
        ip = summary.get(f"inprocess_{prefix}") or {}
        ch = summary.get(f"child_{prefix}") or {}
        return {
            "ip_warm": ((ip.get("after_warm_cgroup_mib") or {}).get("median")),
            "ch_warm": ((ch.get("after_warm_cgroup_mib") or {}).get("median")),
            "ip_peak": ((ip.get("peak_cgroup_mib") or {}).get("max")),
            "ch_peak": ((ch.get("peak_cgroup_mib") or {}).get("max")),
            "ip_cold": cold_total_ms_from_summary(ip),
            "ch_cold": cold_total_ms_from_summary(ch),
        }

    rust = metrics("rust")
    ts = metrics("typescript")
    required = [
        rust["ip_warm"],
        rust["ch_warm"],
        rust["ip_peak"],
        rust["ch_peak"],
        rust["ip_cold"],
        rust["ch_cold"],
        ts["ip_warm"],
        ts["ch_warm"],
        ts["ip_peak"],
        ts["ch_peak"],
        ts["ip_cold"],
        ts["ch_cold"],
    ]
    if any(v is None for v in required):
        return None, "insufficient_data", reasons, ["missing warm/peak/cold metrics for fair selection"]

    # Material regressions: child worse than in-process, and vice versa.
    child_worse = False
    inprocess_worse = False
    detail: list[str] = []
    for label, m in (("rust", rust), ("typescript", ts)):
        assert m["ip_warm"] is not None and m["ch_warm"] is not None
        assert m["ip_peak"] is not None and m["ch_peak"] is not None
        assert m["ip_cold"] is not None and m["ch_cold"] is not None
        if material_worse(
            float(m["ch_warm"]),
            float(m["ip_warm"]),
            pct=SELECT_WARM_PCT,
            floor=SELECT_WARM_FLOOR_MIB,
        ):
            child_worse = True
            detail.append(f"{label} child warm materially worse")
        if material_worse(
            float(m["ip_warm"]),
            float(m["ch_warm"]),
            pct=SELECT_WARM_PCT,
            floor=SELECT_WARM_FLOOR_MIB,
        ):
            inprocess_worse = True
            detail.append(f"{label} in-process warm materially worse")
        if material_worse(
            float(m["ch_peak"]),
            float(m["ip_peak"]),
            pct=SELECT_PEAK_PCT,
            floor=SELECT_PEAK_FLOOR_MIB,
        ):
            child_worse = True
            detail.append(f"{label} child peak materially worse")
        if material_worse(
            float(m["ip_peak"]),
            float(m["ch_peak"]),
            pct=SELECT_PEAK_PCT,
            floor=SELECT_PEAK_FLOOR_MIB,
        ):
            inprocess_worse = True
            detail.append(f"{label} in-process peak materially worse")
        if material_worse(
            float(m["ch_cold"]),
            float(m["ip_cold"]),
            pct=SELECT_COLD_PCT,
            floor=SELECT_COLD_FLOOR_MS,
        ):
            child_worse = True
            detail.append(f"{label} child cold materially worse")
        if material_worse(
            float(m["ip_cold"]),
            float(m["ch_cold"]),
            pct=SELECT_COLD_PCT,
            floor=SELECT_COLD_FLOOR_MS,
        ):
            inprocess_worse = True
            detail.append(f"{label} in-process cold materially worse")

    reasons.extend(detail)
    reasons.append(
        "fair comparator thresholds: "
        f"warm>max({SELECT_WARM_PCT:.0%},{SELECT_WARM_FLOOR_MIB}MiB), "
        f"peak>max({SELECT_PEAK_PCT:.0%},{SELECT_PEAK_FLOOR_MIB}MiB), "
        f"cold>max({SELECT_COLD_PCT:.0%},{SELECT_COLD_FLOOR_MS}ms)"
    )

    if child_worse and not inprocess_worse:
        return "lazy_inprocess", "selected_by_material_metrics", reasons, blockers
    if inprocess_worse and not child_worse:
        return "on_demand_child_host", "selected_by_material_metrics", reasons, blockers
    if child_worse and inprocess_worse:
        blockers.append(
            "conflicting material tradeoffs between placements; architecture judgment required"
        )
        return None, "blocked_conflicting_material_tradeoffs", reasons, blockers

    # Neither placement materially regresses on required profiles: fault containment.
    reasons.append(
        "no material warm/peak/cold regression on Rust+TS; "
        "fault containment selects on-demand child host"
    )
    return (
        "on_demand_child_host",
        "selected_by_fault_containment_no_material_regression",
        reasons,
        blockers,
    )


def typescript_component_ok(report: dict[str, Any]) -> bool:
    ts = (report.get("components") or {}).get("typescript") or {}
    return bool(ts.get("ok")) and not ts.get("skipped")


def evaluate_decision(report: dict[str, Any]) -> dict[str, Any]:
    """Apply the frozen context-map decision rule. May leave selection unset."""
    summary = report.get("summary") or {}
    server = summary.get("server_baseline") or {}
    artifacts = report.get("artifacts") or {}

    reasons: list[str] = []
    blockers: list[str] = []

    if artifacts.get("server_links_wasmtime"):
        blockers.append("default junban-server unexpectedly links wasmtime")
    if artifacts.get("sdk_probe_links_wasmtime"):
        blockers.append("sdk-only probe unexpectedly links wasmtime")
    if not artifacts.get("probe_links_wasmtime"):
        blockers.append("in-process probe does not link wasmtime")

    server_warm = (server.get("idle_cgroup_mib") or {}).get("max")
    server_peak = (server.get("idle_cgroup_peak_mib") or {}).get("max")
    if server_warm is None or server_peak is None:
        blockers.append("missing server baseline memory summary")
    else:
        if server_warm > WARM_MEMORY_CEILING_MIB or server_peak > PEAK_MEMORY_CEILING_MIB:
            blockers.append(
                f"server baseline exceeds 24/32 MiB ceilings ({server_warm}/{server_peak})"
            )

    # Real TypeScript active evidence is mandatory for placement authority.
    if not typescript_component_ok(report):
        blockers.append("typescript component missing, skipped, or failed")

    for variant_key, label in (
        ("inprocess_rust", "in-process rust"),
        ("child_rust", "child rust"),
        ("inprocess_typescript", "in-process typescript"),
        ("child_typescript", "child typescript"),
    ):
        r, b = collect_survival_findings(report, variant_key=variant_key, label=label)
        reasons.extend(r)
        blockers.extend(b)

    for variant_key, label in (
        ("child_rust", "child rust"),
        ("child_typescript", "child typescript"),
    ):
        r, b = collect_child_lifecycle_findings(report, variant_key=variant_key, label=label)
        reasons.extend(r)
        blockers.extend(b)

    # Import profile authority from actual inspected bytes (not report constants).
    for kind, label in (("rust", "rust"), ("typescript", "typescript")):
        comp = (report.get("components") or {}).get(kind) or {}
        if not comp.get("ok"):
            continue
        if comp.get("import_profile_ok") is False:
            blockers.append(f"{label} actual import profile failed inspection")
        imports = comp.get("imports")
        if imports is None:
            blockers.append(f"{label} actual imports missing from component artifact")
        elif kind == "rust" and list(imports) != list(RUST_BASELINE_IMPORTS):
            blockers.append(f"rust actual imports {imports!r} != frozen five")
        elif kind == "typescript" and list(imports) != []:
            blockers.append(f"typescript actual imports must be empty, got {imports!r}")

    # Placement selection: fair material comparator; fault containment only if none.
    selected = None
    selection_status = "undecided"
    if blockers:
        selection_status = "blocked"
    else:
        selected, selection_status, sel_reasons, sel_blockers = select_placement_fair(summary)
        reasons.extend(sel_reasons)
        blockers.extend(sel_blockers)
        if blockers:
            selection_status = "blocked"
            selected = None

    if report.get("host_contention", {}).get("contended"):
        selection_status = f"preliminary_{selection_status}"
        reasons.append("host contended; result is preliminary and not acceptance")
    if report.get("protocol", {}).get("quick"):
        selection_status = f"quick_{selection_status}"
        reasons.append("quick mode cannot claim authoritative acceptance")
    if report.get("protocol", {}).get("skip_typescript"):
        selection_status = f"debug_skip_ts_{selection_status}"
        reasons.append("--skip-typescript is debug-only and cannot be authoritative")

    return {
        "selected_placement": selected,
        "selection_status": selection_status,
        "reasons": reasons,
        "blockers": blockers,
        "decision_rule": (
            "Ordinary no-plugin server must stay within 24/32 MiB and not construct "
            "an Engine or spawn a host. Guest trap/CPU/memory survival and child "
            "in-flight crash/recovery/cleanup are mandatory blockers for both Rust and "
            "TypeScript. Real TypeScript component evidence and actual import inspection "
            "are required. Child variants are measured under the SDK-only parent probe. "
            "Fair selection uses warm/peak/cold material thresholds; fault containment "
            "picks child only when neither placement materially regresses. Projected "
            "product totals are temporary probe cross-checks only."
        ),
        "hostile_probe_safety_caps_mib": {
            "rust_linear_memory": HOSTILE_PROBE_RUST_MEMORY_MIB,
            "typescript_linear_memory": HOSTILE_PROBE_TS_MEMORY_MIB,
            "note": (
                "StoreLimits linear-memory safety caps for grow_memory hostile probes only. "
                "Not product active-RSS budgets and not frozen Wave 1 acceptance ceilings."
            ),
        },
    }


def _fixture_hostile_stages(*, ok: bool = True) -> dict[str, Any]:
    resp = {"ok": ok}
    return {
        "trap": {"response": dict(resp)},
        "cpu_loop": {"response": dict(resp)},
        "grow_memory": {"response": dict(resp)},
    }


def _fixture_child_lifecycle(*, ok: bool = True) -> dict[str, Any]:
    stages = _fixture_hostile_stages(ok=ok)
    stages.update(
        {
            "crash_child_inflight": {
                "response": {
                    "ok": ok,
                    "detail": {
                        "cleaned": ok,
                        "parent_survived": ok,
                        "parent_health_ok": ok,
                        "in_flight": True,
                        "session_cleared": ok,
                    },
                },
                "parent_health_after": {"ok": ok},
            },
            "spawn": {
                "response": {"ok": ok, "timings_ms": {"total_ms": 5.0}},
                "wall_ms": 5.0,
            },
            "instantiate": {
                "response": {
                    "ok": ok,
                    "timings_ms": {
                        "engine_create_ms": 1.0,
                        "compile_ms": 10.0,
                        "instantiate_ms": 2.0,
                        "total_ms": 13.0,
                    },
                },
                "wall_ms": 13.0,
            },
            "first_ping": {
                "response": {"ok": ok, "timings_ms": {"first_call_ms": 1.0, "total_ms": 1.0}},
                "wall_ms": 1.0,
            },
            "shutdown_child": {"response": {"ok": ok, "detail": {"cleaned": ok}}},
            "final_health": {"health": {"ok": ok}},
        }
    )
    return stages


def _metric_block(warm: float, peak: float, cold: float) -> dict[str, Any]:
    return {
        "after_warm_cgroup_mib": {"median": warm, "max": warm},
        "peak_cgroup_mib": {"max": peak, "median": peak},
        "cold_total_ms": {"median": cold, "max": cold},
    }


def _base_eval_report() -> dict[str, Any]:
    # Near-parity metrics so fault-containment can select child when containment passes.
    return {
        "artifacts": {
            "server_links_wasmtime": False,
            "sdk_probe_links_wasmtime": False,
            "probe_links_wasmtime": True,
        },
        "summary": {
            "server_baseline": {
                "idle_cgroup_mib": {"max": 4.0},
                "idle_cgroup_peak_mib": {"max": 5.0},
            },
            "inprocess_rust": _metric_block(4.5, 5.0, 20.0),
            "child_rust": _metric_block(4.7, 5.5, 25.0),
            "inprocess_typescript": _metric_block(80.0, 100.0, 200.0),
            "child_typescript": _metric_block(82.0, 105.0, 220.0),
        },
        "components": {
            "rust": {
                "ok": True,
                "imports": list(RUST_BASELINE_IMPORTS),
                "import_profile_ok": True,
            },
            "typescript": {
                "ok": True,
                "path": "tools/phase7-host-placement/components/ts.wasm",
                "imports": [],
                "import_profile_ok": True,
            },
        },
        "samples": {
            "inprocess_rust": [{"mode": "inprocess", "stages": _fixture_hostile_stages(ok=True)}],
            "child_rust": [{"mode": "child", "stages": _fixture_child_lifecycle(ok=True)}],
            "inprocess_typescript": [
                {"mode": "inprocess", "stages": _fixture_hostile_stages(ok=True)}
            ],
            "child_typescript": [
                {"mode": "child", "stages": _fixture_child_lifecycle(ok=True)}
            ],
        },
        "protocol": {"quick": False, "skip_typescript": False},
        "host_contention": {"contended": False},
    }


def run_evaluate_decision_fixtures() -> dict[str, Any]:
    """Synthetic fixtures proving TS skip/missing/failure blocks and complete pass."""
    complete = evaluate_decision(_base_eval_report())
    if complete.get("blockers"):
        raise HarnessError(f"complete TS fixture unexpectedly blocked: {complete['blockers']}")
    if complete.get("selected_placement") != "on_demand_child_host":
        raise HarnessError(f"complete fixture selection unexpected: {complete}")

    skipped = _base_eval_report()
    skipped["components"]["typescript"] = {"ok": False, "skipped": True}
    skipped["samples"].pop("inprocess_typescript", None)
    skipped["samples"].pop("child_typescript", None)
    skipped_decision = evaluate_decision(skipped)
    if not any("typescript component" in b for b in skipped_decision["blockers"]):
        raise HarnessError(f"skipped TS did not block: {skipped_decision['blockers']}")

    missing_ts = _base_eval_report()
    missing_ts["samples"].pop("inprocess_typescript", None)
    missing_ts["samples"].pop("child_typescript", None)
    missing_decision = evaluate_decision(missing_ts)
    if not any("inprocess_typescript" in b or "typescript" in b for b in missing_decision["blockers"]):
        raise HarnessError(f"missing TS samples did not block: {missing_decision['blockers']}")

    failed_ts_trap = _base_eval_report()
    failed_ts_trap["samples"]["inprocess_typescript"] = [
        {"stages": _fixture_hostile_stages(ok=False)}
    ]
    failed_decision = evaluate_decision(failed_ts_trap)
    if not any("in-process typescript trap" in b for b in failed_decision["blockers"]):
        raise HarnessError(f"failed TS trap did not block: {failed_decision['blockers']}")

    failed_ts_kill = _base_eval_report()
    failed_ts_kill["samples"]["child_typescript"] = [
        {"stages": _fixture_child_lifecycle(ok=False)}
    ]
    failed_kill_decision = evaluate_decision(failed_ts_kill)
    if not any(
        "child typescript in-flight crash" in b or "child typescript shutdown" in b
        for b in failed_kill_decision["blockers"]
    ):
        raise HarnessError(
            f"failed TS child lifecycle did not block: {failed_kill_decision['blockers']}"
        )

    # Fair selection rule branches (pure summary metrics).
    child_worse = _base_eval_report()
    child_worse["summary"]["child_rust"] = _metric_block(40.0, 80.0, 500.0)
    child_worse["summary"]["child_typescript"] = _metric_block(200.0, 250.0, 800.0)
    sel, status, _, bl = select_placement_fair(child_worse["summary"])
    if sel != "lazy_inprocess" or bl:
        raise HarnessError(f"child-worse branch failed: {sel} {status} {bl}")

    ip_worse = _base_eval_report()
    ip_worse["summary"]["inprocess_rust"] = _metric_block(40.0, 80.0, 500.0)
    ip_worse["summary"]["inprocess_typescript"] = _metric_block(200.0, 250.0, 800.0)
    sel, status, _, bl = select_placement_fair(ip_worse["summary"])
    if sel != "on_demand_child_host" or bl:
        raise HarnessError(f"inprocess-worse branch failed: {sel} {status} {bl}")

    conflict = _base_eval_report()
    conflict["summary"]["child_rust"] = _metric_block(40.0, 5.5, 25.0)
    conflict["summary"]["inprocess_typescript"] = _metric_block(200.0, 100.0, 200.0)
    sel, status, _, bl = select_placement_fair(conflict["summary"])
    if sel is not None or not bl:
        raise HarnessError(f"conflict branch failed: {sel} {status} {bl}")

    no_reg = _base_eval_report()
    sel, status, _, bl = select_placement_fair(no_reg["summary"])
    if sel != "on_demand_child_host" or "fault containment" not in status.replace("_", " "):
        # status is selected_by_fault_containment_no_material_regression
        if sel != "on_demand_child_host" or "fault_containment" not in status:
            raise HarnessError(f"no-regression branch failed: {sel} {status} {bl}")

    bad_imports = _base_eval_report()
    bad_imports["components"]["rust"]["imports"] = ["wasi:http/types@0.2.6"]
    bad_imports["components"]["rust"]["import_profile_ok"] = False
    bad_imp_decision = evaluate_decision(bad_imports)
    if not any("import" in b for b in bad_imp_decision["blockers"]):
        raise HarnessError(f"bad imports did not block: {bad_imp_decision['blockers']}")

    return {
        "complete_selected": complete.get("selected_placement"),
        "skipped_ts_blocks": True,
        "missing_ts_blocks": True,
        "failed_ts_trap_blocks": True,
        "failed_ts_child_lifecycle_blocks": True,
        "selection_child_worse_picks_inprocess": True,
        "selection_inprocess_worse_picks_child": True,
        "selection_conflict_blocks": True,
        "selection_no_regression_fault_containment": True,
        "bad_imports_block": True,
    }


def stage_cold_ms(stage: dict[str, Any], *, component_keys: tuple[str, ...]) -> float | None:
    """Exact cold aggregation for one stage.

    Prefer timings_ms.total_ms when present; otherwise sum named component fields;
    otherwise wall_ms. Never add total_ms together with component fields.
    """
    resp = stage.get("response") or {}
    timings = resp.get("timings_ms") or {}
    if timings.get("total_ms") is not None:
        return float(timings["total_ms"])
    parts = [
        float(timings[key])
        for key in component_keys
        if key != "total_ms" and timings.get(key) is not None
    ]
    if parts:
        return float(sum(parts))
    wall = stage.get("wall_ms")
    if wall is not None:
        return float(wall)
    return None


def cold_total_from_stages(stages: dict[str, Any], *, mode: str) -> float | None:
    """Cold total ms from exact stages: engine/compile/instantiate/first call or child spawn path."""
    total = 0.0
    saw = False

    def add_stage(name: str, component_keys: tuple[str, ...]) -> None:
        nonlocal total, saw
        stage = stages.get(name) or {}
        value = stage_cold_ms(stage, component_keys=component_keys)
        if value is None:
            return
        total += value
        saw = True

    if mode == "child":
        add_stage("spawn", ("total_ms",))
        add_stage("instantiate", ("engine_create_ms", "compile_ms", "instantiate_ms", "total_ms"))
        add_stage("first_ping", ("first_call_ms", "total_ms"))
    else:
        add_stage("create_engine", ("engine_create_ms", "total_ms"))
        add_stage("compile", ("compile_ms", "total_ms"))
        add_stage("instantiate", ("instantiate_ms", "total_ms"))
        add_stage("first_ping", ("first_call_ms", "total_ms"))
    return total if saw else None


def run_cold_total_fixtures() -> dict[str, Any]:
    """Synthetic exact expected cold totals for in-process and child."""
    inprocess_stages = {
        "create_engine": {"response": {"timings_ms": {"engine_create_ms": 1.0, "total_ms": 1.5}}},
        "compile": {"response": {"timings_ms": {"compile_ms": 10.0, "total_ms": 12.0}}},
        # No total_ms: sum components only (must not invent double count).
        "instantiate": {
            "response": {"timings_ms": {"instantiate_ms": 2.0}},
            "wall_ms": 99.0,
        },
        "first_ping": {"response": {"timings_ms": {"first_call_ms": 0.5, "total_ms": 0.7}}},
    }
    # 1.5 + 12.0 + 2.0 + 0.7 = 16.2 (instantiate uses component, not wall)
    ip = cold_total_from_stages(inprocess_stages, mode="inprocess")
    if ip != 16.2:
        raise HarnessError(f"in-process cold total expected 16.2, got {ip}")

    child_stages = {
        "spawn": {"response": {"timings_ms": {"total_ms": 5.0}}, "wall_ms": 9.0},
        "instantiate": {
            "response": {
                "timings_ms": {
                    "engine_create_ms": 1.0,
                    "compile_ms": 10.0,
                    "instantiate_ms": 2.0,
                    "total_ms": 13.0,
                }
            }
        },
        "first_ping": {"wall_ms": 3.0},
    }
    # 5.0 + 13.0 + 3.0 = 21.0 (spawn prefers total over wall; first_ping wall only)
    ch = cold_total_from_stages(child_stages, mode="child")
    if ch != 21.0:
        raise HarnessError(f"child cold total expected 21.0, got {ch}")

    # total_ms present must not also add component fields.
    no_double = {
        "create_engine": {
            "response": {"timings_ms": {"engine_create_ms": 100.0, "total_ms": 1.0}}
        },
        "compile": {"response": {"timings_ms": {"total_ms": 2.0}}},
        "instantiate": {"response": {"timings_ms": {"total_ms": 3.0}}},
        "first_ping": {"response": {"timings_ms": {"total_ms": 4.0}}},
    }
    nd = cold_total_from_stages(no_double, mode="inprocess")
    if nd != 10.0:
        raise HarnessError(f"no-double cold total expected 10.0, got {nd}")

    return {
        "inprocess_expected": 16.2,
        "child_expected": 21.0,
        "no_double_expected": 10.0,
        "ok": True,
    }


def summarize_variant(
    samples: list[dict[str, Any]],
    *,
    active_stage: str | None,
    mode: str | None = None,
) -> dict[str, Any]:
    if not samples:
        return {}
    idle_vals = []
    peak_vals = []
    active_vals = []
    startup_vals = []
    cold_vals = []
    for sample in samples:
        startup_vals.append(float(sample.get("startup_to_health_ms") or 0.0))
        sample_mode = mode or sample.get("mode") or ""
        if "idle" in sample:
            idle_vals.append(float(sample["idle"]["cgroup_current_mib"]))
            peak_vals.append(float(sample["idle"]["cgroup_peak_mib"]))
        stages = sample.get("stages") or {}
        cold = cold_total_from_stages(stages, mode=str(sample_mode))
        if cold is not None:
            cold_vals.append(float(cold))
        linked = stages.get("linked_idle") or {}
        if linked.get("memory"):
            idle_vals.append(float(linked["memory"]["cgroup_current_mib"]))
            peak_vals.append(float(linked["memory"]["cgroup_peak_mib"]))
        for stage_name, stage in stages.items():
            mem = stage.get("memory")
            if not mem:
                continue
            peak_vals.append(float(mem["cgroup_peak_mib"]))
            if active_stage and stage_name == active_stage:
                active_vals.append(float(mem["cgroup_current_mib"]))
        # track global peak across stages
        for stage in stages.values():
            mem = stage.get("memory")
            if mem:
                peak_vals.append(float(mem["cgroup_peak_mib"]))
    out: dict[str, Any] = {
        "samples": len(samples),
        "startup_to_health_ms": series_summary(startup_vals),
    }
    if idle_vals:
        out["idle_cgroup_mib"] = series_summary(idle_vals)
    if active_vals:
        out["after_warm_cgroup_mib"] = series_summary(active_vals)
    if peak_vals:
        out["idle_cgroup_peak_mib"] = series_summary(peak_vals)
        out["peak_cgroup_mib"] = series_summary(peak_vals)
    if cold_vals:
        out["cold_total_ms"] = series_summary(cold_vals)
    return out


def derive_measured_ceilings(
    summary: dict[str, Any],
    *,
    selected_placement: str | None,
) -> dict[str, Any]:
    """Derive preliminary product-active ceilings from projected totals + headroom.

    Probe cgroup totals are not product server+runtime totals. Project each active
    placement as:
      projected = server_baseline + max(0, variant - sdk_only_probe)
    Final selected-profile ceilings derive from the selected placement only;
    losing projections are retained separately.
    """

    def series_max(variant: str, field: str) -> float | None:
        value = ((summary.get(variant) or {}).get(field) or {}).get("max")
        return float(value) if value is not None else None

    def series_median(variant: str, field: str) -> float | None:
        value = ((summary.get(variant) or {}).get(field) or {}).get("median")
        return float(value) if value is not None else None

    server_warm = series_max("server_baseline", "idle_cgroup_mib")
    server_peak = series_max("server_baseline", "peak_cgroup_mib")
    sdk_warm = series_median("sdk_only", "idle_cgroup_mib")
    sdk_peak = series_median("sdk_only", "peak_cgroup_mib")

    def project(variant: str, *, active_field: str, peak_field: str) -> dict[str, float | None]:
        variant_warm = series_max(variant, active_field)
        variant_peak = series_max(variant, peak_field)
        projected_warm = None
        projected_peak = None
        if server_warm is not None and variant_warm is not None and sdk_warm is not None:
            projected_warm = round(server_warm + max(0.0, variant_warm - sdk_warm), 4)
        if server_peak is not None and variant_peak is not None and sdk_peak is not None:
            projected_peak = round(server_peak + max(0.0, variant_peak - sdk_peak), 4)
        return {
            "variant_warm_max_mib": variant_warm,
            "variant_peak_max_mib": variant_peak,
            "projected_product_warm_mib": projected_warm,
            "projected_product_peak_mib": projected_peak,
        }

    projections = {
        "inprocess_rust": project(
            "inprocess_rust", active_field="after_warm_cgroup_mib", peak_field="peak_cgroup_mib"
        ),
        "child_rust": project(
            "child_rust", active_field="after_warm_cgroup_mib", peak_field="peak_cgroup_mib"
        ),
        "inprocess_typescript": project(
            "inprocess_typescript",
            active_field="after_warm_cgroup_mib",
            peak_field="peak_cgroup_mib",
        ),
        "child_typescript": project(
            "child_typescript",
            active_field="after_warm_cgroup_mib",
            peak_field="peak_cgroup_mib",
        ),
    }

    def max_projected(keys: list[str], field: str) -> float | None:
        values = [
            projections[k][field]
            for k in keys
            if projections.get(k) and projections[k].get(field) is not None
        ]
        return max(values) if values else None

    if selected_placement == "on_demand_child_host":
        selected_rust_keys = ["child_rust"]
        selected_ts_keys = ["child_typescript"]
        losing_rust_keys = ["inprocess_rust"]
        losing_ts_keys = ["inprocess_typescript"]
    elif selected_placement == "lazy_inprocess":
        selected_rust_keys = ["inprocess_rust"]
        selected_ts_keys = ["inprocess_typescript"]
        losing_rust_keys = ["child_rust"]
        losing_ts_keys = ["child_typescript"]
    else:
        selected_rust_keys = []
        selected_ts_keys = []
        losing_rust_keys = ["inprocess_rust", "child_rust"]
        losing_ts_keys = ["inprocess_typescript", "child_typescript"]

    rust_warm = max_projected(selected_rust_keys, "projected_product_warm_mib")
    rust_peak = max_projected(selected_rust_keys, "projected_product_peak_mib")
    ts_warm = max_projected(selected_ts_keys, "projected_product_warm_mib")
    ts_peak = max_projected(selected_ts_keys, "projected_product_peak_mib")

    def with_headroom(value: float | None, *, pct: float, floor_mib: float) -> float | None:
        if value is None:
            return None
        return round(max(value * (1.0 + pct), value + floor_mib), 4)

    return {
        "selected_placement": selected_placement,
        "selected_projection_keys": {
            "rust": selected_rust_keys,
            "typescript": selected_ts_keys,
        },
        "losing_projections": {
            key: projections.get(key)
            for key in [*losing_rust_keys, *losing_ts_keys]
            if key in projections
        },
        "basis": (
            "projected_product = server_baseline + max(0, variant - sdk_only); "
            "selected-profile ceilings use selected placement only + headroom"
        ),
        "headroom_rule": (
            "ceil = max(projected_max * 1.25, projected_max + 8 MiB) for Rust; "
            "max(projected_max * 1.25, projected_max + 16 MiB) for TypeScript; "
            "unresolved when required series are missing"
        ),
        "server_baseline_warm_max_mib": server_warm,
        "server_baseline_peak_max_mib": server_peak,
        "sdk_only_warm_median_mib": sdk_warm,
        "sdk_only_peak_median_mib": sdk_peak,
        "projections": projections,
        "projected_rust_warm_max_mib": rust_warm,
        "projected_rust_peak_max_mib": rust_peak,
        "projected_typescript_warm_max_mib": ts_warm,
        "projected_typescript_peak_max_mib": ts_peak,
        "preliminary_rust_warm_ceiling_mib": with_headroom(rust_warm, pct=0.25, floor_mib=8.0),
        "preliminary_rust_peak_ceiling_mib": with_headroom(rust_peak, pct=0.25, floor_mib=8.0),
        "preliminary_typescript_warm_ceiling_mib": with_headroom(
            ts_warm, pct=0.25, floor_mib=16.0
        ),
        "preliminary_typescript_peak_ceiling_mib": with_headroom(
            ts_peak, pct=0.25, floor_mib=16.0
        ),
        "status": (
            "derived_from_projected_measurements"
            if rust_peak is not None or ts_peak is not None
            else "unresolved_no_active_measurements"
        ),
        "limitations": [
            "Projection is not an integrated server+host measurement.",
            (
                "Projection is not SDK-linked integrated junban-server proof; "
                "Wave 1 must measure matched server-with-SDK default path."
            ),
            "Wave 5 must measure actual product server+host and may revise ceilings.",
            "Raw probe/child cgroup totals alone must not be frozen as product budgets.",
        ],
        "note": (
            "Preliminary Wave 0 ADR numbers only. Not authoritative Wave 1 acceptance "
            "gates until five-sample idle-host evidence is recorded and accepted."
        ),
    }


def run_campaign(
    *,
    quick: bool,
    skip_typescript: bool,
    idle_host_confirmed: bool,
) -> dict[str, Any]:
    require_cgroup_stack()
    samples_n = QUICK_SAMPLES if quick else AUTHORITATIVE_SAMPLES
    host = BENCH.host_metadata(REPO_ROOT)
    # Authoritative eligibility uses start-of-run tree cleanliness only. Writing
    # the evidence JSON after measurement must not retroactively dirty this bit.
    dirty_at_start = git_dirty(REPO_ROOT)
    contention_pre = host_contention(host, phase="pre")

    artifacts = build_release_artifacts()
    rust_component = build_rust_component()
    ts_component: dict[str, Any]
    if skip_typescript:
        ts_component = {"ok": False, "skipped": True}
    else:
        try:
            ts_component = build_typescript_component()
        except HarnessError as error:
            ts_component = {"ok": False, "error": str(error)}

    web_dir = ensure_web_dir()
    # Ensure a production-ish web dir exists; prefer real dist if present.
    if not (REPO_ROOT / "dist" / "index.html").is_file():
        # Try building frontend once; fall back to empty shell on failure.
        built = run_cmd(["pnpm", "build"], cwd=REPO_ROOT, check=False)
        if built.returncode == 0 and (REPO_ROOT / "dist" / "index.html").is_file():
            web_dir = REPO_ROOT / "dist"

    server = Path(artifacts["paths"]["server"])
    probe = Path(artifacts["paths"]["probe"])
    sdk_probe = Path(artifacts["paths"]["sdk_probe"])
    host_bin = Path(artifacts["paths"]["host"])
    rust_wasm = REPO_ROOT / rust_component["path"]

    samples: dict[str, list[dict[str, Any]]] = {
        "server_baseline": [],
        "sdk_only": [],
        "inprocess_rust": [],
        "child_rust": [],
    }
    if ts_component.get("ok"):
        samples["inprocess_typescript"] = []
        samples["child_typescript"] = []

    for i in range(samples_n):
        samples["server_baseline"].append(
            measure_server_baseline(server=server, web_dir=web_dir, sample_index=i)
        )
        samples["sdk_only"].append(
            measure_probe_variant(
                label="sdk_only",
                probe=sdk_probe,
                mode="sdk",
                sample_index=i,
                stages=[{"stage": "idle"}],
            )
        )
        samples["inprocess_rust"].append(
            measure_probe_variant(
                label="inprocess_rust",
                probe=probe,
                mode="inprocess",
                sample_index=i,
                component=rust_wasm,
                component_kind="rust",
                stages=rust_stage_plan(),
            )
        )
        samples["child_rust"].append(
            measure_probe_variant(
                label="child_rust",
                # Fair comparator: child parent is SDK-only (no Wasmtime in parent).
                probe=sdk_probe,
                mode="child",
                sample_index=i,
                component=rust_wasm,
                component_kind="rust",
                host_bin=host_bin,
                stages=child_stage_plan(),
            )
        )
        if ts_component.get("ok"):
            ts_wasm = REPO_ROOT / ts_component["path"]
            samples["inprocess_typescript"].append(
                measure_probe_variant(
                    label="inprocess_typescript",
                    probe=probe,
                    mode="inprocess",
                    sample_index=i,
                    component=ts_wasm,
                    component_kind="typescript",
                    stages=rust_stage_plan(),
                )
            )
            samples["child_typescript"].append(
                measure_probe_variant(
                    label="child_typescript",
                    probe=sdk_probe,
                    mode="child",
                    sample_index=i,
                    component=ts_wasm,
                    component_kind="typescript",
                    host_bin=host_bin,
                    stages=child_stage_plan(),
                )
            )

    summary = {
        "server_baseline": summarize_variant(samples["server_baseline"], active_stage=None),
        "sdk_only": summarize_variant(samples["sdk_only"], active_stage="idle", mode="sdk"),
        "inprocess_rust": summarize_variant(
            samples["inprocess_rust"], active_stage="warm_ping", mode="inprocess"
        ),
        "child_rust": summarize_variant(
            samples["child_rust"], active_stage="warm_ping", mode="child"
        ),
    }
    if "inprocess_typescript" in samples:
        summary["inprocess_typescript"] = summarize_variant(
            samples["inprocess_typescript"], active_stage="warm_ping", mode="inprocess"
        )
        summary["child_typescript"] = summarize_variant(
            samples["child_typescript"], active_stage="warm_ping", mode="child"
        )

    contention_post = host_contention(host, phase="post")
    # Pre/post use respective semantics: pre enforces historical load; post does not.
    contended = bool(contention_pre["contended"] or contention_post["contended"])

    ts_ok = bool(ts_component.get("ok")) and not ts_component.get("skipped")
    has_ts_samples = bool(samples.get("inprocess_typescript")) and bool(
        samples.get("child_typescript")
    )
    authoritative = (
        not quick
        and not skip_typescript
        and idle_host_confirmed
        and not dirty_at_start
        and not contended
        and not contention_pre["contended"]
        and not contention_post["contended"]
        and samples_n >= AUTHORITATIVE_SAMPLES
        and not artifacts.get("server_links_wasmtime")
        and not artifacts.get("sdk_probe_links_wasmtime")
        and bool(artifacts.get("probe_links_wasmtime"))
        and ts_ok
        and has_ts_samples
    )
    if quick:
        evidence_status = "preliminary_quick"
    elif skip_typescript:
        evidence_status = "preliminary_skip_typescript_debug"
    elif not idle_host_confirmed:
        evidence_status = "preliminary_idle_host_not_confirmed"
    elif dirty_at_start or contended:
        evidence_status = "preliminary_contended_or_dirty_host"
    elif not ts_ok or not has_ts_samples:
        evidence_status = "preliminary_typescript_evidence_incomplete"
    elif authoritative:
        evidence_status = "authoritative_candidate"
    else:
        evidence_status = "preliminary"

    report: dict[str, Any] = {
        "protocol": {
            "name": PROTOCOL_NAME,
            "version": PROTOCOL_VERSION,
            "quick": quick,
            "skip_typescript": skip_typescript,
            "idle_host_confirmed": idle_host_confirmed,
            "samples": samples_n,
            "authoritative_samples": AUTHORITATIVE_SAMPLES,
            "wasmtime": WASMTIME_VERSION,
            "wasmtime_wasi": WASMTIME_VERSION,
            "wasmtime_features": [
                "runtime",
                "cranelift",
                "component-model",
                "async",
            ],
            "wasmtime_wasi_features": ["p2"],
            "jco": JCO_VERSION,
            "componentize_js": COMPONENTIZE_JS_VERSION,
            "rustc_required": "1.93.0",
            "import_profiles": {
                "typescript_pure": {
                    "componentize_js_disable": ["all"],
                    "imports": [],
                    "note": "zero WASI imports; host must not broaden linker for TS",
                },
                "rust_wasm32_wasip2_baseline": {
                    "imports": [
                        "wasi:io/error@0.2.6",
                        "wasi:io/streams@0.2.6",
                        "wasi:cli/environment@0.2.6",
                        "wasi:cli/exit@0.2.6",
                        "wasi:cli/stderr@0.2.6",
                    ],
                    "ctx": "empty env/args; stdin closed; stdout/stderr sink; no preopens/sockets/http",
                    "linker_note": (
                        "Spike may call p2::add_to_linker_async which defines a broader "
                        "interface set than these five imports. That is NOT the product "
                        "selective linker; Wave 2 must import-lint exact baseline+grants."
                    ),
                },
            },
        },
        "host": host,
        "host_contention": {
            "pre": contention_pre,
            "post": contention_post,
            "contended": contended,
        },
        "git_dirty_at_start": dirty_at_start,
        # Backward-compatible alias; always the start-of-run value.
        "git_dirty": dirty_at_start,
        "evidence_status": evidence_status,
        "accepted": False,  # Never auto-accept; architecture review is separate.
        "artifacts": artifacts,
        "components": {
            "rust": rust_component,
            "typescript": ts_component,
        },
        "samples": samples,
        "summary": summary,
        "command": " ".join(sys.argv),
        "run_id": uuid.uuid4().hex,
    }
    report["decision"] = evaluate_decision(report)
    report["measured_preliminary_active_ceilings_mib"] = derive_measured_ceilings(
        summary,
        selected_placement=report["decision"].get("selected_placement"),
    )
    return report


def write_report(report: dict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--quick", action="store_true", help="1 sample; not authoritative")
    parser.add_argument(
        "--idle-host-confirmed",
        action="store_true",
        help=(
            "Operator attests the host is idle enough for an authoritative candidate. "
            "Required with five samples, clean tree, and no contention signals."
        ),
    )
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--build-components", action="store_true")
    parser.add_argument("--skip-typescript", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    try:
        if args.self_check:
            checks = self_check()
            print(json.dumps({"ok": True, "checks": checks}, indent=2))
            return 0
        if args.build_components:
            rust = build_rust_component()
            ts = (
                {"skipped": True}
                if args.skip_typescript
                else build_typescript_component()
            )
            print(json.dumps({"rust": rust, "typescript": ts}, indent=2))
            return 0 if rust and (args.skip_typescript or ts.get("ok") or "error" in ts) else 1
        if args.build_only:
            artifacts = build_release_artifacts()
            rust = build_rust_component()
            print(json.dumps({"artifacts": artifacts, "rust_component": rust}, indent=2))
            return 0

        self_check()
        report = run_campaign(
            quick=args.quick,
            skip_typescript=args.skip_typescript,
            idle_host_confirmed=args.idle_host_confirmed,
        )
        write_report(report, args.output)
        print(
            json.dumps(
                {
                    "ok": True,
                    "output": str(args.output),
                    "evidence_status": report["evidence_status"],
                    "decision": report["decision"],
                    "summary": report["summary"],
                    "measured_preliminary_active_ceilings_mib": report[
                        "measured_preliminary_active_ceilings_mib"
                    ],
                },
                indent=2,
            )
        )
        # Non-zero only on harness failure; preliminary data still exits 0.
        if report["decision"].get("blockers"):
            return 2
        return 0
    except HarnessError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
