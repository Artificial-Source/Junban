#!/usr/bin/env python3
"""Fail-closed audit for the Phase 7 Slice 2E real-composition harness."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "crates/junban-plugin-sdk"
FIXTURE = SDK / "consumers/slice2e-rust"
AUTHORITY = SDK / "wit/plugin.wit"
RUST_ARTIFACT = SDK / "consumers/rust/rust-consumer.wasm"
TYPESCRIPT_ARTIFACT = SDK / "consumers/typescript/artifacts/typescript-consumer.wasm"
CONFORMANCE_ARTIFACT = FIXTURE / "slice2e-consumer.wasm"
PROVENANCE = FIXTURE / "artifact-provenance.json"
CONSUMER_PROVENANCE = SDK / "consumers/artifact-provenance.json"
HARNESS = ROOT / "crates/junban-server/src/plugin_runtime/slice2e_tests.rs"
CALIBRATOR = ROOT / "scripts/calibrate-phase7-slice2e-cgroup.py"
CALIBRATION_WORKFLOW = ROOT / ".github/workflows/phase7-slice2e-memory-calibration.yml"
GIT_ATTRIBUTES = ROOT / ".gitattributes"
HOST = ROOT / "crates/junban-plugin-host/src/lib.rs"
HOST_RUNTIME = ROOT / "crates/junban-plugin-host/src/runtime.rs"
SUPERVISOR_TESTS = ROOT / "crates/junban-server/src/plugin_runtime/tests.rs"
WORKSPACE_MANIFEST = ROOT / "Cargo.toml"
SERVER_MANIFEST = ROOT / "crates/junban-server/Cargo.toml"
COMPONENT_CAP = 32 * 1024 * 1024
WASMTIME_VERSION = "36.0.13"
EXPECTED_CASES = [
    "typed-package-admission",
    "rust-import-load-activate-invoke-deactivate",
    "typescript-import-load-activate-invoke-deactivate",
    "ordinary-query-settings-kv",
    "returned-kv-patch",
    "returned-domain-effect",
    "loopback-http-consume-once-delivery-id",
    "resync-catch-up-cursor-commit",
    "failed-event-no-cursor-or-effect",
    "nested-service-call",
    "cancel-before-dispatch",
    "cancel-blocked-callback-store-replacement",
    "guest-trap",
    "wasm-timeout",
    "output-bound",
    "callback-resource-failure",
    "wasm-resource-failure",
    "one-four-sixteen-graph",
    "fifth-and-same-plugin-admission",
    "sibling-isolation",
    "real-child-kill-eof-reap",
    "post-fault-retry-fresh-store",
    "all-children-reaped",
]
EXPECTED_IMPORTS = {
    "rust": [
        "junban:plugin/host-log@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
        "wasi:cli/environment@0.2.6",
        "wasi:cli/exit@0.2.6",
        "wasi:cli/stderr@0.2.6",
        "wasi:io/error@0.2.6",
        "wasi:io/streams@0.2.6",
    ],
    "typescript": [
        "junban:plugin/host-log@0.1.0",
        "junban:plugin/host-services@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
    ],
    "conformance": [
        "junban:plugin/host-http@0.1.0",
        "junban:plugin/host-services@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
        "wasi:cli/environment@0.2.6",
        "wasi:cli/exit@0.2.6",
        "wasi:cli/stderr@0.2.6",
        "wasi:io/error@0.2.6",
        "wasi:io/streams@0.2.6",
    ],
}


def fail(message: str) -> None:
    raise SystemExit(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid JSON at {path.relative_to(ROOT)}: {error}")


def string_array(source: str, name: str) -> list[str]:
    match = re.search(
        rf"const {re.escape(name)}(?::[^=]+)?=\s*&\[(.*?)\];",
        source,
        flags=re.DOTALL,
    )
    if not match:
        fail(f"missing {name} authority in Slice 2E harness")
    return re.findall(r'"([^"\\]+)"', match.group(1))


def audit_static() -> None:
    required = [
        AUTHORITY,
        RUST_ARTIFACT,
        TYPESCRIPT_ARTIFACT,
        CONFORMANCE_ARTIFACT,
        PROVENANCE,
        CONSUMER_PROVENANCE,
        HARNESS,
        FIXTURE / "Cargo.toml",
        FIXTURE / "Cargo.lock",
        FIXTURE / "README.md",
        FIXTURE / "src/lib.rs",
        FIXTURE / "wit/world.wit",
        FIXTURE / "wit/deps/junban-plugin/plugin.wit",
        CALIBRATOR,
        CALIBRATION_WORKFLOW,
        GIT_ATTRIBUTES,
        HOST,
        HOST_RUNTIME,
        SUPERVISOR_TESTS,
    ]
    for path in required:
        if not path.is_file() or path.is_symlink():
            fail(f"missing or non-regular Slice 2E authority: {path.relative_to(ROOT)}")

    attributes = GIT_ATTRIBUTES.read_bytes()
    expected_attributes = b"""* text=auto eol=lf

*.wasm binary
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.wav binary
*.webm binary
*.woff2 binary
*.ttf binary
*.junban-backup binary
"""
    if attributes != expected_attributes:
        fail("repository LF and binary attribute authority drifted")

    authority = AUTHORITY.read_bytes()
    if (FIXTURE / "wit/deps/junban-plugin/plugin.wit").read_bytes() != authority:
        fail("Slice 2E copied plugin WIT drifted from the frozen authority")
    if (FIXTURE / "wit/world.wit").read_text(encoding="utf-8").count(
        "include junban:plugin/plugin@0.1.0;"
    ) != 1:
        fail("Slice 2E world does not include exactly the frozen plugin world")

    manifest = (FIXTURE / "Cargo.toml").read_text(encoding="utf-8")
    if 'rust-version = "1.93"' not in manifest:
        fail("Slice 2E Rust toolchain pin drifted")
    if 'wit-bindgen = { version = "=0.51.0"' not in manifest:
        fail("Slice 2E wit-bindgen exact pin drifted")
    lock = (FIXTURE / "Cargo.lock").read_text(encoding="utf-8")
    if "git+" in lock or lock.count("[[package]]") > 40:
        fail("Slice 2E fixture dependency audit failed")
    if CONFORMANCE_ARTIFACT.stat().st_size > COMPONENT_CAP:
        fail("Slice 2E conformance component exceeds the JBP1 component cap")

    provenance = load_json(PROVENANCE)
    expected_provenance = {
        "schemaVersion": 1,
        "authority": "crates/junban-plugin-sdk/wit/plugin.wit",
        "witSha256": digest(AUTHORITY),
        "toolchain": "rustc 1.93.0",
        "target": "wasm32-wasip2",
        "witBindgen": "0.51.0",
        "artifact": "crates/junban-plugin-sdk/consumers/slice2e-rust/slice2e-consumer.wasm",
        "sizeBytes": CONFORMANCE_ARTIFACT.stat().st_size,
        "sha256": digest(CONFORMANCE_ARTIFACT),
        "byteReproducible": True,
        "imports": EXPECTED_IMPORTS["conformance"],
    }
    if provenance != expected_provenance:
        fail("Slice 2E conformance artifact provenance drifted")

    retained = load_json(CONSUMER_PROVENANCE)
    for language, artifact in (("rust", RUST_ARTIFACT), ("typescript", TYPESCRIPT_ARTIFACT)):
        record = retained.get(language) if isinstance(retained, dict) else None
        if not isinstance(record, dict):
            fail(f"missing retained {language} consumer provenance")
        if record.get("sha256") != digest(artifact) or record.get("sizeBytes") != artifact.stat().st_size:
            fail(f"retained {language} consumer artifact drifted")

    harness = HARNESS.read_text(encoding="utf-8")
    if string_array(harness, "CASE_INVENTORY") != EXPECTED_CASES:
        fail("Slice 2E case inventory drifted")
    for name, constant in (("rust", "RUST"), ("typescript", "TYPESCRIPT"), ("conformance", "CONFORMANCE")):
        imports = string_array(harness, constant)
        if name != "typescript":
            imports = sorted(imports + string_array(harness, "WASI"))
        if sorted(imports) != EXPECTED_IMPORTS[name]:
            fail(f"Slice 2E {name} import audit authority drifted")
    required_source = [
        "assert_fixture_imports(&paths)",
        "ProfileOwner::open",
        "PluginRuntimeSupervisor::for_test",
        "process_absent(pid)",
        '"cleanup": "all-children-reaped"',
        "JUNBAN_SLICE2E_HOST",
        "phase7_slice2e_linux_cgroup_calibration_probe",
        '#[ignore = "Linux cgroup-v2 calibration is an explicit evidence campaign"]',
    ]
    for needle in required_source:
        if needle not in harness:
            fail(f"Slice 2E harness lost required authority: {needle}")
    if re.search(r"(?:thread|tokio::time)::sleep\s*\(", harness):
        fail("Slice 2E harness uses a sleep as an oracle")
    calibrator = CALIBRATOR.read_text(encoding="utf-8")
    if (
        "SAMPLES = 5" not in calibrator
        or "memory.current" not in calibrator
        or "memory.peak" not in calibrator
    ):
        fail("Slice 2E cgroup-v2 calibration authority drifted")
    if re.search(r"(?:time\.)?sleep\s*\(", calibrator):
        fail("Slice 2E cgroup calibration uses a sleep as an oracle")

    host = HOST.read_text(encoding="utf-8")
    runtime = HOST_RUNTIME.read_text(encoding="utf-8")
    if (
        "CancelResult::Won | CancelResult::Lost => Ok(())" not in host
        or "CancelResult::Stale => send_failed(" not in host
        or "CancelResult::WorkerStopped => Err(HostError::Runtime)" not in host
        or "CancelResult::Lost | CancelResult::Stale" in host
    ):
        fail("child cancel terminal authority drifted")
    cancel_regression = [
        "timeout_completion_winning_before_cancel_emits_one_terminal",
        "cancel_and_wait_after_linearization",
        "timeout completion must own terminal authority",
        "ChildFrame::Failed",
        "HostFailureCode::Timeout",
        "Err(mpsc::TryRecvError::Empty)",
    ]
    if any(needle not in runtime for needle in cancel_regression):
        fail("child timeout/cancel deterministic regression drifted")

    supervisor_tests = SUPERVISOR_TESTS.read_text(encoding="utf-8")
    admission_regression = [
        "wait_for_captured_invocations(&fixture, &[100, 102, 103, 104]).await",
        "for invocation in [first, second, third, fourth]",
        "invocation.cancel()",
        "InvocationOutcome::Cancelled",
        "assert!(service.lock().fence_requests.is_empty())",
        "assert!(process_is_absent(pids.lock().unwrap()[0]))",
    ]
    if any(needle not in supervisor_tests for needle in admission_regression) or (
        "drop((first, second, third, fourth))" in supervisor_tests
    ):
        fail("parent admission teardown regression drifted")

    workflow = CALIBRATION_WORKFLOW.read_text(encoding="utf-8")
    workflow_authority = [
        'candidate="${current}"',
        'grep -qw memory "${candidate}/cgroup.subtree_control"',
        'candidate="$(dirname "${candidate}")"',
        "no cgroup-v2 ancestor delegates the memory controller",
        'grep -qw memory "${parent}/cgroup.controllers"',
        'echo +memory | sudo tee "${parent}/cgroup.subtree_control"',
        'sudo chown "$(id -u):$(id -g)"',
        'find "${JUNBAN_SLICE2E_CGROUP_PARENT}" -mindepth 1 -maxdepth 1',
        'sudo rmdir "${JUNBAN_SLICE2E_CGROUP_PARENT}"',
    ]
    if any(needle not in workflow for needle in workflow_authority):
        fail("Slice 2E cgroup ancestor delegation authority drifted")
    created = workflow.index('sudo mkdir "${parent}"')
    exported = workflow.index('echo "JUNBAN_SLICE2E_CGROUP_PARENT=${parent}"')
    verified = workflow.index('grep -qw memory "${parent}/cgroup.controllers"')
    if not created < exported < verified:
        fail("Slice 2E delegated parent cleanup authority is not published immediately")
    if 'parent="${current}/junban-slice2e-' in workflow or re.search(
        r'sudo rmdir "\$\{JUNBAN_SLICE2E_CGROUP_PARENT\}"\s*\|\|\s*true', workflow
    ):
        fail("Slice 2E workflow retained leaf delegation or ignored cleanup")

    workspace = WORKSPACE_MANIFEST.read_text(encoding="utf-8")
    if f'wasmtime = {{ version = "={WASMTIME_VERSION}"' not in workspace:
        fail("workspace Wasmtime pin drifted")
    if "wasmtime" in SERVER_MANIFEST.read_text(encoding="utf-8"):
        fail("normal junban-server manifest must not depend on Wasmtime")
    tree = subprocess.run(
        ["cargo", "tree", "-p", "junban-server", "--edges", "normal", "--locked"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout
    if re.search(r"(?m)^.*\bwasmtime(?:-wasi)? v", tree):
        fail("normal junban-server dependency tree contains Wasmtime")


def audit_artifact_record(record: Any, expected_path: Path | None) -> None:
    if not isinstance(record, dict) or set(record) != {"path", "sha256", "size_bytes"}:
        fail("invalid Slice 2E evidence artifact record")
    relative = record["path"]
    if not isinstance(relative, str) or Path(relative).is_absolute():
        fail("Slice 2E evidence artifact path must be repository-relative")
    path = ROOT / relative
    if not path.is_file():
        fail(f"Slice 2E evidence artifact is missing: {relative}")
    if expected_path is not None and path.resolve() != expected_path.resolve():
        fail(f"Slice 2E evidence artifact path drifted: {relative}")
    if record["sha256"] != digest(path) or record["size_bytes"] != path.stat().st_size:
        fail(f"Slice 2E evidence artifact digest drifted: {relative}")


def audit_evidence(path: Path) -> None:
    evidence = load_json(path)
    expected_keys = {
        "schema_version",
        "harness",
        "status",
        "target_os",
        "wasmtime",
        "process_model",
        "fixture_profiles",
        "scales",
        "cases",
        "cleanup",
        "artifacts",
    }
    if not isinstance(evidence, dict) or set(evidence) != expected_keys:
        fail("Slice 2E evidence JSON schema drifted")
    if (
        evidence["schema_version"] != 1
        or evidence["harness"] != "phase7-slice2e"
        or evidence["status"] != "passed"
        or evidence["target_os"] not in {"linux", "macos", "windows"}
        or evidence["wasmtime"] != WASMTIME_VERSION
        or evidence["process_model"] != "one-on-demand-child-per-profile"
        or evidence["fixture_profiles"] != ["rust", "typescript"]
        or evidence["scales"] != [1, 4, 16]
        or evidence["cases"] != EXPECTED_CASES
        or evidence["cleanup"] != "all-children-reaped"
    ):
        fail("Slice 2E evidence content drifted")
    artifacts = evidence["artifacts"]
    if not isinstance(artifacts, dict) or set(artifacts) != {
        "host",
        "rust",
        "typescript",
        "conformance",
    }:
        fail("Slice 2E evidence artifact inventory drifted")
    audit_artifact_record(artifacts["host"], None)
    audit_artifact_record(artifacts["rust"], RUST_ARTIFACT)
    audit_artifact_record(artifacts["typescript"], TYPESCRIPT_ARTIFACT)
    audit_artifact_record(artifacts["conformance"], CONFORMANCE_ARTIFACT)


def audit_calibration_evidence(path: Path) -> None:
    evidence = load_json(path)
    expected_keys = {
        "schema_version",
        "status",
        "metric_authority",
        "wasmtime",
        "samples_per_case",
        "host_sha256",
        "rust_component_sha256",
        "typescript_component_sha256",
        "cases",
    }
    if not isinstance(evidence, dict) or set(evidence) != expected_keys:
        fail("Slice 2E calibration JSON schema drifted")
    if (
        evidence["schema_version"] != 1
        or evidence["status"] != "measured"
        or evidence["metric_authority"]
        != "linux-cgroup-v2-memory.current-and-memory.peak"
        or evidence["wasmtime"] != WASMTIME_VERSION
        or evidence["samples_per_case"] != 5
        or evidence["rust_component_sha256"] != digest(RUST_ARTIFACT)
        or evidence["typescript_component_sha256"] != digest(TYPESCRIPT_ARTIFACT)
        or not isinstance(evidence["host_sha256"], str)
        or re.fullmatch(r"[0-9a-f]{64}", evidence["host_sha256"]) is None
    ):
        fail("Slice 2E calibration authority drifted")
    cases = evidence["cases"]
    expected_cases = [
        ("baseline", 0, 0),
        ("rust", 1, 0),
        ("rust", 4, 0),
        ("rust", 16, 0),
        ("typescript", 1, 1),
        ("typescript", 4, 1),
        ("typescript", 16, 1),
    ]
    if not isinstance(cases, list) or len(cases) != len(expected_cases):
        fail("Slice 2E calibration case inventory drifted")
    for case, (profile, scale, support_plugins) in zip(cases, expected_cases, strict=True):
        if not isinstance(case, dict) or set(case) != {
            "profile",
            "plugin_scale",
            "support_plugins",
            "samples",
        }:
            fail("Slice 2E calibration case schema drifted")
        if (
            case["profile"] != profile
            or case["plugin_scale"] != scale
            or case["support_plugins"] != support_plugins
            or not isinstance(case["samples"], list)
            or len(case["samples"]) != 5
        ):
            fail("Slice 2E calibration case authority drifted")
        for sequence, sample in enumerate(case["samples"], 1):
            if not isinstance(sample, dict) or set(sample) != {
                "sequence",
                "memory_current_bytes",
                "memory_peak_bytes",
            }:
                fail("Slice 2E calibration sample schema drifted")
            current = sample["memory_current_bytes"]
            peak = sample["memory_peak_bytes"]
            if (
                sample["sequence"] != sequence
                or not isinstance(current, int)
                or isinstance(current, bool)
                or not isinstance(peak, int)
                or isinstance(peak, bool)
                or current <= 0
                or peak < current
            ):
                fail("Slice 2E calibration sample value drifted")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--calibration-evidence", type=Path)
    options = parser.parse_args()
    audit_static()
    if options.evidence is not None:
        audit_evidence(options.evidence.resolve(strict=True))
    if options.calibration_evidence is not None:
        audit_calibration_evidence(options.calibration_evidence.resolve(strict=True))
    print("Phase 7 Slice 2E harness, pins, fixtures, imports, cases, cleanup, and schema are exact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
