#!/usr/bin/env python3
"""Adjudicated Linux cgroup-v2 calibration for Phase 7 Slice 2E."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEST_NAME = "plugin_runtime::slice2e_tests::phase7_slice2e_linux_cgroup_calibration_probe"
READY_PREFIX = "SLICE2E_CALIBRATION_READY="
RUST_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/rust/rust-consumer.wasm"
TYPESCRIPT_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-consumer.wasm"
TYPESCRIPT_STANDALONE_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-standalone-calibration.wasm"
CONFORMANCE_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/slice2e-rust/slice2e-consumer.wasm"
MATCHED_RELEASE_EVIDENCE = ROOT / "goals/rust-rewrite/evidence/phase-7-sdk-matched-release.json"
MATCHED_RELEASE_COMMIT = "5d05eacbdfd9298eefc16c5b69f730cd2f05494e"
MATCHED_RELEASE_SHA256 = "233083ba924258e4b9d3863367ad2a6a3a6c12b663e2169ebf27007edbde9f78"
MATCHED_DEFAULT_CURRENT_MAX = 9_994_240
MATCHED_DEFAULT_PEAK_MAX = 10_047_488
WASMTIME_VERSION = "36.0.13"
SAMPLES = 5
CASES = [
    ("baseline", 0, 0),
    ("rust", 1, 0),
    ("rust", 4, 0),
    ("rust", 16, 0),
    ("typescript", 1, 0),
    ("typescript", 4, 1),
    ("typescript", 16, 1),
]
MIB = 1024 * 1024
FORMULA_CURRENT = (
    "matched_default_release_current_max + "
    "max(0, active_scale1_current_max - same_run_harness_baseline_current_max)"
)
FORMULA_PEAK = (
    "matched_default_release_peak_max + "
    "max(0, active_scale1_peak_max - same_run_harness_baseline_peak_max)"
)
RELEASE_COMMAND = [
    "cargo",
    "test",
    "--release",
    "-p",
    "junban-server",
    TEST_NAME,
    "--locked",
    "--",
    "--ignored",
    "--exact",
    "--nocapture",
    "--test-threads=1",
]


def budget_bytes(mib: str) -> int:
    """A decimal MiB ceiling admits only whole bytes at or below that ceiling."""
    return int(Decimal(mib) * MIB)


BUDGETS = {
    "raw_harness_baseline": {
        "memory_current_bytes": 24 * MIB,
        "memory_peak_bytes": 32 * MIB,
    },
    "normalized_rust_scale1": {
        "memory_current_bytes": budget_bytes("18.6016"),
        "memory_peak_bytes": budget_bytes("19.5078"),
    },
    "normalized_typescript_standalone_scale1": {
        "memory_current_bytes": budget_bytes("357.334"),
        "memory_peak_bytes": budget_bytes("415.6201"),
    },
}


class CalibrationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise CalibrationError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def run(args: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=capture)
    return result.stdout if capture else ""


def regular(path: Path, label: str) -> Path:
    candidate = path if path.is_absolute() else ROOT / path
    if candidate.is_symlink():
        fail(f"{label} must not be a symlink")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_file():
        fail(f"{label} must be a regular file")
    return resolved


def target_directory() -> Path:
    metadata = json.loads(
        run(["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"], capture=True)
    )
    target = metadata.get("target_directory")
    if not isinstance(target, str):
        fail("cargo metadata omitted target_directory")
    return Path(target)


def release_host(selected: Path | None) -> Path:
    if selected is not None:
        return regular(selected, "selected plugin host")
    run(["cargo", "build", "-p", "junban-plugin-host", "--release", "--locked"])
    return regular(target_directory() / "release/junban-plugin-host", "built plugin host")


def current_cgroup() -> Path:
    delegated = os.environ.get("JUNBAN_SLICE2E_CGROUP_PARENT")
    if delegated:
        path = Path(delegated).resolve(strict=True)
    else:
        unified = None
        for line in Path("/proc/self/cgroup").read_text(encoding="utf-8").splitlines():
            if line.startswith("0::"):
                unified = line.split("::", 1)[1]
                break
        if unified is None:
            fail("unified cgroup-v2 membership is unavailable")
        path = Path("/sys/fs/cgroup") / unified.lstrip("/")
    if not (path / "memory.current").is_file():
        fail(f"memory controller is unavailable in calibration cgroup: {path}")
    probe = path / f"junban-slice2e-probe-{os.getpid()}"
    try:
        probe.mkdir()
        if not (probe / "memory.current").is_file() or not (probe / "memory.peak").is_file():
            fail("delegated calibration cgroup lacks memory.current or memory.peak")
    except PermissionError:
        fail(
            "cgroup-v2 delegation is unavailable; set JUNBAN_SLICE2E_CGROUP_PARENT "
            "to a writable delegated cgroup"
        )
    finally:
        if probe.exists():
            probe.rmdir()
    return path


def read_u64(path: Path) -> int:
    value = path.read_text(encoding="ascii").strip()
    if not value.isdigit():
        fail(f"invalid cgroup metric at {path}: {value!r}")
    return int(value)


def optional_zero_metric(path: Path) -> int | None:
    if not path.is_file():
        return None
    value = read_u64(path)
    if value != 0:
        fail(f"calibration requires zero swap at {path}, got {value}")
    return value


def graph_metadata(profile: str, scale: int) -> tuple[int, int]:
    graph_size = 0 if profile == "baseline" else scale
    support_plugins = int(profile == "typescript" and scale > 1)
    return graph_size, support_plugins


def measure_case(
    parent: Path,
    host: Path,
    profile: str,
    scale: int,
    sequence: int,
) -> dict[str, Any]:
    group = parent / f"junban-slice2e-{os.getpid()}-{profile}-{scale}-{sequence}"
    group.mkdir()
    graph_size, support_plugins = graph_metadata(profile, scale)
    environment = os.environ.copy()
    environment.update(
        {
            "JUNBAN_SLICE2E_RUN": "1",
            "JUNBAN_SLICE2E_CALIBRATION": "1",
            "JUNBAN_SLICE2E_CALIBRATION_PROFILE": profile,
            "JUNBAN_SLICE2E_CALIBRATION_SCALE": str(scale),
            "JUNBAN_SLICE2E_HOST": str(host),
            "JUNBAN_SLICE2E_RUST_COMPONENT": str(RUST_ARTIFACT.resolve(strict=True)),
            "JUNBAN_SLICE2E_TYPESCRIPT_COMPONENT": str(TYPESCRIPT_ARTIFACT.resolve(strict=True)),
            "JUNBAN_SLICE2E_TYPESCRIPT_STANDALONE_COMPONENT": str(
                TYPESCRIPT_STANDALONE_ARTIFACT.resolve(strict=True)
            ),
            "JUNBAN_SLICE2E_CONFORMANCE_COMPONENT": str(CONFORMANCE_ARTIFACT.resolve(strict=True)),
        }
    )
    process = subprocess.Popen(
        ["bash", "-c", 'kill -STOP "$$"; exec "$@"', "slice2e-calibration", *RELEASE_COMMAND],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    sample: dict[str, Any] | None = None
    try:
        (group / "cgroup.procs").write_text(f"{process.pid}\n", encoding="ascii")
        started = time.monotonic_ns()
        os.kill(process.pid, signal.SIGCONT)
        assert process.stdout is not None
        marker: dict[str, Any] | None = None
        for line in process.stdout:
            sys.stdout.write(line)
            if line.startswith(READY_PREFIX):
                try:
                    decoded = json.loads(line.removeprefix(READY_PREFIX))
                except json.JSONDecodeError as error:
                    fail(f"malformed calibration ready marker: {error}")
                if not isinstance(decoded, dict):
                    fail("calibration ready marker must be an object")
                marker = decoded
                break
        if marker is None:
            return_code = process.wait()
            fail(f"calibration probe exited {return_code} before its ready marker")
        ready_elapsed_ms = (time.monotonic_ns() - started) // 1_000_000
        expected_marker = {
            "profile": profile,
            "scale": scale,
            "graph_size": graph_size,
            "support_plugins": support_plugins,
        }
        if marker != expected_marker:
            fail(f"calibration ready marker drifted: {marker}")
        current = read_u64(group / "memory.current")
        peak = read_u64(group / "memory.peak")
        if peak < current or current == 0:
            fail("invalid cgroup-v2 calibration measurements")
        swap_current = optional_zero_metric(group / "memory.swap.current")
        swap_peak = optional_zero_metric(group / "memory.swap.peak")
        assert process.stdin is not None
        process.stdin.write("release\n")
        process.stdin.flush()
        process.stdin.close()
        for line in process.stdout:
            sys.stdout.write(line)
        return_code = process.wait()
        if return_code != 0:
            fail(f"calibration probe failed with exit code {return_code}")
        event_values = dict(
            line.split(maxsplit=1)
            for line in (group / "cgroup.events").read_text(encoding="ascii").splitlines()
            if " " in line
        )
        populated_zero = event_values.get("populated") == "0"
        if not populated_zero:
            fail("calibration cgroup retained a live process after shutdown")
        sample = {
            "sequence": sequence,
            "memory_current_bytes": current,
            "memory_peak_bytes": peak,
            "memory_swap_current_bytes": swap_current,
            "memory_swap_peak_bytes": swap_peak,
            "ready_elapsed_ms": ready_elapsed_ms,
            "ready_marker": marker,
            "populated_zero": populated_zero,
            "cgroup_deleted": False,
        }
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        try:
            group.rmdir()
        except OSError as error:
            fail(f"failed to remove calibration cgroup {group}: {error}")
        if sample is not None:
            sample["cgroup_deleted"] = not group.exists()
    if sample is None:
        fail("calibration sample did not complete")
    return sample


def git_provenance() -> dict[str, Any]:
    commit = run(["git", "rev-parse", "HEAD"], capture=True).strip()
    if re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        fail("git HEAD is not an exact 40-hex commit")
    clean = run(["git", "status", "--porcelain=v1", "--untracked-files=all"], capture=True) == ""
    github_sha = os.environ.get("GITHUB_SHA")
    if github_sha is not None and re.fullmatch(r"[0-9a-f]{40}", github_sha) is None:
        fail("GITHUB_SHA is not exact lowercase 40-hex")
    return {
        "commit": commit,
        "clean_at_start": clean,
        "github_sha": github_sha,
        "github_run_id": os.environ.get("GITHUB_RUN_ID"),
        "github_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
    }


def host_snapshot(*, enforce: bool) -> dict[str, Any]:
    cpu_count = os.cpu_count() or 1
    load1, load5, load15 = os.getloadavg()
    load1_threshold = max(1.0, cpu_count * 0.5)
    load5_threshold = max(1.0, cpu_count * 0.3)
    passed = not enforce or (load1 <= load1_threshold and load5 <= load5_threshold)
    return {
        "cpu_count": cpu_count,
        "load1": load1,
        "load5": load5,
        "load15": load15,
        "load1_threshold": load1_threshold,
        "load5_threshold": load5_threshold,
        "thresholds_enforced": enforce,
        "passed": passed,
    }


def rust_provenance() -> dict[str, str]:
    verbose = run(["rustc", "-Vv"], capture=True).strip()
    host = next((line.removeprefix("host: ") for line in verbose.splitlines() if line.startswith("host: ")), None)
    if host is None:
        fail("rustc -Vv omitted the host target")
    return {"verbose_version": verbose, "host_target": host}


def matched_release_authority() -> dict[str, Any]:
    source_sha256 = digest(MATCHED_RELEASE_EVIDENCE)
    if source_sha256 != MATCHED_RELEASE_SHA256:
        fail("matched default release evidence bytes drifted")
    source = json.loads(MATCHED_RELEASE_EVIDENCE.read_text(encoding="utf-8"))
    git = source.get("git")
    samples = source.get("default", {}).get("samples")
    if (
        source.get("accepted") is not True
        or source.get("acceptance_blockers") != []
        or source.get("gate", {}).get("passed") is not True
        or not isinstance(git, dict)
        or git.get("commit") != MATCHED_RELEASE_COMMIT
        or git.get("dirty") is not False
        or git.get("dirty_at_start") is not False
        or git.get("dirty_after_measurements") is not False
        or not isinstance(samples, list)
        or len(samples) != 5
    ):
        fail("matched default release authority is not the accepted clean five-sample campaign")
    try:
        current = max(int(sample["warm"]["cgroup_current_bytes"]) for sample in samples)
        peak = max(int(sample["warm"]["cgroup_peak_bytes"]) for sample in samples)
    except (KeyError, TypeError, ValueError) as error:
        fail(f"matched default release raw samples are malformed: {error}")
    if current != MATCHED_DEFAULT_CURRENT_MAX or peak != MATCHED_DEFAULT_PEAK_MAX:
        fail("matched default release maxima drifted from 9.5312/9.5820 MiB authority")
    return {
        "path": MATCHED_RELEASE_EVIDENCE.relative_to(ROOT).as_posix(),
        "sha256": source_sha256,
        "accepted_commit": MATCHED_RELEASE_COMMIT,
        "default_release_max": {
            "memory_current_bytes": current,
            "memory_peak_bytes": peak,
        },
    }


def artifact_record(path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    try:
        rendered = resolved.relative_to(ROOT).as_posix()
    except ValueError:
        rendered = str(resolved)
    return {"path": rendered, "sha256": digest(resolved), "size_bytes": resolved.stat().st_size}


def derived(samples: list[dict[str, Any]]) -> dict[str, int]:
    currents = sorted(sample["memory_current_bytes"] for sample in samples)
    peaks = sorted(sample["memory_peak_bytes"] for sample in samples)
    return {
        "memory_current_max_bytes": currents[-1],
        "memory_current_median_bytes": currents[len(currents) // 2],
        "memory_peak_max_bytes": peaks[-1],
        "memory_peak_median_bytes": peaks[len(peaks) // 2],
    }


def adjudicate(cases: list[dict[str, Any]], matched: dict[str, Any]) -> dict[str, Any]:
    indexed = {(case["profile"], case["plugin_scale"]): case for case in cases}
    baseline = indexed[("baseline", 0)]["derived"]
    matched_max = matched["default_release_max"]

    def normalized(profile: str, budget_name: str) -> dict[str, Any]:
        active = indexed[(profile, 1)]["derived"]
        current_delta = max(
            0,
            active["memory_current_max_bytes"] - baseline["memory_current_max_bytes"],
        )
        peak_delta = max(0, active["memory_peak_max_bytes"] - baseline["memory_peak_max_bytes"])
        current = matched_max["memory_current_bytes"] + current_delta
        peak = matched_max["memory_peak_bytes"] + peak_delta
        budget = BUDGETS[budget_name]
        return {
            "memory_current": {
                "matched_default_release_max_bytes": matched_max["memory_current_bytes"],
                "active_scale1_max_bytes": active["memory_current_max_bytes"],
                "same_run_harness_baseline_max_bytes": baseline["memory_current_max_bytes"],
                "nonnegative_active_delta_bytes": current_delta,
                "normalized_bytes": current,
                "budget_bytes": budget["memory_current_bytes"],
                "passed": current <= budget["memory_current_bytes"],
            },
            "memory_peak": {
                "matched_default_release_max_bytes": matched_max["memory_peak_bytes"],
                "active_scale1_max_bytes": active["memory_peak_max_bytes"],
                "same_run_harness_baseline_max_bytes": baseline["memory_peak_max_bytes"],
                "nonnegative_active_delta_bytes": peak_delta,
                "normalized_bytes": peak,
                "budget_bytes": budget["memory_peak_bytes"],
                "passed": peak <= budget["memory_peak_bytes"],
            },
        }

    rust = normalized("rust", "normalized_rust_scale1")
    typescript = normalized("typescript", "normalized_typescript_standalone_scale1")
    checks = {
        "raw_harness_baseline_current": baseline["memory_current_max_bytes"]
        <= BUDGETS["raw_harness_baseline"]["memory_current_bytes"],
        "raw_harness_baseline_peak": baseline["memory_peak_max_bytes"]
        <= BUDGETS["raw_harness_baseline"]["memory_peak_bytes"],
        "normalized_rust_scale1_current": rust["memory_current"]["passed"],
        "normalized_rust_scale1_peak": rust["memory_peak"]["passed"],
        "normalized_typescript_standalone_scale1_current": typescript["memory_current"]["passed"],
        "normalized_typescript_standalone_scale1_peak": typescript["memory_peak"]["passed"],
    }
    return {
        "formula": {"memory_current": FORMULA_CURRENT, "memory_peak": FORMULA_PEAK},
        "normalized_profiles": {
            "rust_scale1": rust,
            "typescript_standalone_scale1": typescript,
        },
        "informational_observations": [
            {"profile": profile, "plugin_scale": scale, "ceiling_bytes": None}
            for profile in ("rust", "typescript")
            for scale in (4, 16)
        ],
        "checks": checks,
        "aggregate_gate": all(checks.values()),
    }


def write_result(path: Path, result: dict[str, Any]) -> Path:
    output = path if path.is_absolute() else ROOT / path
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(output)
    return output.resolve(strict=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=Path)
    parser.add_argument("--idle-host-confirmed", action="store_true")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("target/phase7-slice2e/cgroup-memory.json"),
    )
    options = parser.parse_args()
    if platform.system() != "Linux" or not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        raise SystemExit("Slice 2E memory calibration requires Linux cgroup v2")

    git = git_provenance()
    pre = host_snapshot(enforce=True)
    result: dict[str, Any] = {
        "schema_version": 2,
        "status": "failed",
        "failure_reasons": [],
        "git": git,
        "platform": {
            "kernel_release": platform.release(),
            "platform": platform.system(),
            "machine": platform.machine(),
        },
        "rust": rust_provenance(),
        "campaign": {
            "release_profile": "release",
            "exact_command": RELEASE_COMMAND,
            "workload": "real-host-load-and-idle-ready-marker",
            "idle_host_confirmed": options.idle_host_confirmed,
        },
        "wasmtime": WASMTIME_VERSION,
        "metric": {
            "authority": "linux-cgroup-v2",
            "current_source": "per-sample-child-cgroup/memory.current at exact ready marker",
            "peak_source": "per-sample-child-cgroup/memory.peak at exact ready marker",
            "swap_source": "memory.swap.current/memory.swap.peak when exposed",
            "normalized_formula": {
                "memory_current": FORMULA_CURRENT,
                "memory_peak": FORMULA_PEAK,
            },
        },
        "samples_per_case": SAMPLES,
        "host_cleanliness": {
            "idle_host_confirmation": options.idle_host_confirmed,
            "pre": pre,
            "post": None,
        },
        "matched_release_authority": matched_release_authority(),
        "artifacts": None,
        "approved_budgets": BUDGETS,
        "cases": [],
        "adjudication": None,
    }
    preflight_reasons: list[str] = []
    if not options.idle_host_confirmed:
        preflight_reasons.append("--idle-host-confirmed is required")
    if not git["clean_at_start"]:
        preflight_reasons.append("git tree was not clean at campaign start")
    if not pre["passed"]:
        preflight_reasons.append("pre-campaign CPU-scaled load threshold exceeded")
    if preflight_reasons:
        result["failure_reasons"] = preflight_reasons
        output = write_result(options.output, result)
        print(f"failed calibration evidence written to {output}", file=sys.stderr)
        for reason in preflight_reasons:
            print(reason, file=sys.stderr)
        return 1

    try:
        run([sys.executable, str(ROOT / "scripts/check-phase7-slice2e.py")])
        host = release_host(options.host)
        run(
            [
                "cargo",
                "test",
                "--release",
                "-p",
                "junban-server",
                TEST_NAME,
                "--locked",
                "--no-run",
            ]
        )
        parent = current_cgroup()
        result["artifacts"] = {
            "host": artifact_record(host),
            "rust_component": artifact_record(RUST_ARTIFACT),
            "typescript_full_component": artifact_record(TYPESCRIPT_ARTIFACT),
            "typescript_standalone_component": artifact_record(TYPESCRIPT_STANDALONE_ARTIFACT),
            "conformance_component": artifact_record(CONFORMANCE_ARTIFACT),
        }
        records = []
        for profile, scale, support_plugins in CASES:
            print(f"Slice 2E cgroup calibration: profile={profile} scale={scale}")
            samples = [
                measure_case(parent, host, profile, scale, sequence)
                for sequence in range(1, SAMPLES + 1)
            ]
            graph_size, expected_support = graph_metadata(profile, scale)
            if support_plugins != expected_support:
                fail("calibration case support authority drifted")
            records.append(
                {
                    "profile": profile,
                    "plugin_scale": scale,
                    "graph_size": graph_size,
                    "support_plugins": support_plugins,
                    "samples": samples,
                    "derived": derived(samples),
                }
            )
        result["cases"] = records
        result["host_cleanliness"]["post"] = host_snapshot(enforce=False)
        result["adjudication"] = adjudicate(records, result["matched_release_authority"])
        if result["adjudication"]["aggregate_gate"]:
            result["status"] = "passed"
        else:
            result["failure_reasons"] = [
                name for name, passed in result["adjudication"]["checks"].items() if not passed
            ]
    except (CalibrationError, subprocess.CalledProcessError, OSError, ValueError) as error:
        result["failure_reasons"] = [str(error)]
        result["host_cleanliness"]["post"] = host_snapshot(enforce=False)

    output = write_result(options.output, result)
    if result["status"] != "passed":
        print(f"failed calibration evidence written to {output}", file=sys.stderr)
        return 1
    run(
        [
            sys.executable,
            str(ROOT / "scripts/check-phase7-slice2e.py"),
            "--calibration-evidence",
            str(output),
        ]
    )
    print(f"Phase 7 Slice 2E cgroup-v2 calibration evidence: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
