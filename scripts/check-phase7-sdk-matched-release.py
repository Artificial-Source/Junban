#!/usr/bin/env python3
"""Matched optimized Phase 7 SDK-linkage release harness.

Builds feature-off and default junban-server binaries into separate target
roots, proves the SDK marker is present only in default and Wasmtime is absent
from both, then runs interleaved frozen Phase 1 workloads through the shared
cgroup-v2 benchmark implementation. This script never constructs a plugin
runtime and cannot approve evidence produced from a dirty or contended host.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
BENCH_PATH = REPO_ROOT / "scripts" / "bench-hosted-server.py"
PROTOCOL_NAME = "junban-phase7-sdk-matched-release-v1"
PROTOCOL_VERSION = 1
SAMPLES = 5
QUICK_SAMPLES = 1
WARM_CEILING_MIB = 24.0
PEAK_CEILING_MIB = 32.0
DELTA_PCT = 0.15
DELTA_FLOOR_MIB = 1.0
PHASE6_MEDIAN_MIB = 8.3711
PHASE6_DELTA_MIB = 1.255665
SDK_MARKER = b"JUNBAN_PLUGIN_SDK_LINKAGE_V1:"
SDK_ENTRYPOINT_MARKERS = (
    b"inspect_and_verify_package",
    b"inspect_component",
    b"pack_package",
    b"parse_and_verify_registry",
    b"permission_set_hash",
    b"validate_dependency_graph",
    b"validate_dependency_locks",
    b"validate_permission_grants",
    b"validate_registry_package_agreement",
    b"verify_signer_authority",
)
WASMTIME_MARKERS = (b"wasmtime_runtime", b"wasmtime_wasi", b"wasmtime::runtime", b"cranelift_codegen")
DEFAULT_OUTPUT = Path("goals/rust-rewrite/evidence/phase-7-sdk-matched-release.json")
DEFAULT_TARGET_ROOT = Path("target/phase7-sdk-matched")

# Host-placement semantics (Phase 7 accepted evidence policy).
LOAD1_BUSY_PER_CPU = 0.50
LOAD5_BUSY_PER_CPU = 0.30
LOAD_FLOOR = 1.0
ACTIVITY_SAMPLE_SECONDS = 0.25
MIN_ACTIVE_CPU_TICK_DELTA = 2
SWAP_PAGE_BYTES = 4096
SWAP_ACTIVE_PAGES_PER_SEC = 256.0
SWAP_ACTIVE_MIB_PER_SEC = (
    SWAP_ACTIVE_PAGES_PER_SEC * SWAP_PAGE_BYTES / (1024.0 * 1024.0)
)
DIRECT_BUILD_EXES = frozenset(
    {
        "cargo",
        "rustc",
        "rustdoc",
        "clippy",
        "clippy-driver",
        "sccache",
        "npm",
        "npx",
        "pnpm",
        "yarn",
        "wasm-opt",
        "wizer",
    }
)
BROWSER_EXES = frozenset(
    {
        "chrome",
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "firefox",
        "firefox-bin",
    }
)
NODE_EXES = frozenset({"node", "nodejs"})
NODE_TOOL_MARKERS: tuple[str, ...] = (
    "/node_modules/.bin/",
    "componentize-js",
    "componentize",
    "playwright",
    "webpack",
    "rollup",
    "vitest",
    "eslint",
    "astro",
    "jest",
    "vite",
    "next",
    "tsc",
    "npm",
    "npx",
    "pnpm",
    "yarn",
)
HARNESS_NAME = "check-phase7-sdk-matched-release"


class HarnessError(RuntimeError):
    pass


def load_bench() -> Any:
    spec = importlib.util.spec_from_file_location("junban_bench", BENCH_PATH)
    if spec is None or spec.loader is None:
        raise HarnessError("cannot load hosted benchmark")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(args: list[str], *, cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "")[-3000:]
        raise HarnessError(f"command failed ({result.returncode}): {' '.join(args)}\n{tail}")
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def binary_metadata(path: Path) -> dict[str, Any]:
    return {"path": str(path), "size_bytes": path.stat().st_size, "sha256": sha256_file(path)}


def build_server(target: Path, *, sdk: bool) -> Path:
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(target.resolve())
    command = ["cargo", "build", "--locked", "--release", "-p", "junban-server"]
    if not sdk:
        command.append("--no-default-features")
    run(command, env=env)
    binary = target / "release" / ("junban-server.exe" if os.name == "nt" else "junban-server")
    if not binary.is_file():
        raise HarnessError(f"release server missing: {binary}")
    return binary


def inspect_binary(path: Path, *, sdk_expected: bool) -> dict[str, Any]:
    data = path.read_bytes()
    marker_present = SDK_MARKER in data
    entrypoint_markers = [marker.decode("ascii") for marker in SDK_ENTRYPOINT_MARKERS if marker in data]
    wasmtime_hits = [marker.decode("ascii") for marker in WASMTIME_MARKERS if marker in data]
    if marker_present != sdk_expected:
        raise HarnessError(f"SDK marker expectation failed for {path}")
    if sdk_expected and len(entrypoint_markers) != len(SDK_ENTRYPOINT_MARKERS):
        raise HarnessError(f"SDK entrypoint table incomplete in {path}")
    if not sdk_expected and entrypoint_markers:
        raise HarnessError(f"SDK entrypoint table present in feature-off {path}")
    if wasmtime_hits:
        raise HarnessError(f"Wasmtime marker found in {path}: {wasmtime_hits}")
    return {
        "sdk_marker_present": marker_present,
        "sdk_entrypoint_markers": entrypoint_markers,
        "wasmtime_markers": wasmtime_hits,
    }


def inspect_tree(*, sdk: bool) -> dict[str, Any]:
    command = ["cargo", "tree", "--locked", "-p", "junban-server", "--edges", "normal,build"]
    if not sdk:
        command.append("--no-default-features")
    output = run(command).stdout
    sdk_present = "junban-plugin-sdk" in output
    wasmtime_present = any(name in output for name in ("wasmtime ", "wasmtime-wasi", "wasmtime-runtime"))
    if sdk_present != sdk or wasmtime_present:
        raise HarnessError("cargo tree linkage boundary failed")
    return {"sdk_present": sdk_present, "wasmtime_present": wasmtime_present, "sha256": hashlib.sha256(output.encode()).hexdigest()}


def summarize(samples: list[dict[str, Any]], bench: Any) -> dict[str, Any]:
    summary = bench.build_summary(samples)
    summary["process_counts"] = [int(sample["warm"]["process_count"]) for sample in samples]
    summary["cleanup_passed"] = all(bool(sample["cleanup_success"]) for sample in samples)
    return summary


def evaluate(feature_off: dict[str, Any], default: dict[str, Any]) -> dict[str, Any]:
    baseline = float(feature_off["warm_cgroup_mib"]["median"])
    linked = float(default["warm_cgroup_mib"]["median"])
    delta = linked - baseline
    allowed = max(DELTA_FLOOR_MIB, baseline * DELTA_PCT)
    phase6_delta = linked - PHASE6_MEDIAN_MIB
    checks = {
        "default_max_warm": float(default["warm_cgroup_mib"]["max"]) <= WARM_CEILING_MIB,
        "default_max_peak": float(default["warm_cgroup_peak_mib"]["max"])
        <= PEAK_CEILING_MIB,
        "matched_median_delta": delta <= allowed,
        "phase6_frozen_median_delta": phase6_delta <= PHASE6_DELTA_MIB,
        "one_process": all(value == 1 for value in feature_off["process_counts"] + default["process_counts"]),
        "cleanup": bool(feature_off["cleanup_passed"] and default["cleanup_passed"]),
    }
    return {
        "default_minus_feature_off_median_mib": round(delta, 6),
        "matched_allowed_delta_mib": round(allowed, 6),
        "default_minus_phase6_median_mib": round(phase6_delta, 6),
        "phase6_allowed_delta_mib": PHASE6_DELTA_MIB,
        "checks": checks,
        "passed": all(checks.values()),
    }


def load_thresholds(cpus: int) -> dict[str, float]:
    cpus = max(int(cpus), 1)
    return {
        "cpu_count": float(cpus),
        "load1_threshold": max(LOAD_FLOOR, cpus * LOAD1_BUSY_PER_CPU),
        "load5_threshold": max(LOAD_FLOOR, cpus * LOAD5_BUSY_PER_CPU),
    }


def load_contention_reasons(load1: float, load5: float, cpus: int) -> list[str]:
    """Pure load gate: load1/load5 strictly above CPU-scaled thresholds contend."""
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


def confounder_candidate_hits(comm: str, exe: str, cmdline: str) -> list[str]:
    """Pure candidacy: build/preview/browser only; bare node/Pi is not a hit."""
    comm_l = (comm or "").lower().strip()
    exe_l = (exe or "").lower().strip()
    cmd_l = (cmdline or "").lower()
    exe_base = os.path.basename(exe_l) if exe_l else ""
    identity_tokens = set(re.split(r"[^a-z0-9_.+-]+", f"{comm_l} {exe_l} {exe_base}"))
    identity_tokens.discard("")
    hits: list[str] = []

    for name in sorted(DIRECT_BUILD_EXES):
        if name in identity_tokens or name == comm_l or name == exe_base:
            hits.append(f"direct:{name}")
    for name in sorted(BROWSER_EXES):
        if (
            name in identity_tokens
            or name == comm_l
            or name == exe_base
            or name in comm_l
            or name in exe_base
        ):
            hits.append(f"browser:{name}")

    is_node = bool(identity_tokens.intersection(NODE_EXES)) or comm_l in NODE_EXES or exe_base in NODE_EXES
    if is_node:
        blob = f"{comm_l} {cmd_l}"
        for marker in NODE_TOOL_MARKERS:
            if marker in blob:
                hits.append(f"node_tool:{marker}")
                break

    seen: set[str] = set()
    ordered: list[str] = []
    for hit in hits:
        if hit not in seen:
            seen.add(hit)
            ordered.append(hit)
    return ordered


def is_confounder_candidate(comm: str, exe: str, cmdline: str) -> bool:
    return bool(confounder_candidate_hits(comm, exe, cmdline))


def swap_io_rate_pages_per_sec(
    pswpin_delta: int,
    pswpout_delta: int,
    *,
    sample_seconds: float,
) -> float:
    seconds = max(float(sample_seconds), 1e-9)
    pages = max(0, int(pswpin_delta)) + max(0, int(pswpout_delta))
    return float(pages) / seconds


def swap_io_is_active(
    pswpin_delta: int,
    pswpout_delta: int,
    *,
    sample_seconds: float = ACTIVITY_SAMPLE_SECONDS,
    threshold_pages_per_sec: float = SWAP_ACTIVE_PAGES_PER_SEC,
) -> bool:
    rate = swap_io_rate_pages_per_sec(
        pswpin_delta, pswpout_delta, sample_seconds=sample_seconds
    )
    return rate >= float(threshold_pages_per_sec)


def swap_io_assessment(
    pswpin_delta: int,
    pswpout_delta: int,
    *,
    sample_seconds: float = ACTIVITY_SAMPLE_SECONDS,
) -> dict[str, Any]:
    pin = max(0, int(pswpin_delta))
    pout = max(0, int(pswpout_delta))
    seconds = max(float(sample_seconds), 1e-9)
    pages = pin + pout
    rate = float(pages) / seconds
    mib_s = rate * SWAP_PAGE_BYTES / (1024.0 * 1024.0)
    active = rate >= float(SWAP_ACTIVE_PAGES_PER_SEC)
    return {
        "pswpin_delta": pin,
        "pswpout_delta": pout,
        "combined_pages_delta": pages,
        "sample_seconds": float(sample_seconds),
        "pages_per_sec": rate,
        "mib_per_sec": mib_s,
        "page_bytes_assumed": SWAP_PAGE_BYTES,
        "threshold_pages_per_sec": float(SWAP_ACTIVE_PAGES_PER_SEC),
        "threshold_mib_per_sec": float(SWAP_ACTIVE_MIB_PER_SEC),
        "active": active,
        "informational_below_threshold": (not active) and pages > 0,
        "method": (
            "combined pswpin+pswpout page rate over sample window; "
            f">= {SWAP_ACTIVE_PAGES_PER_SEC:g} pages/s "
            f"(>= {SWAP_ACTIVE_MIB_PER_SEC:g} MiB/s at {SWAP_PAGE_BYTES}-byte pages) "
            "enforced; below-threshold activity informational only"
        ),
    }


def read_proc_cpu_ticks(pid: int) -> int | None:
    try:
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


def parse_ppid_from_stat(stat_text: str) -> int | None:
    if not stat_text:
        return None
    rparen = stat_text.rfind(")")
    if rparen < 0:
        return None
    rest = stat_text[rparen + 1 :].split()
    if len(rest) < 2:
        return None
    try:
        ppid = int(rest[1])
    except ValueError:
        return None
    if ppid < 0:
        return None
    return ppid


def walk_ancestor_pids(
    start_pid: int,
    ppid_of: Any,
    *,
    max_depth: int = 64,
) -> list[int]:
    ancestors: list[int] = []
    seen: set[int] = {int(start_pid)}
    pid = int(start_pid)
    for _ in range(max(1, int(max_depth))):
        try:
            ppid = ppid_of(pid)
        except Exception:
            break
        if ppid is None:
            break
        try:
            ppid_i = int(ppid)
        except (TypeError, ValueError):
            break
        if ppid_i <= 1:
            break
        if ppid_i in seen:
            break
        seen.add(ppid_i)
        ancestors.append(ppid_i)
        pid = ppid_i
    return ancestors


def read_ppid(pid: int) -> int | None:
    try:
        text = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    return parse_ppid_from_stat(text)


def harness_exclusion_set(start_pid: int | None = None) -> dict[str, Any]:
    harness_pid = int(start_pid if start_pid is not None else os.getpid())
    ancestors = walk_ancestor_pids(harness_pid, read_ppid, max_depth=64)
    excluded = [harness_pid, *ancestors]
    return {
        "harness_pid": harness_pid,
        "excluded_ancestor_pids": list(ancestors),
        "excluded_ancestor_count": len(ancestors),
        "excluded_pids": list(excluded),
        "excluded_pid_count": len(excluded),
        "method": (
            "bounded cycle-safe /proc/<pid>/stat ppid walk from harness pid; "
            "exclude harness + ancestors only; malformed/missing ppid stops walk"
        ),
    }


def list_candidate_confounder_pids(
    *,
    exclusion: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    proc = Path("/proc")
    if not proc.is_dir():
        return found
    excl = exclusion if exclusion is not None else harness_exclusion_set()
    excluded_pids = {int(p) for p in excl.get("excluded_pids") or []}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in excluded_pids:
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
        if HARNESS_NAME in cmdline or HARNESS_NAME in comm:
            continue
        hits = confounder_candidate_hits(comm, exe, cmdline)
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


def read_swap_used_mib_informational() -> float | None:
    try:
        meminfo = Path("/proc/meminfo").read_text(encoding="utf-8")
        total = free = None
        for line in meminfo.splitlines():
            if line.startswith("SwapTotal:"):
                total = int(line.split()[1])
            elif line.startswith("SwapFree:"):
                free = int(line.split()[1])
        if total is not None and free is not None:
            return (total - free) / 1024.0
    except (OSError, ValueError, IndexError):
        return None
    return None


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
    post: load averages informational only (campaign CPU); still enforce active
          external confounder CPU ticks and swap I/O.
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
            "active confounder CPU tick deltas; swap I/O rate threshold"
        )
    else:
        method = (
            "post: historical load averages informational only (include campaign CPU); "
            "still enforce active external confounder CPU tick deltas and swap I/O rate threshold"
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


def host_contention(*, phase: str = "pre") -> dict[str, Any]:
    """Sample load, external confounder CPU, and swap I/O for one pre/post moment."""
    load1, load5, load15 = os.getloadavg()
    cpus = max(int(os.cpu_count() or 1), 1)
    exclusion = harness_exclusion_set()
    candidates = list_candidate_confounder_pids(exclusion=exclusion)
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
        assessed = swap_io_assessment(
            pin_delta, pout_delta, sample_seconds=ACTIVITY_SAMPLE_SECONDS
        )
        swap_io = {"available": True, **assessed}
    else:
        assessed = swap_io_assessment(0, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
        swap_io = {"available": False, **assessed}
    classified = classify_host_contention(
        phase=phase,
        load1=load1,
        load5=load5,
        cpus=cpus,
        active_confounder_count=len(active_confounders),
        swap_io_active=bool(swap_io.get("active")),
    )
    swap_used_mib = read_swap_used_mib_informational()
    reason = classified["reason"]
    if swap_io.get("active") and "swap_io_active" in reason:
        reason = reason.replace(
            "swap_io_active",
            "swap_io_active "
            f"pswpin_delta={swap_io['pswpin_delta']} "
            f"pswpout_delta={swap_io['pswpout_delta']} "
            f"pages_per_sec={swap_io['pages_per_sec']:.2f} "
            f"threshold={swap_io['threshold_pages_per_sec']:g}",
            1,
        )
    informational = list(classified["informational"])
    if swap_io.get("informational_below_threshold"):
        informational.append(
            "swap_io_below_threshold "
            f"combined_pages_delta={swap_io.get('combined_pages_delta', 0)} "
            f"pages_per_sec={float(swap_io.get('pages_per_sec') or 0.0):.2f} "
            f"threshold={float(swap_io.get('threshold_pages_per_sec') or 0.0):g}"
        )
    if not classified["contended"] and informational:
        reason = "no_enforced_contention_signals; " + "; ".join(informational)
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
        "informational": informational,
        "activity_sample_seconds": ACTIVITY_SAMPLE_SECONDS,
        "min_active_cpu_tick_delta": MIN_ACTIVE_CPU_TICK_DELTA,
        "swap_used_mib_informational": swap_used_mib,
        "swap_io": swap_io,
        "active_build_confounders": active_confounders,
        "candidate_confounder_count": len(candidates),
        "harness_pid": exclusion["harness_pid"],
        "excluded_ancestor_pids": exclusion["excluded_ancestor_pids"],
        "excluded_ancestor_count": exclusion["excluded_ancestor_count"],
        "excluded_pid_count": exclusion["excluded_pid_count"],
        "ancestor_exclusion_method": exclusion["method"],
        "confounder_match_method": (
            "direct build/browser exe identity; node/nodejs only with recognized "
            "build/preview/test tool markers in comm/cmdline; bare pi/node is not a hit; "
            "active CPU tick delta still required"
        ),
        "contended": classified["contended"],
        "reason": reason,
        "method": classified["method"],
        "reasons": [reason] if classified["contended"] else [],
    }


def git_dirty(repo_root: Path = REPO_ROOT) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo_root), "status", "--porcelain"],
        text=True,
        capture_output=True,
        check=False,
    )
    return bool((result.stdout or "").strip())


def git_commit(repo_root: Path = REPO_ROOT) -> str:
    return run(["git", "-C", str(repo_root), "rev-parse", "HEAD"]).stdout.strip()


def acceptance_decision(
    *,
    quick: bool,
    idle_host_confirmed: bool,
    dirty_at_start: bool,
    dirty_after_measurements: bool,
    host_contended: bool,
    gate_passed: bool,
) -> dict[str, Any]:
    """Pure acceptance eligibility. Evidence-file write is outside this decision."""
    blockers: list[str] = []
    if quick:
        blockers.append("quick mode")
    if not idle_host_confirmed:
        blockers.append("idle host not explicitly confirmed")
    if dirty_at_start:
        blockers.append("dirty worktree at campaign start")
    if dirty_after_measurements:
        blockers.append("dirty worktree after measurements")
    if host_contended:
        blockers.append("host contention")
    if not gate_passed:
        blockers.append("budget failure")
    if quick:
        evidence_status = "preliminary_quick"
    elif dirty_at_start or dirty_after_measurements or host_contended:
        evidence_status = "preliminary_contended_or_dirty_host"
    elif not idle_host_confirmed:
        evidence_status = "preliminary_idle_host_not_confirmed"
    elif not gate_passed:
        evidence_status = "preliminary_budget_failure"
    else:
        evidence_status = "authoritative_candidate"
    return {
        "accepted": not blockers,
        "acceptance_blockers": blockers,
        "evidence_status": evidence_status,
    }


def protocol(quick: bool) -> dict[str, Any]:
    return {
        "name": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "quick": quick,
        "authoritative_candidate": not quick,
        "samples_per_side": QUICK_SAMPLES if quick else SAMPLES,
        "interleave": "feature_off_then_default_per_sample",
        "workload": "junban-phase1-hosted-server-v1 exact",
        "warm_ceiling_mib": WARM_CEILING_MIB,
        "peak_ceiling_mib": PEAK_CEILING_MIB,
        "matched_delta": "default median - feature-off median <= max(15%, 1 MiB)",
        "phase6_delta": "default median - 8.3711 MiB <= 1.255665 MiB",
        "host_contention_policy": {
            "load1_busy_per_cpu": LOAD1_BUSY_PER_CPU,
            "load5_busy_per_cpu": LOAD5_BUSY_PER_CPU,
            "load_floor": LOAD_FLOOR,
            "activity_sample_seconds": ACTIVITY_SAMPLE_SECONDS,
            "min_active_cpu_tick_delta": MIN_ACTIVE_CPU_TICK_DELTA,
            "swap_active_pages_per_sec": SWAP_ACTIVE_PAGES_PER_SEC,
            "swap_page_bytes_assumed": SWAP_PAGE_BYTES,
            "pre_enforces_historical_load": True,
            "post_historical_load_informational_only": True,
            "static_swap_informational_only": True,
            "evidence_write_does_not_dirty_eligibility": True,
        },
    }


def self_check() -> None:
    bench = load_bench()
    bench.self_check_protocol()
    assert protocol(False)["samples_per_side"] == 5
    assert protocol(True)["samples_per_side"] == 1
    baseline = {"warm_cgroup_mib": {"median": 8.0}, "process_counts": [1], "cleanup_passed": True}
    baseline["warm_cgroup_mib"]["max"] = 8.0
    baseline["warm_cgroup_peak_mib"] = {"max": 9.0}
    linked = {
        "warm_cgroup_mib": {"median": 8.5, "max": 8.7},
        "warm_cgroup_peak_mib": {"max": 9.2},
        "process_counts": [1],
        "cleanup_passed": True,
    }
    assert evaluate(baseline, linked)["passed"]
    linked["warm_cgroup_mib"]["median"] = 10.0
    assert not evaluate(baseline, linked)["passed"]
    assert SDK_MARKER.startswith(b"JUNBAN_PLUGIN_SDK")
    assert len(SDK_ENTRYPOINT_MARKERS) == 10

    # Pure load thresholds: below / equal / above (strict >).
    thr20 = load_thresholds(20)
    assert thr20["load1_threshold"] == 10.0
    assert thr20["load5_threshold"] == 6.0
    # Phase-6-class idle load5≈3.28 on ~20 CPUs must not contend.
    assert load_contention_reasons(3.28, 3.28, 20) == []
    assert load_contention_reasons(thr20["load1_threshold"], thr20["load5_threshold"], 20) == []
    assert load_contention_reasons(thr20["load1_threshold"] + 0.01, 0.0, 20)
    assert load_contention_reasons(0.0, thr20["load5_threshold"] + 0.01, 20)
    assert load_contention_reasons(20.0, 20.0, 20)
    thr1 = load_thresholds(1)
    assert thr1["load1_threshold"] == LOAD_FLOOR
    assert thr1["load5_threshold"] == LOAD_FLOOR

    # Existence vs active CPU.
    assert not process_is_cpu_active(0)
    assert not process_is_cpu_active(MIN_ACTIVE_CPU_TICK_DELTA - 1)
    assert process_is_cpu_active(MIN_ACTIVE_CPU_TICK_DELTA)
    assert process_is_cpu_active(MIN_ACTIVE_CPU_TICK_DELTA + 5)

    # Swap I/O rate: below / equal / above; static allocation never contends.
    assert not swap_io_is_active(0, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    assert not swap_io_is_active(22, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    below = swap_io_assessment(22, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    assert below["active"] is False and below["informational_below_threshold"] is True
    equal_pages = int(SWAP_ACTIVE_PAGES_PER_SEC * ACTIVITY_SAMPLE_SECONDS)
    assert equal_pages >= 1
    assert swap_io_is_active(equal_pages, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    equal = swap_io_assessment(equal_pages, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    assert equal["active"] is True and equal["informational_below_threshold"] is False
    assert swap_io_is_active(equal_pages + 1, 0, sample_seconds=ACTIVITY_SAMPLE_SECONDS)
    half = max(1, equal_pages // 2)
    rest = equal_pages - half
    assert swap_io_is_active(half, rest, sample_seconds=ACTIVITY_SAMPLE_SECONDS)

    # Post-run historical load alone is informational; active/swap still block.
    post_high_load = classify_host_contention(
        phase="post",
        load1=20.0,
        load5=20.0,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=False,
    )
    assert post_high_load["contended"] is False
    assert post_high_load["load_thresholds_enforced"] is False
    assert post_high_load["informational"]
    post_active = classify_host_contention(
        phase="post",
        load1=0.1,
        load5=0.1,
        cpus=20,
        active_confounder_count=2,
        swap_io_active=False,
    )
    assert post_active["contended"] is True
    post_swap = classify_host_contention(
        phase="post",
        load1=0.1,
        load5=0.1,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=True,
    )
    assert post_swap["contended"] is True
    pre_high_load = classify_host_contention(
        phase="pre",
        load1=20.0,
        load5=20.0,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=False,
    )
    assert pre_high_load["contended"] is True
    assert pre_high_load["load_thresholds_enforced"] is True
    pre_idle = classify_host_contention(
        phase="pre",
        load1=0.1,
        load5=0.1,
        cpus=20,
        active_confounder_count=0,
        swap_io_active=False,
    )
    assert pre_idle["contended"] is False

    # Confounder candidacy: bare node vs build/browser activity markers.
    assert not is_confounder_candidate(
        "node", "node", "/usr/bin/node /home/x/.pi/agent/dist/index.js"
    )
    assert not is_confounder_candidate("node", "nodejs", "node /opt/pi/run --session abc")
    assert is_confounder_candidate(
        "node", "node", "node /proj/node_modules/.bin/tsc -p tsconfig.json"
    )
    assert is_confounder_candidate("node", "node", "node ./node_modules/vite/bin/vite.js")
    assert is_confounder_candidate("pnpm", "pnpm", "pnpm run build")
    assert is_confounder_candidate("cargo", "cargo", "cargo build --release")
    assert is_confounder_candidate("rustc", "rustc", "rustc --crate-type lib")
    assert is_confounder_candidate("chrome", "google-chrome", "/usr/bin/google-chrome")
    assert not is_confounder_candidate("python3", "python3", "python3 scripts/build_helpers.py")
    assert not is_confounder_candidate("node", "node", "node ./scripts/build.js")

    # Ancestor walk fixtures.
    assert parse_ppid_from_stat("123 (bash) S 1 123 123 0 -1") == 1
    assert parse_ppid_from_stat("9 (a b) S 42 9 9 0 -1") == 42
    assert parse_ppid_from_stat("") is None
    tree = {100: 50, 50: 10, 10: 1, 200: 200}

    def ppid_of(pid: int) -> int | None:
        return tree.get(int(pid))

    assert walk_ancestor_pids(100, ppid_of, max_depth=64) == [50, 10]
    assert walk_ancestor_pids(999, ppid_of, max_depth=64) == []
    assert walk_ancestor_pids(200, ppid_of, max_depth=64) == []

    # Dirty start / dirty end acceptance blockers; evidence write is external.
    clean_ok = acceptance_decision(
        quick=False,
        idle_host_confirmed=True,
        dirty_at_start=False,
        dirty_after_measurements=False,
        host_contended=False,
        gate_passed=True,
    )
    assert clean_ok["accepted"] is True
    assert clean_ok["evidence_status"] == "authoritative_candidate"
    assert clean_ok["acceptance_blockers"] == []

    dirty_start = acceptance_decision(
        quick=False,
        idle_host_confirmed=True,
        dirty_at_start=True,
        dirty_after_measurements=False,
        host_contended=False,
        gate_passed=True,
    )
    assert dirty_start["accepted"] is False
    assert "dirty worktree at campaign start" in dirty_start["acceptance_blockers"]

    dirty_end = acceptance_decision(
        quick=False,
        idle_host_confirmed=True,
        dirty_at_start=False,
        dirty_after_measurements=True,
        host_contended=False,
        gate_passed=True,
    )
    assert dirty_end["accepted"] is False
    assert "dirty worktree after measurements" in dirty_end["acceptance_blockers"]

    # Evidence file written after the dirty-after-measurements snapshot must not
    # retroactively change the already-computed eligibility decision.
    eligibility_before_write = acceptance_decision(
        quick=False,
        idle_host_confirmed=True,
        dirty_at_start=False,
        dirty_after_measurements=False,
        host_contended=False,
        gate_passed=True,
    )
    # Simulating "output path now exists in the worktree" after decision.
    eligibility_after_unrelated_dirt = dict(eligibility_before_write)
    assert eligibility_after_unrelated_dirt["accepted"] is True

    contended = acceptance_decision(
        quick=False,
        idle_host_confirmed=True,
        dirty_at_start=False,
        dirty_after_measurements=False,
        host_contended=True,
        gate_passed=True,
    )
    assert contended["accepted"] is False
    assert "host contention" in contended["acceptance_blockers"]

    quick = acceptance_decision(
        quick=True,
        idle_host_confirmed=True,
        dirty_at_start=False,
        dirty_after_measurements=False,
        host_contended=False,
        gate_passed=True,
    )
    assert quick["accepted"] is False
    assert quick["evidence_status"] == "preliminary_quick"

    no_idle = acceptance_decision(
        quick=False,
        idle_host_confirmed=False,
        dirty_at_start=False,
        dirty_after_measurements=False,
        host_contended=False,
        gate_passed=True,
    )
    assert no_idle["accepted"] is False
    assert "idle host not explicitly confirmed" in no_idle["acceptance_blockers"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--idle-host-confirmed", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--target-root", type=Path, default=DEFAULT_TARGET_ROOT)
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    args = parser.parse_args(argv)
    if args.self_check:
        self_check()
        print("phase7 SDK matched-release self-check passed")
        return 0

    web_dir = (REPO_ROOT / args.web_dir).resolve() if not args.web_dir.is_absolute() else args.web_dir
    if not (web_dir / "index.html").is_file():
        raise HarnessError(f"production web directory missing index.html: {web_dir}")

    # Capture git cleanliness at campaign start before any measurement side effects.
    dirty_at_start = git_dirty(REPO_ROOT)
    commit = git_commit(REPO_ROOT)
    host_pre = host_contention(phase="pre")

    target_root = (REPO_ROOT / args.target_root).resolve() if not args.target_root.is_absolute() else args.target_root
    feature_off_binary = build_server(target_root / "feature-off", sdk=False)
    default_binary = build_server(target_root / "default", sdk=True)
    linkage = {
        "feature_off_binary": inspect_binary(feature_off_binary, sdk_expected=False),
        "default_binary": inspect_binary(default_binary, sdk_expected=True),
        "feature_off_tree": inspect_tree(sdk=False),
        "default_tree": inspect_tree(sdk=True),
    }
    bench = load_bench()
    phase1 = bench.protocol_config(args.quick)
    count = QUICK_SAMPLES if args.quick else SAMPLES
    feature_off_samples: list[dict[str, Any]] = []
    default_samples: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="junban-p7-sdk-") as temporary:
        work = Path(temporary)
        for index in range(count):
            feature_off_samples.append(
                bench.run_sample(
                    index, f"p7off{index}", REPO_ROOT, feature_off_binary, web_dir, work / "off", phase1
                )
            )
            default_samples.append(
                bench.run_sample(
                    index, f"p7sdk{index}", REPO_ROOT, default_binary, web_dir, work / "sdk", phase1
                )
            )
    feature_off_summary = summarize(feature_off_samples, bench)
    default_summary = summarize(default_samples, bench)
    gate = evaluate(feature_off_summary, default_summary)
    host_post = host_contention(phase="post")
    host_contended = bool(host_pre["contended"] or host_post["contended"])
    host_reasons = [
        f"{moment}: {snapshot['reason']}"
        for moment, snapshot in (("pre", host_pre), ("post", host_post))
        if snapshot.get("contended")
    ]

    # Dirty-after-measurements is recorded before writing the evidence file so the
    # output path itself cannot retroactively dirty eligibility.
    dirty_after_measurements = git_dirty(REPO_ROOT)
    decision = acceptance_decision(
        quick=bool(args.quick),
        idle_host_confirmed=bool(args.idle_host_confirmed),
        dirty_at_start=dirty_at_start,
        dirty_after_measurements=dirty_after_measurements,
        host_contended=host_contended,
        gate_passed=bool(gate["passed"]),
    )
    report = {
        "protocol": protocol(args.quick),
        "evidence_status": decision["evidence_status"],
        "accepted": decision["accepted"],
        "acceptance_blockers": decision["acceptance_blockers"],
        "git": {
            "commit": commit,
            "dirty_at_start": dirty_at_start,
            "dirty_after_measurements": dirty_after_measurements,
            # Compatibility: any pre-write dirt blocks authoritative acceptance.
            "dirty": bool(dirty_at_start or dirty_after_measurements),
            "evidence_write_excluded_from_dirty_gate": True,
        },
        "host_cleanliness": {
            "pre": host_pre,
            "post": host_post,
            "contended": host_contended,
            "reasons": host_reasons,
        },
        "artifacts": {
            "feature_off": binary_metadata(feature_off_binary),
            "default": binary_metadata(default_binary),
        },
        "linkage": linkage,
        "feature_off": {"summary": feature_off_summary, "samples": feature_off_samples},
        "default": {"summary": default_summary, "samples": default_samples},
        "gate": gate,
    }
    output = (REPO_ROOT / args.output).resolve() if not args.output.is_absolute() else args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {output}")
    return 0 if gate["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
