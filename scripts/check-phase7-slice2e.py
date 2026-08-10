#!/usr/bin/env python3
"""Fail-closed audit for the Phase 7 Slice 2E real-composition harness."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "crates/junban-plugin-sdk"
FIXTURE = SDK / "consumers/slice2e-rust"
AUTHORITY = SDK / "wit/plugin.wit"
RUST_ARTIFACT = SDK / "consumers/rust/rust-consumer.wasm"
TYPESCRIPT_ARTIFACT = SDK / "consumers/typescript/artifacts/typescript-consumer.wasm"
TYPESCRIPT_STANDALONE_ARTIFACT = SDK / "consumers/typescript/artifacts/typescript-standalone-calibration.wasm"
TYPESCRIPT_STANDALONE_SOURCE = SDK / "consumers/typescript/src/standalone-calibration.ts"
TYPESCRIPT_STANDALONE_BUILD = SDK / "consumers/typescript/build-standalone-calibration.mjs"
TYPESCRIPT_STANDALONE_PROVENANCE = SDK / "consumers/typescript/standalone-calibration-provenance.json"
CONFORMANCE_ARTIFACT = FIXTURE / "slice2e-consumer.wasm"
PROVENANCE = FIXTURE / "artifact-provenance.json"
CONSUMER_PROVENANCE = SDK / "consumers/artifact-provenance.json"
HARNESS = ROOT / "crates/junban-server/src/plugin_runtime/slice2e_tests.rs"
CALIBRATOR = ROOT / "scripts/calibrate-phase7-slice2e-cgroup.py"
CALIBRATION_WORKFLOW = ROOT / ".github/workflows/phase7-slice2e-memory-calibration.yml"
MATCHED_RELEASE_EVIDENCE = ROOT / "goals/rust-rewrite/evidence/phase-7-sdk-matched-release.json"
GIT_ATTRIBUTES = ROOT / ".gitattributes"
HOST = ROOT / "crates/junban-plugin-host/src/lib.rs"
HOST_RUNTIME = ROOT / "crates/junban-plugin-host/src/runtime.rs"
SUPERVISOR_TESTS = ROOT / "crates/junban-server/src/plugin_runtime/tests.rs"
WORKSPACE_MANIFEST = ROOT / "Cargo.toml"
SERVER_MANIFEST = ROOT / "crates/junban-server/Cargo.toml"
COMPONENT_CAP = 32 * 1024 * 1024
WASMTIME_VERSION = "36.0.13"
FULL_TS_FROZEN_SHA256 = "78abc3d8e07de4a6e399f12da523c2e52b76236416171b82bd7fbbf26b66d6c4"
STANDALONE_TS_FROZEN_SHA256 = "8616e64e1152ad6f2915107745201ac1888c15124132c9c1fffba0cbd165d8e7"
MATCHED_RELEASE_COMMIT = "5d05eacbdfd9298eefc16c5b69f730cd2f05494e"
MATCHED_RELEASE_SHA256 = "233083ba924258e4b9d3863367ad2a6a3a6c12b663e2169ebf27007edbde9f78"
MATCHED_DEFAULT_CURRENT_MAX = 9_994_240
MATCHED_DEFAULT_PEAK_MAX = 10_047_488
MIB = 1024 * 1024
FORMULA_CURRENT = (
    "matched_default_release_current_max + "
    "max(0, active_scale1_current_max - same_run_harness_baseline_current_max)"
)
FORMULA_PEAK = (
    "matched_default_release_peak_max + "
    "max(0, active_scale1_peak_max - same_run_harness_baseline_peak_max)"
)


def budget_bytes(mib: str) -> int:
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
    "typescript_standalone": ["junban:plugin/types@0.1.0"],
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
        TYPESCRIPT_STANDALONE_ARTIFACT,
        TYPESCRIPT_STANDALONE_SOURCE,
        TYPESCRIPT_STANDALONE_BUILD,
        TYPESCRIPT_STANDALONE_PROVENANCE,
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
        MATCHED_RELEASE_EVIDENCE,
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
    if TYPESCRIPT_STANDALONE_ARTIFACT.stat().st_size > COMPONENT_CAP:
        fail("standalone TypeScript calibration component exceeds the JBP1 component cap")
    if digest(TYPESCRIPT_ARTIFACT) != FULL_TS_FROZEN_SHA256:
        fail("retained full TypeScript consumer bytes drifted")
    if digest(TYPESCRIPT_STANDALONE_ARTIFACT) != STANDALONE_TS_FROZEN_SHA256:
        fail("retained standalone TypeScript calibration bytes drifted")

    standalone_provenance = load_json(TYPESCRIPT_STANDALONE_PROVENANCE)
    expected_standalone_provenance = {
        "schemaVersion": 1,
        "calibrationOnly": True,
        "shipped": False,
        "authority": "crates/junban-plugin-sdk/wit/plugin.wit",
        "witSha256": digest(AUTHORITY),
        "source": "crates/junban-plugin-sdk/consumers/typescript/src/standalone-calibration.ts",
        "artifact": "crates/junban-plugin-sdk/consumers/typescript/artifacts/typescript-standalone-calibration.wasm",
        "jco": "1.26.1",
        "componentizeJs": "0.22.0",
        "wasi": "--disable all",
        "byteReproducible": False,
        "sizeBytes": TYPESCRIPT_STANDALONE_ARTIFACT.stat().st_size,
        "sha256": digest(TYPESCRIPT_STANDALONE_ARTIFACT),
        "imports": EXPECTED_IMPORTS["typescript_standalone"],
        "exports": ["junban:plugin/guest@0.1.0"],
    }
    if standalone_provenance != expected_standalone_provenance:
        fail("standalone TypeScript calibration provenance drifted")
    standalone_source = TYPESCRIPT_STANDALONE_SOURCE.read_text(encoding="utf-8")
    if not standalone_source.startswith('import type * as T from "junban:plugin/types@0.1.0";'):
        fail("standalone TypeScript calibration source lost type-only authority")
    if re.search(r'from "junban:plugin/host-', standalone_source):
        fail("standalone TypeScript calibration source gained a capability host call")
    standalone_build = TYPESCRIPT_STANDALONE_BUILD.read_text(encoding="utf-8")
    build_authority = [
        '"componentize"',
        '"typescript-standalone-calibration"',
        '"--disable"',
        '"all"',
        "fresh standalone calibration component structure drifted",
        "standalone calibration component gained a capability or WASI import",
    ]
    if any(needle not in standalone_build for needle in build_authority):
        fail("standalone TypeScript calibration build authority drifted")
    typescript_package = load_json(SDK / "consumers/typescript/package.json")
    scripts = typescript_package.get("scripts") if isinstance(typescript_package, dict) else None
    combined_check = (
        "node ./build.mjs --check && node ./build-standalone-calibration.mjs --check"
    )
    if (
        not isinstance(scripts, dict)
        or scripts.get("build") != combined_check
        or scripts.get("check") != combined_check
        or scripts.get("check:standalone-calibration")
        != "node ./build-standalone-calibration.mjs --check"
    ):
        fail("standalone TypeScript calibration package check drifted")

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

    if digest(MATCHED_RELEASE_EVIDENCE) != MATCHED_RELEASE_SHA256:
        fail("matched default release evidence bytes drifted")
    matched = load_json(MATCHED_RELEASE_EVIDENCE)
    matched_git = matched.get("git") if isinstance(matched, dict) else None
    matched_samples = matched.get("default", {}).get("samples") if isinstance(matched, dict) else None
    if (
        matched.get("accepted") is not True
        or matched.get("acceptance_blockers") != []
        or matched.get("gate", {}).get("passed") is not True
        or not isinstance(matched_git, dict)
        or matched_git.get("commit") != MATCHED_RELEASE_COMMIT
        or matched_git.get("dirty") is not False
        or matched_git.get("dirty_at_start") is not False
        or matched_git.get("dirty_after_measurements") is not False
        or not isinstance(matched_samples, list)
        or len(matched_samples) != 5
    ):
        fail("matched default release provenance drifted")
    try:
        matched_current = max(sample["warm"]["cgroup_current_bytes"] for sample in matched_samples)
        matched_peak = max(sample["warm"]["cgroup_peak_bytes"] for sample in matched_samples)
    except (KeyError, TypeError, ValueError) as error:
        fail(f"matched default release raw samples drifted: {error}")
    if (matched_current, matched_peak) != (MATCHED_DEFAULT_CURRENT_MAX, MATCHED_DEFAULT_PEAK_MAX):
        fail("matched default release maxima drifted")

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
        "JUNBAN_SLICE2E_TYPESCRIPT_STANDALONE_COMPONENT",
        "typescript_standalone_manifest",
        "if scale == 1",
        "for index in 0..(scale - 1)",
        'assert_eq!(graph_size, scale, "plugin_scale is the total loaded graph")',
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
        or "schema_version\": 2" not in calibrator
        or "--idle-host-confirmed" not in calibrator
        or "TYPESCRIPT_STANDALONE_ARTIFACT" not in calibrator
        or "FORMULA_CURRENT" not in calibrator
        or "FORMULA_PEAK" not in calibrator
        or "BUDGETS" not in calibrator
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
        '"${parent}/cgroup.procs" "${parent}/cgroup.threads"',
        'echo "$$" > "${JUNBAN_SLICE2E_CGROUP_PARENT}/cgroup.procs"',
        'exec setpriv --reuid "${JUNBAN_SLICE2E_UID}"',
        '--regid "${JUNBAN_SLICE2E_GID}" --init-groups',
        'find "${JUNBAN_SLICE2E_CGROUP_PARENT}" -mindepth 1 -maxdepth 1',
        'sudo rmdir "${JUNBAN_SLICE2E_CGROUP_PARENT}"',
        "--idle-host-confirmed",
        "timeout-minutes: 90",
        "- name: Upload raw calibration JSON",
        'path: ${{ runner.temp }}/phase7-slice2e-cgroup-memory.json',
        "if-no-files-found: warn",
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
    entered_delegate = workflow.index(
        'echo "$$" > "${JUNBAN_SLICE2E_CGROUP_PARENT}/cgroup.procs"'
    )
    dropped_privileges = workflow.index('exec setpriv --reuid "${JUNBAN_SLICE2E_UID}"')
    campaign_step = workflow.index("python3 scripts/calibrate-phase7-slice2e-cgroup.py")
    cleanup_step = workflow.index("- name: Remove delegated cgroup parent")
    upload_step = workflow.index("- name: Upload raw calibration JSON")
    if not verified < entered_delegate < dropped_privileges < campaign_step:
        fail("Slice 2E campaign is not entered as root and run as the unprivileged owner")
    if not campaign_step < cleanup_step < upload_step or "if: always()" not in workflow[upload_step:]:
        fail("Slice 2E workflow no longer preserves failed raw evidence after cleanup")

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
        "typescript_standalone_calibration",
        "conformance",
    }:
        fail("Slice 2E evidence artifact inventory drifted")
    audit_artifact_record(artifacts["host"], None)
    audit_artifact_record(artifacts["rust"], RUST_ARTIFACT)
    audit_artifact_record(artifacts["typescript"], TYPESCRIPT_ARTIFACT)
    audit_artifact_record(
        artifacts["typescript_standalone_calibration"], TYPESCRIPT_STANDALONE_ARTIFACT
    )
    audit_artifact_record(artifacts["conformance"], CONFORMANCE_ARTIFACT)


def integer(value: Any, label: str, *, positive: bool = False) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or (positive and value <= 0):
        fail(f"{label} must be an integer{' greater than zero' if positive else ''}")
    return value


def audit_calibration_artifact(record: Any, expected: Path | None) -> None:
    if not isinstance(record, dict) or set(record) != {"path", "sha256", "size_bytes"}:
        fail("Slice 2E calibration artifact record drifted")
    rendered = record["path"]
    if not isinstance(rendered, str) or not rendered:
        fail("Slice 2E calibration artifact path drifted")
    artifact = Path(rendered)
    artifact = artifact if artifact.is_absolute() else ROOT / artifact
    if artifact.is_symlink() or not artifact.is_file():
        fail(f"Slice 2E calibration artifact is missing or linked: {rendered}")
    if expected is not None and artifact.resolve() != expected.resolve():
        fail(f"Slice 2E calibration artifact path drifted: {rendered}")
    if record["sha256"] != digest(artifact) or record["size_bytes"] != artifact.stat().st_size:
        fail(f"Slice 2E calibration artifact bytes drifted: {rendered}")


def recompute_adjudication(cases: list[dict[str, Any]]) -> dict[str, Any]:
    indexed = {(case["profile"], case["plugin_scale"]): case for case in cases}
    baseline = indexed[("baseline", 0)]["derived"]

    def normalized(profile: str, budget_name: str) -> dict[str, Any]:
        active = indexed[(profile, 1)]["derived"]
        current_delta = max(
            0,
            active["memory_current_max_bytes"] - baseline["memory_current_max_bytes"],
        )
        peak_delta = max(0, active["memory_peak_max_bytes"] - baseline["memory_peak_max_bytes"])
        current = MATCHED_DEFAULT_CURRENT_MAX + current_delta
        peak = MATCHED_DEFAULT_PEAK_MAX + peak_delta
        budget = BUDGETS[budget_name]
        return {
            "memory_current": {
                "matched_default_release_max_bytes": MATCHED_DEFAULT_CURRENT_MAX,
                "active_scale1_max_bytes": active["memory_current_max_bytes"],
                "same_run_harness_baseline_max_bytes": baseline["memory_current_max_bytes"],
                "nonnegative_active_delta_bytes": current_delta,
                "normalized_bytes": current,
                "budget_bytes": budget["memory_current_bytes"],
                "passed": current <= budget["memory_current_bytes"],
            },
            "memory_peak": {
                "matched_default_release_max_bytes": MATCHED_DEFAULT_PEAK_MAX,
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


def audit_calibration_evidence(path: Path) -> None:
    evidence = load_json(path)
    expected_keys = {
        "schema_version",
        "status",
        "failure_reasons",
        "git",
        "platform",
        "rust",
        "campaign",
        "wasmtime",
        "metric",
        "samples_per_case",
        "host_cleanliness",
        "matched_release_authority",
        "artifacts",
        "approved_budgets",
        "cases",
        "adjudication",
    }
    if not isinstance(evidence, dict) or set(evidence) != expected_keys:
        fail("Slice 2E calibration JSON schema-v2 drifted")
    if evidence["status"] != "passed":
        fail("Slice 2E calibration evidence is failed or nonpassing")
    if evidence["schema_version"] != 2 or evidence["failure_reasons"] != []:
        fail("Slice 2E calibration status authority drifted")

    git = evidence["git"]
    if not isinstance(git, dict) or set(git) != {
        "commit",
        "clean_at_start",
        "github_sha",
        "github_run_id",
        "github_run_attempt",
    }:
        fail("Slice 2E calibration git provenance drifted")
    if re.fullmatch(r"[0-9a-f]{40}", git["commit"] or "") is None or git["clean_at_start"] is not True:
        fail("Slice 2E calibration was not started from an exact clean commit")
    if git["github_sha"] is not None and git["github_sha"] != git["commit"]:
        fail("Slice 2E calibration GitHub SHA does not bind the measured commit")
    for name in ("github_run_id", "github_run_attempt"):
        if git[name] is not None and (
            not isinstance(git[name], str) or re.fullmatch(r"[1-9][0-9]*", git[name]) is None
        ):
            fail(f"Slice 2E calibration {name} drifted")

    platform_record = evidence["platform"]
    if (
        not isinstance(platform_record, dict)
        or set(platform_record) != {"kernel_release", "platform", "machine"}
        or platform_record["platform"] != "Linux"
        or any(not isinstance(platform_record[name], str) or not platform_record[name] for name in platform_record)
    ):
        fail("Slice 2E calibration kernel/platform/machine provenance drifted")
    rust = evidence["rust"]
    if (
        not isinstance(rust, dict)
        or set(rust) != {"verbose_version", "host_target"}
        or not isinstance(rust["verbose_version"], str)
        or not isinstance(rust["host_target"], str)
        or f"host: {rust['host_target']}" not in rust["verbose_version"].splitlines()
    ):
        fail("Slice 2E calibration rustc provenance drifted")

    expected_command = [
        "cargo",
        "test",
        "--release",
        "-p",
        "junban-server",
        "plugin_runtime::slice2e_tests::phase7_slice2e_linux_cgroup_calibration_probe",
        "--locked",
        "--",
        "--ignored",
        "--exact",
        "--nocapture",
        "--test-threads=1",
    ]
    if evidence["campaign"] != {
        "release_profile": "release",
        "exact_command": expected_command,
        "workload": "real-host-load-and-idle-ready-marker",
        "idle_host_confirmed": True,
    }:
        fail("Slice 2E calibration release command/workload authority drifted")
    if evidence["wasmtime"] != WASMTIME_VERSION or evidence["samples_per_case"] != 5:
        fail("Slice 2E calibration runtime/sample authority drifted")
    if evidence["metric"] != {
        "authority": "linux-cgroup-v2",
        "current_source": "per-sample-child-cgroup/memory.current at exact ready marker",
        "peak_source": "per-sample-child-cgroup/memory.peak at exact ready marker",
        "swap_source": "memory.swap.current/memory.swap.peak when exposed",
        "normalized_formula": {
            "memory_current": FORMULA_CURRENT,
            "memory_peak": FORMULA_PEAK,
        },
    }:
        fail("Slice 2E calibration cgroup metric/formula/source drifted")

    cleanliness = evidence["host_cleanliness"]
    if (
        not isinstance(cleanliness, dict)
        or set(cleanliness) != {"idle_host_confirmation", "pre", "post"}
        or cleanliness["idle_host_confirmation"] is not True
    ):
        fail("Slice 2E calibration idle-host confirmation drifted")
    for phase, enforce in (("pre", True), ("post", False)):
        snapshot = cleanliness[phase]
        if not isinstance(snapshot, dict) or set(snapshot) != {
            "cpu_count",
            "load1",
            "load5",
            "load15",
            "load1_threshold",
            "load5_threshold",
            "thresholds_enforced",
            "passed",
        }:
            fail(f"Slice 2E calibration {phase} host-load schema drifted")
        cpus = integer(snapshot["cpu_count"], f"{phase} CPU count", positive=True)
        for name in ("load1", "load5", "load15", "load1_threshold", "load5_threshold"):
            if not isinstance(snapshot[name], (int, float)) or isinstance(snapshot[name], bool) or snapshot[name] < 0:
                fail(f"Slice 2E calibration {phase} {name} drifted")
        if (
            snapshot["load1_threshold"] != max(1.0, cpus * 0.5)
            or snapshot["load5_threshold"] != max(1.0, cpus * 0.3)
            or snapshot["thresholds_enforced"] is not enforce
            or snapshot["passed"] is not True
        ):
            fail(f"Slice 2E calibration {phase} load threshold derivation drifted")
        if enforce and (
            snapshot["load1"] > snapshot["load1_threshold"]
            or snapshot["load5"] > snapshot["load5_threshold"]
        ):
            fail("Slice 2E calibration preflight exceeded accepted CPU-scaled load")

    matched = evidence["matched_release_authority"]
    expected_matched = {
        "path": MATCHED_RELEASE_EVIDENCE.relative_to(ROOT).as_posix(),
        "sha256": MATCHED_RELEASE_SHA256,
        "accepted_commit": MATCHED_RELEASE_COMMIT,
        "default_release_max": {
            "memory_current_bytes": MATCHED_DEFAULT_CURRENT_MAX,
            "memory_peak_bytes": MATCHED_DEFAULT_PEAK_MAX,
        },
    }
    if matched != expected_matched:
        fail("Slice 2E matched default release linkage drifted")
    if evidence["approved_budgets"] != BUDGETS:
        fail("Slice 2E approved integer-byte budgets drifted")

    artifacts = evidence["artifacts"]
    if not isinstance(artifacts, dict) or set(artifacts) != {
        "host",
        "rust_component",
        "typescript_full_component",
        "typescript_standalone_component",
        "conformance_component",
    }:
        fail("Slice 2E calibration artifact inventory drifted")
    audit_calibration_artifact(artifacts["host"], None)
    audit_calibration_artifact(artifacts["rust_component"], RUST_ARTIFACT)
    audit_calibration_artifact(artifacts["typescript_full_component"], TYPESCRIPT_ARTIFACT)
    audit_calibration_artifact(
        artifacts["typescript_standalone_component"], TYPESCRIPT_STANDALONE_ARTIFACT
    )
    audit_calibration_artifact(artifacts["conformance_component"], CONFORMANCE_ARTIFACT)

    cases = evidence["cases"]
    expected_cases = [
        ("baseline", 0, 0, 0),
        ("rust", 1, 1, 0),
        ("rust", 4, 4, 0),
        ("rust", 16, 16, 0),
        ("typescript", 1, 1, 0),
        ("typescript", 4, 4, 1),
        ("typescript", 16, 16, 1),
    ]
    if not isinstance(cases, list) or len(cases) != len(expected_cases):
        fail("Slice 2E calibration case inventory drifted")
    for case, (profile, scale, graph_size, support_plugins) in zip(
        cases, expected_cases, strict=True
    ):
        if not isinstance(case, dict) or set(case) != {
            "profile",
            "plugin_scale",
            "graph_size",
            "support_plugins",
            "samples",
            "derived",
        }:
            fail("Slice 2E calibration case schema drifted")
        if (
            case["profile"] != profile
            or case["plugin_scale"] != scale
            or case["graph_size"] != graph_size
            or case["support_plugins"] != support_plugins
            or not isinstance(case["samples"], list)
            or len(case["samples"]) != 5
        ):
            fail("Slice 2E calibration total-graph/support authority drifted")
        currents: list[int] = []
        peaks: list[int] = []
        expected_marker = {
            "profile": profile,
            "scale": scale,
            "graph_size": graph_size,
            "support_plugins": support_plugins,
        }
        for sequence, sample in enumerate(case["samples"], 1):
            if not isinstance(sample, dict) or set(sample) != {
                "sequence",
                "memory_current_bytes",
                "memory_peak_bytes",
                "memory_swap_current_bytes",
                "memory_swap_peak_bytes",
                "ready_elapsed_ms",
                "ready_marker",
                "populated_zero",
                "cgroup_deleted",
            }:
                fail("Slice 2E calibration sample schema drifted")
            current = integer(sample["memory_current_bytes"], "memory.current", positive=True)
            peak = integer(sample["memory_peak_bytes"], "memory.peak", positive=True)
            if sample["sequence"] != sequence or peak < current:
                fail("Slice 2E calibration current/peak sample drifted")
            for name in ("memory_swap_current_bytes", "memory_swap_peak_bytes"):
                if sample[name] is not None and sample[name] != 0:
                    fail("Slice 2E calibration observed or forged nonzero swap")
            if (
                integer(sample["ready_elapsed_ms"], "ready elapsed ms") < 0
                or sample["ready_marker"] != expected_marker
                or sample["populated_zero"] is not True
                or sample["cgroup_deleted"] is not True
            ):
                fail("Slice 2E calibration marker/readiness/cleanup drifted")
            currents.append(current)
            peaks.append(peak)
        currents.sort()
        peaks.sort()
        expected_derived = {
            "memory_current_max_bytes": currents[-1],
            "memory_current_median_bytes": currents[2],
            "memory_peak_max_bytes": peaks[-1],
            "memory_peak_median_bytes": peaks[2],
        }
        if case["derived"] != expected_derived:
            fail("Slice 2E calibration max/median derivation was missing or forged")

    expected_adjudication = recompute_adjudication(cases)
    if evidence["adjudication"] != expected_adjudication:
        fail("Slice 2E normalized adjudication/check/aggregate derivation drifted")
    if expected_adjudication["aggregate_gate"] is not True:
        fail("Slice 2E frozen memory gate failed")


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
