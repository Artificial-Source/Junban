#!/usr/bin/env python3
"""Build/select the release host and run the Phase 7 Slice 2E harness."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-phase7-slice2e.py"
RUST_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/rust/rust-consumer.wasm"
TYPESCRIPT_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-consumer.wasm"
CONFORMANCE_ARTIFACT = ROOT / "crates/junban-plugin-sdk/consumers/slice2e-rust/slice2e-consumer.wasm"
TEST_NAME = "plugin_runtime::slice2e_tests::phase7_slice2e_real_production_composition"
RESULT_PREFIX = "SLICE2E_RESULT_JSON="
MARKER_KEYS = {
    "schema_version",
    "status",
    "cases",
    "wasmtime",
    "process_model",
    "fixture_profiles",
    "scales",
    "cleanup",
}


def fail(message: str) -> None:
    raise SystemExit(message)


def run(args: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=capture,
    )
    return result.stdout if capture else ""


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def regular_absolute(path: Path, label: str) -> Path:
    candidate = path if path.is_absolute() else ROOT / path
    if candidate.is_symlink():
        fail(f"{label} must not be a symlink")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_file():
        fail(f"{label} must resolve to a regular file")
    return resolved


def target_directory() -> Path:
    metadata = json.loads(
        run(
            ["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"],
            capture=True,
        )
    )
    value = metadata.get("target_directory")
    if not isinstance(value, str):
        fail("cargo metadata omitted target_directory")
    return Path(value)


def release_host(selected: Path | None) -> Path:
    if selected is not None:
        return regular_absolute(selected, "selected plugin host")
    run(["cargo", "build", "-p", "junban-plugin-host", "--release", "--locked"])
    suffix = ".exe" if os.name == "nt" else ""
    return regular_absolute(
        target_directory() / "release" / f"junban-plugin-host{suffix}",
        "built plugin host",
    )


def repository_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        fail(f"evidence artifact must be inside the repository: {path}")


def artifact_record(path: Path) -> dict[str, Any]:
    return {
        "path": repository_relative(path),
        "sha256": digest(path),
        "size_bytes": path.stat().st_size,
    }


def target_os() -> str:
    value = platform.system()
    mapping = {"Linux": "linux", "Darwin": "macos", "Windows": "windows"}
    if value not in mapping:
        fail(f"unsupported Slice 2E target OS: {value}")
    return mapping[value]


def run_harness(host: Path) -> dict[str, Any]:
    rust = regular_absolute(RUST_ARTIFACT, "retained Rust component")
    typescript = regular_absolute(TYPESCRIPT_ARTIFACT, "retained TypeScript component")
    conformance = regular_absolute(CONFORMANCE_ARTIFACT, "Slice 2E conformance component")
    environment = os.environ.copy()
    environment.update(
        {
            "JUNBAN_SLICE2E_RUN": "1",
            "JUNBAN_SLICE2E_HOST": str(host),
            "JUNBAN_SLICE2E_RUST_COMPONENT": str(rust),
            "JUNBAN_SLICE2E_TYPESCRIPT_COMPONENT": str(typescript),
            "JUNBAN_SLICE2E_CONFORMANCE_COMPONENT": str(conformance),
        }
    )
    command = [
        "cargo",
        "test",
        "-p",
        "junban-server",
        TEST_NAME,
        "--locked",
        "--",
        "--exact",
        "--nocapture",
    ]
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    markers: list[str] = []
    for line in process.stdout:
        sys.stdout.write(line)
        if line.startswith(RESULT_PREFIX):
            markers.append(line.removeprefix(RESULT_PREFIX).strip())
    return_code = process.wait()
    if return_code != 0:
        fail(f"Slice 2E harness failed with exit code {return_code}")
    if len(markers) != 1:
        fail(f"Slice 2E harness emitted {len(markers)} result markers; expected exactly one")
    try:
        marker = json.loads(markers[0])
    except json.JSONDecodeError as error:
        fail(f"Slice 2E harness emitted malformed result JSON: {error}")
    if not isinstance(marker, dict) or set(marker) != MARKER_KEYS:
        fail("Slice 2E harness result marker schema drifted")
    if marker.get("schema_version") != 1 or marker.get("status") != "passed":
        fail("Slice 2E harness did not report a passing schema-v1 result")
    marker.update(
        {
            "harness": "phase7-slice2e",
            "target_os": target_os(),
            "artifacts": {
                "host": artifact_record(host),
                "rust": artifact_record(rust),
                "typescript": artifact_record(typescript),
                "conformance": artifact_record(conformance),
            },
        }
    )
    return marker


def write_result(path: Path, result: dict[str, Any]) -> Path:
    output = path if path.is_absolute() else ROOT / path
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(output)
    return output.resolve(strict=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="audit committed harness authorities only")
    parser.add_argument("--host", type=Path, help="select an existing release junban-plugin-host")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("target/phase7-slice2e/result.json"),
        help="result JSON path (default: target/phase7-slice2e/result.json)",
    )
    options = parser.parse_args()
    run([sys.executable, str(CHECKER)])
    if options.check:
        if options.host is not None:
            fail("--host is not valid with --check")
        return 0
    host = release_host(options.host)
    result_path = write_result(options.output, run_harness(host))
    run([sys.executable, str(CHECKER), "--evidence", str(result_path)])
    print(f"Phase 7 Slice 2E evidence: {result_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
