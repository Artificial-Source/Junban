#!/usr/bin/env python3
"""Explicit ignored Linux cgroup-v2 calibration for Phase 7 Slice 2E."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEST_NAME = "plugin_runtime::slice2e_tests::phase7_slice2e_linux_cgroup_calibration_probe"
READY_PREFIX = "SLICE2E_CALIBRATION_READY="
RUST_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/rust/rust-consumer.wasm"
TYPESCRIPT_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-consumer.wasm"
CONFORMANCE_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/slice2e-rust/slice2e-consumer.wasm"
SAMPLES = 5
CASES = [("baseline", 0), ("rust", 1), ("rust", 4), ("rust", 16), ("typescript", 1), ("typescript", 4), ("typescript", 16)]


def fail(message: str) -> None:
    raise SystemExit(message)


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


def measure_case(
    parent: Path,
    host: Path,
    profile: str,
    scale: int,
    sequence: int,
) -> dict[str, int]:
    group = parent / f"junban-slice2e-{os.getpid()}-{profile}-{scale}-{sequence}"
    group.mkdir()
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
            "JUNBAN_SLICE2E_CONFORMANCE_COMPONENT": str(CONFORMANCE_ARTIFACT.resolve(strict=True)),
        }
    )
    cargo = [
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
    process = subprocess.Popen(
        ["bash", "-c", 'kill -STOP "$$"; exec "$@"', "slice2e-calibration", *cargo],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    try:
        (group / "cgroup.procs").write_text(f"{process.pid}\n", encoding="ascii")
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
        expected_graph = 0 if profile == "baseline" else scale + int(profile == "typescript")
        if marker != {"profile": profile, "scale": scale, "graph_size": expected_graph}:
            fail(f"calibration ready marker drifted: {marker}")
        current = read_u64(group / "memory.current")
        peak = read_u64(group / "memory.peak")
        if peak < current or current == 0:
            fail("invalid cgroup-v2 calibration measurements")
        assert process.stdin is not None
        process.stdin.write("release\n")
        process.stdin.flush()
        process.stdin.close()
        for line in process.stdout:
            sys.stdout.write(line)
        return_code = process.wait()
        if return_code != 0:
            fail(f"calibration probe failed with exit code {return_code}")
        events = (group / "cgroup.events").read_text(encoding="ascii")
        if "populated 0" not in events.splitlines():
            fail("calibration cgroup retained a live process after shutdown")
        return {
            "sequence": sequence,
            "memory_current_bytes": current,
            "memory_peak_bytes": peak,
        }
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        try:
            group.rmdir()
        except OSError as error:
            fail(f"failed to remove calibration cgroup {group}: {error}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("target/phase7-slice2e/cgroup-memory.json"),
    )
    options = parser.parse_args()
    if platform.system() != "Linux" or not Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        fail("Slice 2E memory calibration requires Linux cgroup v2")
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
    records = []
    for profile, scale in CASES:
        print(f"Slice 2E cgroup calibration: profile={profile} scale={scale}")
        samples = [
            measure_case(parent, host, profile, scale, sequence)
            for sequence in range(1, SAMPLES + 1)
        ]
        records.append(
            {
                "profile": profile,
                "plugin_scale": scale,
                "support_plugins": int(profile == "typescript"),
                "samples": samples,
            }
        )
    result = {
        "schema_version": 1,
        "status": "measured",
        "metric_authority": "linux-cgroup-v2-memory.current-and-memory.peak",
        "wasmtime": "36.0.13",
        "samples_per_case": SAMPLES,
        "host_sha256": digest(host),
        "rust_component_sha256": digest(RUST_ARTIFACT),
        "typescript_component_sha256": digest(TYPESCRIPT_ARTIFACT),
        "cases": records,
    }
    output = options.output if options.output.is_absolute() else ROOT / options.output
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(output)
    run(
        [
            sys.executable,
            str(ROOT / "scripts/check-phase7-slice2e.py"),
            "--calibration-evidence",
            str(output.resolve(strict=True)),
        ]
    )
    print(f"Phase 7 Slice 2E cgroup-v2 calibration evidence: {output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
