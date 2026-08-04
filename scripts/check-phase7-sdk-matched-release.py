#!/usr/bin/env python3
"""Matched optimized Phase 7 SDK-linkage release harness.

Builds feature-off and default junban-server binaries into separate target
roots, proves the SDK marker is present only in default and Wasmtime is absent
from both, then runs interleaved frozen Phase 1 workloads through the shared
cgroup-v2 benchmark implementation. This script never constructs a plugin
runtime and cannot approve evidence produced from a dirty worktree.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
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


def host_snapshot() -> dict[str, Any]:
    load = os.getloadavg() if hasattr(os, "getloadavg") else (None, None, None)
    memory: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            first = value.strip().split()[0]
            if first.isdigit():
                memory[key] = int(first) * 1024
    except (OSError, ValueError, IndexError):
        pass
    cpu_count = os.cpu_count() or 1
    reasons = []
    if isinstance(load[0], float) and load[0] > cpu_count * 0.75:
        reasons.append("loadavg_1m exceeds 0.75 per CPU")
    if memory.get("MemAvailable", 2**63) < 2 * 1024**3:
        reasons.append("available memory below 2 GiB")
    swap_total = memory.get("SwapTotal", 0)
    swap_free = memory.get("SwapFree", swap_total)
    if swap_total > 0 and swap_free < swap_total * 0.35:
        reasons.append("swap heavily used (less than 35% free)")
    return {
        "cpu_count": cpu_count,
        "loadavg": load,
        "mem_available_bytes": memory.get("MemAvailable"),
        "swap_total_bytes": memory.get("SwapTotal"),
        "swap_free_bytes": memory.get("SwapFree"),
        "contended": bool(reasons),
        "reasons": reasons,
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
    }


def self_check() -> None:
    bench = load_bench()
    bench.self_check_protocol()
    assert protocol(False)["samples_per_side"] == 5
    assert protocol(True)["samples_per_side"] == 1
    baseline = {"warm_cgroup_mib": {"median": 8.0}, "process_counts": [1], "cleanup_passed": True}
    baseline["warm_cgroup_mib"]["max"] = 8.0
    baseline["warm_cgroup_peak_mib"] = {"max": 9.0}
    linked = {"warm_cgroup_mib": {"median": 8.5, "max": 8.7}, "warm_cgroup_peak_mib": {"max": 9.2}, "process_counts": [1], "cleanup_passed": True}
    assert evaluate(baseline, linked)["passed"]
    linked["warm_cgroup_mib"]["median"] = 10.0
    assert not evaluate(baseline, linked)["passed"]
    assert SDK_MARKER.startswith(b"JUNBAN_PLUGIN_SDK")
    assert len(SDK_ENTRYPOINT_MARKERS) == 10


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
    host_before = host_snapshot()
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
            feature_off_samples.append(bench.run_sample(index, f"p7off{index}", REPO_ROOT, feature_off_binary, web_dir, work / "off", phase1))
            default_samples.append(bench.run_sample(index, f"p7sdk{index}", REPO_ROOT, default_binary, web_dir, work / "sdk", phase1))
    feature_off_summary = summarize(feature_off_samples, bench)
    default_summary = summarize(default_samples, bench)
    gate = evaluate(feature_off_summary, default_summary)
    host_after = host_snapshot()
    host = {
        "before": host_before,
        "after": host_after,
        "contended": bool(host_before["contended"] or host_after["contended"]),
        "reasons": [
            f"{moment}: {reason}"
            for moment, snapshot in (("before", host_before), ("after", host_after))
            for reason in snapshot["reasons"]
        ],
    }
    dirty = bool(run(["git", "status", "--porcelain"]).stdout.strip())
    evidence_status = "preliminary_quick" if args.quick else "authoritative_candidate"
    accepted = bool(not args.quick and args.idle_host_confirmed and not dirty and not host["contended"] and gate["passed"])
    report = {
        "protocol": protocol(args.quick),
        "evidence_status": evidence_status,
        "accepted": accepted,
        "acceptance_blockers": [reason for reason, blocked in (("quick mode", args.quick), ("idle host not explicitly confirmed", not args.idle_host_confirmed), ("dirty worktree", dirty), ("host contention", host["contended"]), ("budget failure", not gate["passed"])) if blocked],
        "git": {"commit": run(["git", "rev-parse", "HEAD"]).stdout.strip(), "dirty": dirty},
        "host_cleanliness": host,
        "artifacts": {"feature_off": binary_metadata(feature_off_binary), "default": binary_metadata(default_binary)},
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
