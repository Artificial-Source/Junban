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
# Conservative: authoritative claims require near-idle host, not merely "under 0.75*ncpu".
LOAD_BUSY_PER_CPU = 0.25
LOAD_STABLE_MAX = 2.0
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


def scan_build_confounders() -> list[dict[str, Any]]:
    """Detect cargo/rustc/node/browser processes that confound memory samples."""
    found: list[dict[str, Any]] = []
    proc = Path("/proc")
    if not proc.is_dir():
        return found
    for entry in proc.iterdir():
        if not entry.name.isdigit():
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
        tokens = set(re.split(r"[^a-z0-9_.+-]+", f"{comm} {exe} {cmdline}"))
        hits = sorted(tokens.intersection(BUILD_CONFOUNDERS))
        if not hits:
            continue
        # Ignore this harness itself.
        if "check-phase7-host-placement" in cmdline:
            continue
        found.append(
            {
                "pid": int(entry.name),
                "comm": comm,
                "exe": exe,
                "hits": hits,
                "cmdline": cmdline[:240],
            }
        )
        if len(found) >= 32:
            break
    return found


def host_contention(host: dict[str, Any]) -> dict[str, Any]:
    load1, load5, load15 = os.getloadavg()
    cpus = max(int(host.get("cpu_count") or os.cpu_count() or 1), 1)
    threshold = min(LOAD_STABLE_MAX, cpus * LOAD_BUSY_PER_CPU)
    # Swap activity is a strong contention signal on this project’s hosts.
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
    confounders = scan_build_confounders()
    reasons: list[str] = []
    if load1 > threshold:
        reasons.append(f"load1 {load1:.2f} > threshold {threshold:.2f}")
    if load5 > threshold + 0.5:
        reasons.append(f"load5 {load5:.2f} elevated")
    if swap_used_mib is not None and swap_used_mib > 256.0:
        reasons.append(f"swap_used_mib {swap_used_mib:.1f}")
    if confounders:
        reasons.append(f"build_confounders={len(confounders)}")
    contended = bool(reasons)
    return {
        "load1": load1,
        "load5": load5,
        "load15": load15,
        "cpu_count": cpus,
        "load_threshold": threshold,
        "swap_used_mib": swap_used_mib,
        "build_confounders": confounders,
        "contended": contended,
        "reason": "; ".join(reasons) if reasons else "no_contention_signals",
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

    checks = {
        "linux_cgroup_v2": True,
        "systemd_run_memory_accounting": True,
        "repo_root": str(REPO_ROOT),
        "spike_dir_exists": SPIKE_DIR.is_dir(),
        "bench_helpers_loaded": hasattr(BENCH, "read_cgroup_memory"),
        "wasmtime_pin": WASMTIME_VERSION,
        "jco_pin": JCO_VERSION,
        "componentize_js_pin": COMPONENTIZE_JS_VERSION,
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
    return {
        "path": str(out.relative_to(REPO_ROOT)),
        "sha256": sha256_file(out),
        "size_bytes": out.stat().st_size,
        "kind": "rust",
        "target": "wasm32-wasip2",
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
    return {
        "ok": True,
        "path": str(out.relative_to(REPO_ROOT)),
        "sha256": sha256_file(out),
        "size_bytes": out.stat().st_size,
        "kind": "typescript",
        "jco": JCO_VERSION,
        "componentize_js": COMPONENTIZE_JS_VERSION,
        "runtime_node": False,
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
                stages_out[name] = {
                    "response": resp,
                    "wall_ms": elapsed,
                    "memory": cgroup_snapshot(unit),
                }
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
        {"stage": "disable"},
        {"stage": "shutdown_child"},
    ]


def evaluate_decision(report: dict[str, Any]) -> dict[str, Any]:
    """Apply the frozen context-map decision rule. May leave selection unset."""
    summary = report.get("summary") or {}
    server = summary.get("server_baseline") or {}
    inprocess = summary.get("inprocess_rust") or {}
    child = summary.get("child_rust") or {}
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

    # Containment: trap/cpu/memory must show survival on both paths when present.
    def stage_survived(variant_key: str, stage: str) -> bool | None:
        samples = report.get("samples", {}).get(variant_key) or []
        if not samples:
            return None
        ok = True
        for sample in samples:
            st = ((sample.get("stages") or {}).get(stage) or {}).get("response") or {}
            if not st.get("ok", False):
                ok = False
        return ok

    for variant, label in (("inprocess_rust", "in-process"), ("child_rust", "child")):
        for stage in ("trap", "cpu_loop", "grow_memory"):
            survived = stage_survived(variant, stage)
            if survived is False:
                reasons.append(f"{label} {stage} did not cleanly report survival")
            elif survived is True:
                reasons.append(f"{label} {stage} survived")

    child_cleanup_ok = True
    for sample in report.get("samples", {}).get("child_rust") or []:
        shut = ((sample.get("stages") or {}).get("shutdown_child") or {}).get("response") or {}
        detail = shut.get("detail") or {}
        if not shut.get("ok") or not detail.get("cleaned", False):
            child_cleanup_ok = False
    if report.get("samples", {}).get("child_rust"):
        if child_cleanup_ok:
            reasons.append("child shutdown cleaned with no orphan")
        else:
            blockers.append("child shutdown left orphan or failed cleanup proof")

    # Placement selection: fault containment breaks a close tie toward child.
    selected = None
    selection_status = "undecided"
    if blockers:
        selection_status = "blocked"
    else:
        # Compare active peaks after instantiate/warm if available.
        ip_warm = (inprocess.get("after_warm_cgroup_mib") or {}).get("median")
        ch_warm = (child.get("after_warm_cgroup_mib") or {}).get("median")
        ip_peak = (inprocess.get("peak_cgroup_mib") or {}).get("max")
        ch_peak = (child.get("peak_cgroup_mib") or {}).get("max")
        if ip_warm is None or ch_warm is None:
            selection_status = "insufficient_data"
        else:
            # Close if within 15% or 4 MiB.
            delta = abs(ip_warm - ch_warm)
            close = delta <= max(4.0, 0.15 * max(ip_warm, ch_warm, 1.0))
            if close:
                selected = "on_demand_child_host"
                selection_status = "selected_by_fault_containment_tiebreak"
                reasons.append(
                    f"active warm medians close (inprocess={ip_warm:.3f}, child={ch_warm:.3f}); "
                    "context map awards fault containment to child process"
                )
            elif ch_warm < ip_warm:
                selected = "on_demand_child_host"
                selection_status = "selected_by_memory"
                reasons.append(
                    f"child active warm median {ch_warm:.3f} < in-process {ip_warm:.3f}"
                )
            else:
                # In-process only wins if it clearly beats child on memory AND
                # matched containment (already required).
                selected = "lazy_inprocess"
                selection_status = "selected_by_memory"
                reasons.append(
                    f"in-process active warm median {ip_warm:.3f} < child {ch_warm:.3f}"
                )
            if ip_peak is not None and ch_peak is not None:
                reasons.append(f"peaks inprocess={ip_peak:.3f} child={ch_peak:.3f}")

    if report.get("host_contention", {}).get("contended"):
        selection_status = f"preliminary_{selection_status}"
        reasons.append("host contended; result is preliminary and not acceptance")
    if report.get("protocol", {}).get("quick"):
        selection_status = f"quick_{selection_status}"
        reasons.append("quick mode cannot claim authoritative acceptance")

    return {
        "selected_placement": selected,
        "selection_status": selection_status,
        "reasons": reasons,
        "blockers": blockers,
        "decision_rule": (
            "Ordinary no-plugin server must stay within 24/32 MiB and not construct "
            "an Engine or spawn a host. Guest trap/CPU/memory must not stop the "
            "server. Fault containment breaks a close measurement tie toward the "
            "child process. Preliminary active ceilings use projected product totals "
            "(server baseline + max(0, variant - sdk-only)), never raw probe RSS alone."
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


def summarize_variant(samples: list[dict[str, Any]], *, active_stage: str | None) -> dict[str, Any]:
    if not samples:
        return {}
    idle_vals = []
    peak_vals = []
    active_vals = []
    startup_vals = []
    for sample in samples:
        startup_vals.append(float(sample.get("startup_to_health_ms") or 0.0))
        if "idle" in sample:
            idle_vals.append(float(sample["idle"]["cgroup_current_mib"]))
            peak_vals.append(float(sample["idle"]["cgroup_peak_mib"]))
        stages = sample.get("stages") or {}
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
    return out


def derive_measured_ceilings(summary: dict[str, Any]) -> dict[str, Any]:
    """Derive preliminary product-active ceilings from projected totals + headroom.

    Probe cgroup totals are not product server+runtime totals. Project each active
    placement as:
      projected = server_baseline + max(0, variant - sdk_only_probe)
    Then freeze preliminary ceilings from projected maxima + explicit headroom.
    Never invents 64/96-style premeasurement product budgets from raw probe RSS.
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

    rust_warm = max_projected(["inprocess_rust", "child_rust"], "projected_product_warm_mib")
    rust_peak = max_projected(["inprocess_rust", "child_rust"], "projected_product_peak_mib")
    ts_warm = max_projected(
        ["inprocess_typescript", "child_typescript"], "projected_product_warm_mib"
    )
    ts_peak = max_projected(
        ["inprocess_typescript", "child_typescript"], "projected_product_peak_mib"
    )

    def with_headroom(value: float | None, *, pct: float, floor_mib: float) -> float | None:
        if value is None:
            return None
        return round(max(value * (1.0 + pct), value + floor_mib), 4)

    return {
        "basis": (
            "projected_product = server_baseline + max(0, variant - sdk_only); "
            "ceilings = projected_maxima + explicit headroom"
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
    contention_pre = host_contention(host)
    dirty = git_dirty(REPO_ROOT)

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
                probe=probe,
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
                    probe=probe,
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
        "sdk_only": summarize_variant(samples["sdk_only"], active_stage="idle"),
        "inprocess_rust": summarize_variant(
            samples["inprocess_rust"], active_stage="warm_ping"
        ),
        "child_rust": summarize_variant(samples["child_rust"], active_stage="warm_ping"),
    }
    if "inprocess_typescript" in samples:
        summary["inprocess_typescript"] = summarize_variant(
            samples["inprocess_typescript"], active_stage="warm_ping"
        )
        summary["child_typescript"] = summarize_variant(
            samples["child_typescript"], active_stage="warm_ping"
        )

    measured_ceilings = derive_measured_ceilings(summary)
    contention_post = host_contention(host)
    contended = bool(contention_pre["contended"] or contention_post["contended"])

    authoritative = (
        not quick
        and idle_host_confirmed
        and not dirty
        and not contended
        and samples_n >= AUTHORITATIVE_SAMPLES
        and not artifacts.get("server_links_wasmtime")
        and not artifacts.get("sdk_probe_links_wasmtime")
        and bool(artifacts.get("probe_links_wasmtime"))
    )
    if quick:
        evidence_status = "preliminary_quick"
    elif not idle_host_confirmed:
        evidence_status = "preliminary_idle_host_not_confirmed"
    elif dirty or contended:
        evidence_status = "preliminary_contended_or_dirty_host"
    elif authoritative:
        evidence_status = "authoritative_candidate"
    else:
        evidence_status = "preliminary"

    report: dict[str, Any] = {
        "protocol": {
            "name": PROTOCOL_NAME,
            "version": PROTOCOL_VERSION,
            "quick": quick,
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
        "git_dirty": dirty,
        "evidence_status": evidence_status,
        "accepted": False,  # Wave 0 ADR acceptance is separate; never auto-accept.
        "artifacts": artifacts,
        "components": {
            "rust": rust_component,
            "typescript": ts_component,
        },
        "samples": samples,
        "summary": summary,
        "measured_preliminary_active_ceilings_mib": measured_ceilings,
        "command": " ".join(sys.argv),
        "run_id": uuid.uuid4().hex,
    }
    report["decision"] = evaluate_decision(report)
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
