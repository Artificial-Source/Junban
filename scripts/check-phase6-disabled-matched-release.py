#!/usr/bin/env python3
"""Phase 6 disabled matched parent/head release evidence harness.

Protocol: junban-phase6-disabled-matched-release-v1

Builds or accepts optimized Phase 5 parent-base (default 351c842) and exact-head
junban-server binaries plus matching production dist trees, then runs five
interleaved fresh-profile Phase 1 health/UI/idle samples for each side inside
transient systemd --user cgroup-v2 units on one host.

Budgets (fail closed when authoritative):
  - head maximum warm cgroup current ≤ 24 MiB
  - head maximum warm cgroup peak ≤ 32 MiB
  - head median warm growth vs parent ≤ max(15% of parent median, 1 MiB)
  - zero resident Node in every measured cgroup
  - disabled Phase 1 workload + release initial UI static closure issue no
    AI/provider/model/media request path

Does not instrument or rebuild the measured binary for AI-construction probes.
In-process zero-construction of provider clients remains a separate claim
backed by existing unit/integration tests, not by this external harness.

Authoritative status requires an idle host (see host_contention), a clean
worktree when building head from the live tree, and protocol.authoritative.
Contended-host runs are retained as preliminary and never claim the frozen gate.
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
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
BENCH_PATH = REPO_ROOT / "scripts" / "bench-hosted-server.py"

PROTOCOL_NAME = "junban-phase6-disabled-matched-release-v1"
PROTOCOL_VERSION = 1
DEFAULT_PARENT_COMMIT = "351c842b0fd5e8b346e0483d0d95b3a34fa86edc"
DEFAULT_PARENT_SHORT = "351c842"
WARM_MEMORY_CEILING_MIB = 24.0
PEAK_MEMORY_CEILING_MIB = 32.0
GROWTH_PCT = 0.15
GROWTH_FLOOR_MIB = 1.0
AUTHORITATIVE_SAMPLES = 5
QUICK_SAMPLES = 1
SETTLE_SECONDS = 2.0
LOAD_BUSY_PER_CPU = 0.75
# Reject when 1-minute load average exceeds this fraction of nproc during an
# authoritative claim. Preliminary runs still record the observed load.
DEFAULT_ARTIFACT_ROOT = Path("target/phase6-disabled-matched")
DEFAULT_EVIDENCE = Path(
    "goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json"
)

# Paths/substrings that must not appear in the disabled Phase 1 request set or
# the release initial-UI static asset closure.
FORBIDDEN_REQUEST_SUBSTRINGS = (
    "/api/v1/ai",
    "/api/v1/voice",
    "/ai-chat",
    "/settings/ai",
    "/settings/voice",
    "whisper",
    "kokoro",
    "piper",
    "silero",
    "onnxruntime",
    "transformers",
    "huggingface",
    "vad-web",
    "ort-wasm",
    "phonemize",
    "junban-local-voice",
)

# Static graph markers (file path or file body) that must stay out of the
# initial entry closure. Dynamic import targets are allowed elsewhere in dist.
INITIAL_GRAPH_FORBIDDEN_MARKERS = (
    "whisper-tiny",
    "Kokoro-82M",
    "piper-tts-web",
    "silero_vad",
    "ort-wasm-simd-threaded",
    "piper_phonemize",
    "junban-local-voice",
    "@huggingface/transformers",
    "@ricky0123/vad-web",
    "kokoro-js",
    "@mintplex-labs/piper-tts-web",
    "@diffusionstudio/piper-wasm",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "/api/v1/ai/",
    "/api/v1/voice/",
)


class HarnessError(RuntimeError):
    """Fail-closed harness error."""


def load_bench() -> Any:
    spec = importlib.util.spec_from_file_location("junban_bench_hosted_server", BENCH_PATH)
    if spec is None or spec.loader is None:
        raise HarnessError(f"cannot import bench harness: {BENCH_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cmd(
    args: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        check=False,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise HarnessError(
            f"command failed ({result.returncode}): {' '.join(args)}\n{tail}"
        )
    return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    digest = hashlib.sha256()
    paths = sorted(
        p for p in root.rglob("*") if p.is_file() and ".git" not in p.parts
    )
    for path in paths:
        rel = path.relative_to(root).as_posix()
        file_hash = sha256_file(path)
        size = path.stat().st_size
        files.append({"path": rel, "sha256": file_hash, "size_bytes": size})
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_hash.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("utf-8"))
        digest.update(b"\n")
    return {
        "root": str(root),
        "file_count": len(files),
        "total_bytes": sum(item["size_bytes"] for item in files),
        "tree_sha256": digest.hexdigest(),
        "files": files,
    }


def relative_name(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return path.name


def binary_metadata(path: Path, repo_root: Path) -> dict[str, Any]:
    resolved = path.resolve()
    return {
        "path": relative_name(resolved, repo_root),
        "size_bytes": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
    }


def resolve_commit(repo_root: Path, ref: str) -> str:
    result = run_cmd(["git", "-C", str(repo_root), "rev-parse", ref])
    return (result.stdout or "").strip()


def git_dirty(repo_root: Path) -> bool:
    result = run_cmd(
        ["git", "-C", str(repo_root), "status", "--porcelain"], check=False
    )
    return bool((result.stdout or "").strip())


def host_metadata(repo_root: Path) -> dict[str, Any]:
    uname = os.uname()
    cpu_model = None
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    rustc = run_cmd(["rustc", "--version"], check=False)
    rustc_verbose = run_cmd(["rustc", "-Vv"], check=False)
    node = run_cmd(["node", "--version"], check=False)
    pnpm = run_cmd(["pnpm", "--version"], check=False)
    commit = run_cmd(["git", "-C", str(repo_root), "rev-parse", "HEAD"], check=False)
    dirty = git_dirty(repo_root)
    loadavg = os.getloadavg() if hasattr(os, "getloadavg") else (None, None, None)
    cpu_count = os.cpu_count() or 1
    meminfo: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if ":" not in line:
                continue
            key, raw = line.split(":", 1)
            parts = raw.strip().split()
            if parts and parts[0].isdigit():
                # values are KiB
                meminfo[key] = int(parts[0]) * 1024
    except OSError:
        pass
    return {
        "hostname": uname.nodename,
        "kernel": uname.release,
        "os": f"{uname.sysname} {uname.release} {uname.machine}",
        "machine": uname.machine,
        "cpu_model": cpu_model,
        "cpu_count": cpu_count,
        "loadavg_1m": loadavg[0],
        "loadavg_5m": loadavg[1],
        "loadavg_15m": loadavg[2],
        "mem_total_bytes": meminfo.get("MemTotal"),
        "mem_available_bytes": meminfo.get("MemAvailable"),
        "swap_total_bytes": meminfo.get("SwapTotal"),
        "swap_free_bytes": meminfo.get("SwapFree"),
        "rustc_version": (rustc.stdout or "").strip() or None,
        "rustc_verbose": (rustc_verbose.stdout or "").strip() or None,
        "node_version": (node.stdout or "").strip() or None,
        "pnpm_version": (pnpm.stdout or "").strip() or None,
        "git_commit": (commit.stdout or "").strip() or None,
        "git_dirty": dirty,
        "cgroup": "v2" if Path("/sys/fs/cgroup/cgroup.controllers").is_file() else "unknown",
    }


def host_contention(host: dict[str, Any]) -> dict[str, Any]:
    cpu_count = int(host.get("cpu_count") or 1)
    load1 = host.get("loadavg_1m")
    mem_avail = host.get("mem_available_bytes")
    swap_total = host.get("swap_total_bytes") or 0
    swap_free = host.get("swap_free_bytes")
    reasons: list[str] = []
    busy = False
    if isinstance(load1, (int, float)) and load1 > cpu_count * LOAD_BUSY_PER_CPU:
        busy = True
        reasons.append(
            f"loadavg_1m {load1:.2f} > {cpu_count}*{LOAD_BUSY_PER_CPU:.2f}"
        )
    if isinstance(mem_avail, int) and mem_avail < 2 * 1024 * 1024 * 1024:
        busy = True
        reasons.append(f"mem_available_bytes {mem_avail} < 2 GiB")
    if (
        isinstance(swap_total, int)
        and swap_total > 0
        and isinstance(swap_free, int)
        and swap_free < swap_total * 0.35
    ):
        busy = True
        reasons.append("swap heavily used (<35% free)")
    return {
        "contended": busy,
        "idle_required_for_authoritative": True,
        "load_busy_per_cpu_threshold": LOAD_BUSY_PER_CPU,
        "reasons": reasons,
    }


def growth_budget_mib(parent_median_mib: float) -> float:
    return max(GROWTH_FLOOR_MIB, GROWTH_PCT * parent_median_mib)


def series_summary(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "min": ordered[0],
        "max": ordered[-1],
        "median": statistics.median(ordered),
        "mean": statistics.fmean(ordered),
    }


def protocol_config(*, quick: bool, parent_commit: str, head_commit: str) -> dict[str, Any]:
    samples = QUICK_SAMPLES if quick else AUTHORITATIVE_SAMPLES
    return {
        "name": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "mode": "phase6_disabled_matched",
        "authoritative": not quick,
        "quick": quick,
        "samples_per_side": samples,
        "interleave": "parent_then_head_per_index",
        "phase1_workload": "junban-phase1-hosted-server-v1 exact health/UI/idle",
        "phase1_task_count": 10 if quick else 100,
        "phase1_mutation_cycles": 5 if quick else 20,
        "phase1_static_reads": 5 if quick else 20,
        "phase1_list_reads": 5 if quick else 20,
        "settle_seconds": SETTLE_SECONDS,
        "bind": "127.0.0.1:0",
        "profile_mode": "0700",
        "cgroup": "transient systemd --user service with MemoryAccounting=yes",
        "driver_outside_cgroup": True,
        "parent_commit": parent_commit,
        "head_commit": head_commit,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "growth_rule": (
            "exact-head median warm cgroup current growth versus parent "
            "≤ max(15% of parent median, 1 MiB)"
        ),
        "growth_pct": GROWTH_PCT,
        "growth_floor_mib": GROWTH_FLOOR_MIB,
        "node_rejection": list(sorted({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})),
        "ui_request_proof": (
            "release initial UI static closure from dist manifest/index.html "
            "plus exact Phase 1 request paths; no binary instrumentation"
        ),
        "zero_construction_claim": (
            "external harness cannot observe in-process AI HTTP client "
            "construction without changing the measured binary; see separate "
            "unit/integration evidence"
        ),
        "notes": [
            "Optimized release junban-server + matching production dist only.",
            "Samples interleave parent/head on one host to reduce drift.",
            "Quick mode and contended-host runs cannot provide authoritative evidence.",
            "Authoritative status also requires host_contention.contended == false.",
        ],
    }


def ensure_executable(path: Path, label: str) -> None:
    if not path.is_file() or not os.access(path, os.X_OK):
        raise HarnessError(f"{label} missing or not executable: {path}")


def ensure_web_dir(path: Path, label: str) -> None:
    if not path.is_dir() or not (path / "index.html").is_file():
        raise HarnessError(f"{label} web-dir missing index.html: {path}")


def write_stamp(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_stamp(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def build_side(
    *,
    label: str,
    commit: str,
    source_root: Path,
    artifact_dir: Path,
    repo_root: Path,
    use_worktree: bool,
) -> dict[str, Any]:
    """Build optimized server + dist for one side into artifact_dir."""
    artifact_dir.mkdir(parents=True, exist_ok=True)
    server_out = artifact_dir / "junban-server"
    web_out = artifact_dir / "dist"
    stamp_path = artifact_dir / "artifact-stamp.json"

    work_root: Path | None = None
    build_root = source_root
    try:
        if use_worktree:
            work_root = Path(
                tempfile.mkdtemp(prefix=f"junban-p6-{label}-{commit[:12]}-", dir="/tmp")
            )
            run_cmd(
                [
                    "git",
                    "-C",
                    str(repo_root),
                    "worktree",
                    "add",
                    "--detach",
                    str(work_root),
                    commit,
                ]
            )
            build_root = work_root

        env = os.environ.copy()
        # Keep parent/head cargo outputs isolated when building from a worktree.
        target_dir = artifact_dir / "cargo-target"
        env["CARGO_TARGET_DIR"] = str(target_dir)

        print(f"building {label} at {commit[:12]} in {build_root}", file=sys.stderr)
        run_cmd(["pnpm", "install", "--frozen-lockfile"], cwd=build_root, env=env, timeout=60 * 30)
        run_cmd(["pnpm", "build"], cwd=build_root, env=env, timeout=60 * 20)
        run_cmd(
            ["cargo", "build", "--locked", "--release", "-p", "junban-server"],
            cwd=build_root,
            env=env,
            timeout=60 * 45,
        )

        built_server = target_dir / "release" / "junban-server"
        if not built_server.is_file():
            # When not isolating target, fall back to default target path.
            built_server = build_root / "target" / "release" / "junban-server"
        ensure_executable(built_server, f"{label} server")
        built_dist = build_root / "dist"
        ensure_web_dir(built_dist, label)

        shutil.copy2(built_server, server_out)
        os.chmod(server_out, 0o755)
        copy_tree(built_dist, web_out)

        stamp = {
            "label": label,
            "commit": commit,
            "built_at_unix": time.time(),
            "server_sha256": sha256_file(server_out),
            "server_size_bytes": server_out.stat().st_size,
            "dist_tree_sha256": sha256_tree(web_out)["tree_sha256"],
            "rustc_version": (
                run_cmd(["rustc", "--version"], check=False).stdout or ""
            ).strip(),
            "node_version": (
                run_cmd(["node", "--version"], check=False).stdout or ""
            ).strip(),
            "pnpm_version": (
                run_cmd(["pnpm", "--version"], check=False).stdout or ""
            ).strip(),
        }
        write_stamp(stamp_path, stamp)
        # Drop bulky cargo target after copy to save disk; optional keep via env.
        if env.get("JUNBAN_KEEP_PHASE6_CARGO_TARGET") != "1" and target_dir.exists():
            shutil.rmtree(target_dir, ignore_errors=True)
        return stamp
    finally:
        if work_root is not None:
            run_cmd(
                ["git", "-C", str(repo_root), "worktree", "remove", "--force", str(work_root)],
                check=False,
            )
            shutil.rmtree(work_root, ignore_errors=True)


def accept_or_build_side(
    *,
    label: str,
    commit: str,
    server: Path | None,
    web_dir: Path | None,
    artifact_root: Path,
    repo_root: Path,
    build: bool,
    allow_build_head_dirty: bool,
) -> dict[str, Any]:
    side_dir = artifact_root / label
    stamp_path = side_dir / "artifact-stamp.json"

    if server is not None or web_dir is not None:
        if server is None or web_dir is None:
            raise HarnessError(f"{label}: provide both --{label}-server and --{label}-web-dir")
        ensure_executable(server, f"{label} server")
        ensure_web_dir(web_dir, label)
        side_dir.mkdir(parents=True, exist_ok=True)
        server_out = side_dir / "junban-server"
        web_out = side_dir / "dist"
        if server.resolve() != server_out.resolve():
            shutil.copy2(server, server_out)
            os.chmod(server_out, 0o755)
        if web_dir.resolve() != web_out.resolve():
            copy_tree(web_dir, web_out)
        stamp = {
            "label": label,
            "commit": commit,
            "source": "accepted_prebuilt",
            "server_sha256": sha256_file(server_out),
            "server_size_bytes": server_out.stat().st_size,
            "dist_tree_sha256": sha256_tree(web_out)["tree_sha256"],
            "accepted_server_path": relative_name(server, repo_root),
            "accepted_web_dir": relative_name(web_dir, repo_root),
        }
        write_stamp(stamp_path, stamp)
    else:
        existing = read_stamp(stamp_path)
        server_out = side_dir / "junban-server"
        web_out = side_dir / "dist"
        reusable = (
            existing
            and existing.get("commit") == commit
            and server_out.is_file()
            and web_out.is_dir()
            and (web_out / "index.html").is_file()
            and existing.get("server_sha256") == sha256_file(server_out)
            and existing.get("dist_tree_sha256") == sha256_tree(web_out)["tree_sha256"]
        )
        if reusable:
            stamp = dict(existing)
            stamp["source"] = "cache_hit"
            print(f"{label}: reusing cached artifacts for {commit[:12]}", file=sys.stderr)
        else:
            if not build:
                raise HarnessError(
                    f"{label}: artifacts missing for {commit[:12]}; pass --build "
                    f"or --{label}-server/--{label}-web-dir"
                )
            if label == "head" and git_dirty(repo_root) and not allow_build_head_dirty:
                raise HarnessError(
                    "refusing to build head from a dirty worktree without "
                    "--allow-build-head-dirty (authoritative evidence still rejects dirty trees)"
                )
            use_worktree = label == "parent" or resolve_commit(repo_root, "HEAD") != commit
            stamp = build_side(
                label=label,
                commit=commit,
                source_root=repo_root if label == "head" and not use_worktree else repo_root,
                artifact_dir=side_dir,
                repo_root=repo_root,
                use_worktree=use_worktree,
            )
            stamp["source"] = "built"
            # When building head from the live tree without worktree isolation,
            # build_side with use_worktree=False uses source_root target unless
            # CARGO_TARGET_DIR is set — build_side always sets it under side_dir.
            if not use_worktree and label == "head":
                # Rebuild path already handled inside build_side via worktree flag.
                pass

    server_path = side_dir / "junban-server"
    web_path = side_dir / "dist"
    ensure_executable(server_path, f"{label} server")
    ensure_web_dir(web_path, label)
    dist_meta = sha256_tree(web_path)
    return {
        "label": label,
        "commit": commit,
        "server": server_path,
        "web_dir": web_path,
        "binary": binary_metadata(server_path, repo_root),
        "dist": {
            "path": relative_name(web_path, repo_root),
            "file_count": dist_meta["file_count"],
            "total_bytes": dist_meta["total_bytes"],
            "tree_sha256": dist_meta["tree_sha256"],
        },
        "stamp": read_stamp(stamp_path) or stamp,
    }


def find_manifest(web_dir: Path) -> Path | None:
    for candidate in (web_dir / ".vite" / "manifest.json", web_dir / "manifest.json"):
        if candidate.is_file():
            return candidate
    return None


def initial_static_closure(web_dir: Path) -> dict[str, Any]:
    """Compute the release initial UI static asset closure without executing JS."""
    index_html = web_dir / "index.html"
    if not index_html.is_file():
        raise HarnessError(f"missing index.html in {web_dir}")
    index_text = index_html.read_text(encoding="utf-8")
    requested: list[str] = ["/", "/index.html"]
    forbidden_hits: list[dict[str, str]] = []

    def note_path(path: str, source: str) -> None:
        normalized = path.split("?", 1)[0].split("#", 1)[0]
        if not normalized:
            return
        if normalized.startswith("http://") or normalized.startswith("https://"):
            # External absolute URL in the shell — record and classify.
            rel = normalized
        else:
            rel = normalized if normalized.startswith("/") else f"/{normalized.lstrip('./')}"
        if rel not in requested:
            requested.append(rel)
        lowered = rel.lower()
        body_lower = ""
        for marker in FORBIDDEN_REQUEST_SUBSTRINGS:
            if marker in lowered:
                forbidden_hits.append(
                    {"path": rel, "marker": marker, "source": source, "where": "path"}
                )
        # Also scan file body for engine markers when local.
        local = web_dir / rel.lstrip("/")
        if local.is_file() and local.suffix in {".js", ".mjs", ".css", ".html"}:
            try:
                body_lower = local.read_text(encoding="utf-8", errors="replace").lower()
            except OSError:
                body_lower = ""
            for marker in INITIAL_GRAPH_FORBIDDEN_MARKERS:
                if marker.lower() in body_lower:
                    forbidden_hits.append(
                        {
                            "path": rel,
                            "marker": marker,
                            "source": source,
                            "where": "body",
                        }
                    )

    for match in re.finditer(
        r"""<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']""",
        index_text,
        flags=re.IGNORECASE,
    ):
        note_path(match.group(1), "index.html")

    manifest_path = find_manifest(web_dir)
    closure_keys: list[str] = []
    if manifest_path is not None:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        seen: set[str] = set()

        def add_closure(key: str) -> None:
            if not key or key in seen:
                return
            entry = manifest.get(key)
            if not isinstance(entry, dict):
                # Direct file path key
                if key not in seen:
                    seen.add(key)
                    closure_keys.append(key)
                    note_path(key, "manifest")
                return
            seen.add(key)
            closure_keys.append(key)
            file_name = entry.get("file")
            if isinstance(file_name, str):
                note_path(file_name, "manifest")
            for css in entry.get("css") or []:
                if isinstance(css, str):
                    note_path(css, "manifest-css")
            for imp in entry.get("imports") or []:
                if isinstance(imp, str):
                    add_closure(imp)
            # Deliberately ignore dynamicImports — those load only after navigation.

        for key, entry in manifest.items():
            if isinstance(entry, dict) and entry.get("isEntry"):
                add_closure(key)
        # Seed from script tags as well.
        for match in re.finditer(
            r"""<script[^>]+src=["']([^"']+)["']""", index_text, flags=re.IGNORECASE
        ):
            src = match.group(1).lstrip("/")
            for key, entry in manifest.items():
                if isinstance(entry, dict) and entry.get("file") == src:
                    add_closure(key)
            add_closure(src)

    # De-duplicate forbidden hits
    uniq: list[dict[str, str]] = []
    seen_hit: set[tuple[str, str, str]] = set()
    for hit in forbidden_hits:
        key = (hit["path"], hit["marker"], hit["where"])
        if key in seen_hit:
            continue
        seen_hit.add(key)
        uniq.append(hit)

    return {
        "index_html_sha256": sha256_file(index_html),
        "manifest_present": manifest_path is not None,
        "manifest_path": (
            manifest_path.relative_to(web_dir).as_posix() if manifest_path else None
        ),
        "static_paths": requested,
        "manifest_closure_keys": closure_keys,
        "forbidden_hits": uniq,
        "passed": len(uniq) == 0,
        "method": (
            "static HTML + Vite manifest import closure only; "
            "dynamicImport targets are not fetched"
        ),
    }


def capture_phase1_request_paths(protocol: dict[str, Any]) -> list[str]:
    """Exact path set issued by the frozen Phase 1 workload (no server needed)."""
    paths = {"/api/v1/health", "/", "/index.html", "/api/v1/tasks?limit=100"}
    # Creates/list/mutations use /api/v1/tasks and /api/v1/tasks/{id}...
    paths.add("/api/v1/tasks")
    paths.add("/api/v1/tasks/{id}")
    paths.add("/api/v1/tasks/{id}/complete")
    paths.add("/api/v1/tasks/{id}/uncomplete")
    _ = protocol  # knobs do not introduce AI routes
    return sorted(paths)


def classify_request_paths(paths: list[str]) -> dict[str, Any]:
    hits: list[dict[str, str]] = []
    for path in paths:
        lowered = path.lower()
        for marker in FORBIDDEN_REQUEST_SUBSTRINGS:
            if marker in lowered:
                hits.append({"path": path, "marker": marker})
    return {
        "paths": paths,
        "forbidden_hits": hits,
        "passed": len(hits) == 0,
    }


def run_ui_request_probe(
    bench: Any,
    *,
    side: dict[str, Any],
    repo_root: Path,
    run_id: str,
) -> dict[str, Any]:
    """Fetch the initial static closure through the live release server.

    Records every HTTP path the probe issues. Does not execute JavaScript, open
    media devices, or call AI APIs. Complements the offline graph walk.
    """
    static = initial_static_closure(side["web_dir"])
    profile_dir = Path(
        tempfile.mkdtemp(prefix=f"junban-p6-ui-{side['label']}-", dir="/tmp")
    )
    os.chmod(profile_dir, 0o700)
    token = hashlib.sha256(f"ui-probe:{run_id}:{side['label']}".encode()).hexdigest() + "00"
    bench.prepare_profile(profile_dir, token)
    unit = f"junban-p6-ui-{run_id}-{side['label']}"[:180]
    issued: list[str] = []
    started = False
    try:
        base_url, host, startup_ms = bench.start_server(
            unit, side["server"], profile_dir, side["web_dir"], repo_root
        )
        started = True
        # Always hit the shell entry points.
        for path in ("/", "/index.html"):
            bench.http_request(
                "GET",
                f"{base_url}{path}",
                headers={"Host": host},
                expect_statuses={200},
                as_json=False,
            )
            issued.append(path)
        # Fetch each local static path discovered offline (skip templates).
        for path in static["static_paths"]:
            if path in {"/", "/index.html"}:
                continue
            if "{" in path or path.startswith("http://") or path.startswith("https://"):
                continue
            local = side["web_dir"] / path.lstrip("/")
            if not local.is_file():
                continue
            bench.http_request(
                "GET",
                f"{base_url}{path}",
                headers={"Host": host},
                expect_statuses={200},
                as_json=False,
            )
            issued.append(path)
        live = classify_request_paths(issued)
        return {
            "side": side["label"],
            "commit": side["commit"],
            "startup_to_health_ms": startup_ms,
            "offline_static_closure": static,
            "live_initial_ui_requests": live,
            "passed": static["passed"] and live["passed"],
        }
    finally:
        if started:
            try:
                bench.stop_server(unit, profile_dir)
            except bench.BenchError:
                pass
        shutil.rmtree(profile_dir, ignore_errors=True)


def median_warm(samples: list[dict[str, Any]]) -> float:
    return float(statistics.median([float(s["warm"]["cgroup_current_mib"]) for s in samples]))


def max_warm(samples: list[dict[str, Any]]) -> float:
    return max(float(s["warm"]["cgroup_current_mib"]) for s in samples)


def max_peak(samples: list[dict[str, Any]]) -> float:
    return max(float(s["warm"]["cgroup_peak_mib"]) for s in samples)


def summarize_side(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def collect(path: tuple[str, ...]) -> list[float]:
        out: list[float] = []
        for sample in samples:
            cursor: Any = sample
            for key in path:
                cursor = cursor[key]
            out.append(float(cursor))
        return out

    summary = {
        "sample_count": len(samples),
        "startup_to_health_ms": series_summary(collect(("startup_to_health_ms",))),
        "idle_cgroup_mib": series_summary(collect(("idle", "cgroup_current_mib"))),
        "idle_cgroup_peak_mib": series_summary(collect(("idle", "cgroup_peak_mib"))),
        "idle_rss_mib": series_summary(collect(("idle", "rss_mib"))),
        "idle_pss_mib": series_summary(collect(("idle", "pss_mib"))),
        "warm_cgroup_mib": series_summary(collect(("warm", "cgroup_current_mib"))),
        "warm_cgroup_peak_mib": series_summary(collect(("warm", "cgroup_peak_mib"))),
        "warm_rss_mib": series_summary(collect(("warm", "rss_mib"))),
        "warm_pss_mib": series_summary(collect(("warm", "pss_mib"))),
        "sqlite_total_bytes": series_summary(
            [float(s["sqlite"]["total_bytes"]) for s in samples]
        ),
        "process_count_ok": all(
            int(s["idle"]["process_count"]) == 1 and int(s["warm"]["process_count"]) == 1
            for s in samples
        ),
        "cleanup_ok": all(bool(s.get("cleanup_success")) for s in samples),
    }
    summary["absolute_budget_passed"] = (
        summary["warm_cgroup_mib"]["max"] <= WARM_MEMORY_CEILING_MIB
        and summary["warm_cgroup_peak_mib"]["max"] <= PEAK_MEMORY_CEILING_MIB
    )
    return summary


def evaluate_budgets(
    *,
    parent_summary: dict[str, Any],
    head_summary: dict[str, Any],
    ui_proof: dict[str, Any],
    phase1_paths: dict[str, Any],
) -> dict[str, Any]:
    parent_median = float(parent_summary["warm_cgroup_mib"]["median"])
    head_median = float(head_summary["warm_cgroup_mib"]["median"])
    allowed = growth_budget_mib(parent_median)
    delta = head_median - parent_median
    growth_ok = delta <= allowed + 1e-9
    head_abs_ok = bool(head_summary["absolute_budget_passed"])
    process_ok = bool(parent_summary["process_count_ok"] and head_summary["process_count_ok"])
    cleanup_ok = bool(parent_summary["cleanup_ok"] and head_summary["cleanup_ok"])
    ui_ok = bool(ui_proof.get("passed"))
    paths_ok = bool(phase1_paths.get("passed"))
    budget_passed = all((growth_ok, head_abs_ok, process_ok, cleanup_ok, ui_ok, paths_ok))
    return {
        "parent_median_warm_mib": parent_median,
        "head_median_warm_mib": head_median,
        "head_max_warm_mib": float(head_summary["warm_cgroup_mib"]["max"]),
        "head_max_peak_mib": float(head_summary["warm_cgroup_peak_mib"]["max"]),
        "median_warm_delta_mib": delta,
        "median_warm_growth_allowed_mib": allowed,
        "growth_passed": growth_ok,
        "head_absolute_passed": head_abs_ok,
        "process_count_passed": process_ok,
        "cleanup_passed": cleanup_ok,
        "ui_request_proof_passed": ui_ok,
        "phase1_path_proof_passed": paths_ok,
        "warm_memory_ceiling_mib": WARM_MEMORY_CEILING_MIB,
        "peak_memory_ceiling_mib": PEAK_MEMORY_CEILING_MIB,
        "budget_passed": budget_passed,
    }


def self_check() -> None:
    assert PROTOCOL_NAME == "junban-phase6-disabled-matched-release-v1"
    assert PROTOCOL_VERSION == 1
    assert AUTHORITATIVE_SAMPLES == 5
    assert QUICK_SAMPLES == 1
    assert WARM_MEMORY_CEILING_MIB == 24.0
    assert PEAK_MEMORY_CEILING_MIB == 32.0
    assert abs(growth_budget_mib(10.0) - 1.5) < 1e-9  # 15% of 10 = 1.5 > 1.0
    assert abs(growth_budget_mib(4.0) - 1.0) < 1e-9  # floor
    assert abs(growth_budget_mib(20.0) - 3.0) < 1e-9
    # Growth gate examples
    parent = {
        "warm_cgroup_mib": {"median": 10.0, "max": 10.5},
        "warm_cgroup_peak_mib": {"max": 11.0},
        "absolute_budget_passed": True,
        "process_count_ok": True,
        "cleanup_ok": True,
    }
    head_ok = {
        "warm_cgroup_mib": {"median": 11.2, "max": 11.5},
        "warm_cgroup_peak_mib": {"max": 12.0},
        "absolute_budget_passed": True,
        "process_count_ok": True,
        "cleanup_ok": True,
    }
    head_fail_growth = {
        "warm_cgroup_mib": {"median": 13.0, "max": 13.1},
        "warm_cgroup_peak_mib": {"max": 14.0},
        "absolute_budget_passed": True,
        "process_count_ok": True,
        "cleanup_ok": True,
    }
    head_fail_abs = {
        "warm_cgroup_mib": {"median": 10.2, "max": 25.0},
        "warm_cgroup_peak_mib": {"max": 26.0},
        "absolute_budget_passed": False,
        "process_count_ok": True,
        "cleanup_ok": True,
    }
    ui_ok = {"passed": True}
    paths_ok = {"passed": True}
    assert evaluate_budgets(
        parent_summary=parent, head_summary=head_ok, ui_proof=ui_ok, phase1_paths=paths_ok
    )["budget_passed"]
    assert not evaluate_budgets(
        parent_summary=parent,
        head_summary=head_fail_growth,
        ui_proof=ui_ok,
        phase1_paths=paths_ok,
    )["budget_passed"]
    assert not evaluate_budgets(
        parent_summary=parent,
        head_summary=head_fail_abs,
        ui_proof=ui_ok,
        phase1_paths=paths_ok,
    )["budget_passed"]
    assert not evaluate_budgets(
        parent_summary=parent,
        head_summary=head_ok,
        ui_proof={"passed": False},
        phase1_paths=paths_ok,
    )["budget_passed"]

    # Phase 1 path set must not include AI routes.
    paths = capture_phase1_request_paths(protocol_config(quick=True, parent_commit="p", head_commit="h"))
    classified = classify_request_paths(paths)
    assert classified["passed"]
    assert "/api/v1/tasks" in classified["paths"]
    assert not any("/api/v1/ai" in p for p in classified["paths"])

    # Forbidden classifier catches AI paths.
    bad = classify_request_paths(["/api/v1/ai/sessions", "/assets/index.js"])
    assert not bad["passed"]

    # Host contention helper.
    busy = host_contention(
        {
            "cpu_count": 4,
            "loadavg_1m": 5.0,
            "mem_available_bytes": 8 * 1024**3,
            "swap_total_bytes": 0,
            "swap_free_bytes": 0,
        }
    )
    assert busy["contended"] is True
    idle = host_contention(
        {
            "cpu_count": 20,
            "loadavg_1m": 1.0,
            "mem_available_bytes": 8 * 1024**3,
            "swap_total_bytes": 1024,
            "swap_free_bytes": 1024,
        }
    )
    assert idle["contended"] is False

    # Offline static closure against a tiny synthetic dist.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "index.html").write_text(
            '<!doctype html><script type="module" src="/assets/index.js"></script>\n',
            encoding="utf-8",
        )
        assets = root / "assets"
        assets.mkdir()
        (assets / "index.js").write_text("console.log('shell')\n", encoding="utf-8")
        (root / ".vite").mkdir()
        (root / ".vite" / "manifest.json").write_text(
            json.dumps(
                {
                    "index.html": {
                        "file": "assets/index.js",
                        "isEntry": True,
                        "imports": [],
                        "dynamicImports": ["assets/ai-lazy.js"],
                    },
                    "assets/ai-lazy.js": {
                        "file": "assets/ai-lazy.js",
                        "isDynamicEntry": True,
                    },
                }
            ),
            encoding="utf-8",
        )
        # Lazy chunk exists but must not enter initial closure body scan via imports.
        (assets / "ai-lazy.js").write_text(
            'import "@huggingface/transformers";\n', encoding="utf-8"
        )
        closure = initial_static_closure(root)
        assert closure["passed"], closure
        assert "/assets/index.js" in closure["static_paths"]
        # dynamicImport target not required in static_paths
        assert not any("ai-lazy" in p for p in closure["static_paths"])

        # Polluting the initial entry fails closed.
        (assets / "index.js").write_text(
            'import "@huggingface/transformers";\n', encoding="utf-8"
        )
        polluted = initial_static_closure(root)
        assert not polluted["passed"]

    # Bench module imports and Phase 1 protocol knobs remain frozen.
    bench = load_bench()
    phase1 = bench.protocol_config(False)
    assert phase1["name"] == "junban-phase1-hosted-server-v1"
    assert phase1["samples"] == 5 and phase1["task_count"] == 100
    phase1_q = bench.protocol_config(True)
    assert phase1_q["samples"] == 1 and phase1_q["task_count"] == 10
    assert BENCH_PATH.is_file()


def run_interleaved_samples(
    bench: Any,
    *,
    parent: dict[str, Any],
    head: dict[str, Any],
    repo_root: Path,
    protocol: dict[str, Any],
    run_id: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    phase1 = bench.protocol_config(bool(protocol["quick"]))
    # Force sample count from matched protocol (quick=1 / authoritative=5).
    phase1 = dict(phase1)
    phase1["samples"] = protocol["samples_per_side"]

    work_root = Path(tempfile.mkdtemp(prefix=f"junban-p6-matched-{run_id}-", dir="/tmp"))
    os.chmod(work_root, 0o700)
    parent_samples: list[dict[str, Any]] = []
    head_samples: list[dict[str, Any]] = []
    ordering: list[dict[str, Any]] = []
    try:
        for index in range(protocol["samples_per_side"]):
            for side in (parent, head):
                label = side["label"]
                print(
                    f"sample {index} {label}: starting ({side['commit'][:12]})",
                    file=sys.stderr,
                )
                sample = bench.run_sample(
                    index,
                    f"{run_id}-{label}",
                    repo_root,
                    side["server"],
                    side["web_dir"],
                    work_root / label,
                    phase1,
                )
                sample = dict(sample)
                sample["side"] = label
                sample["commit"] = side["commit"]
                sample["binary_sha256"] = side["binary"]["sha256"]
                sample["dist_tree_sha256"] = side["dist"]["tree_sha256"]
                sample["global_order"] = len(ordering)
                if label == "parent":
                    parent_samples.append(sample)
                else:
                    head_samples.append(sample)
                ordering.append(
                    {
                        "global_order": sample["global_order"],
                        "sample_index": index,
                        "side": label,
                        "commit": side["commit"],
                        "warm_cgroup_mib": sample["warm"]["cgroup_current_mib"],
                        "peak_cgroup_mib": sample["warm"]["cgroup_peak_mib"],
                        "startup_to_health_ms": sample["startup_to_health_ms"],
                    }
                )
                print(
                    f"sample {index} {label}: "
                    f"startup={sample['startup_to_health_ms']:.1f}ms "
                    f"idle={sample['idle']['cgroup_current_mib']:.2f}MiB "
                    f"warm={sample['warm']['cgroup_current_mib']:.2f}MiB "
                    f"peak={sample['warm']['cgroup_peak_mib']:.2f}MiB",
                    file=sys.stderr,
                )
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
    return parent_samples, head_samples, ordering


def sanitize_evidence_text(text: str, repo_root: Path) -> str:
    """Redact host-local absolute paths and home directories from retained evidence."""
    cleaned = text
    replacements = [
        (str(repo_root.resolve()), "<repo>"),
        (str(repo_root), "<repo>"),
        (str(Path.home()), "<home>"),
        ("/tmp/", "/tmp/"),  # keep /tmp prefix but trim agent ids below
    ]
    for old, new in replacements[:3]:
        if old:
            cleaned = cleaned.replace(old, new)
    # Collapse transient work dirs: /tmp/junban-... and /tmp/pi-agent-...
    cleaned = re.sub(r"/tmp/junban-[A-Za-z0-9._-]+", "/tmp/junban-<run>", cleaned)
    cleaned = re.sub(r"/tmp/pi-agent-[A-Za-z0-9._-]+", "/tmp/pi-agent-<worktree>", cleaned)
    cleaned = re.sub(r"/tmp/phase6-[A-Za-z0-9._-]+", "/tmp/phase6-<run>", cleaned)
    return cleaned


def sanitize_structure(value: Any, repo_root: Path) -> Any:
    if isinstance(value, str):
        return sanitize_evidence_text(value, repo_root)
    if isinstance(value, list):
        return [sanitize_structure(item, repo_root) for item in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key == "hostname" and isinstance(item, str):
                out[key] = "<benchmark-host>"
            else:
                out[key] = sanitize_structure(item, repo_root)
        return out
    return value


def build_report(
    *,
    protocol: dict[str, Any],
    host: dict[str, Any],
    contention: dict[str, Any],
    parent: dict[str, Any],
    head: dict[str, Any],
    parent_samples: list[dict[str, Any]],
    head_samples: list[dict[str, Any]],
    ordering: list[dict[str, Any]],
    ui_proof: dict[str, Any],
    phase1_paths: dict[str, Any],
    budgets: dict[str, Any],
    run_id: str,
    argv: list[str],
    zero_construction: dict[str, Any],
    repo_root: Path,
) -> dict[str, Any]:
    parent_summary = summarize_side(parent_samples)
    head_summary = summarize_side(head_samples)

    authoritative_intent = bool(protocol["authoritative"])
    dirty = bool(host.get("git_dirty"))
    contended = bool(contention.get("contended"))
    if authoritative_intent and not dirty and not contended and budgets["budget_passed"]:
        status = "authoritative_passed"
    elif authoritative_intent and budgets["budget_passed"] and (dirty or contended):
        status = "preliminary_passed_contended_or_dirty_host"
    elif authoritative_intent:
        status = "authoritative_failed" if not (dirty or contended) else "preliminary_failed"
    else:
        status = "non_authoritative_dry_run"

    accepted = status == "authoritative_passed"
    report = {
        "protocol": protocol,
        "run_id": run_id,
        "evidence_status": status,
        "accepted": accepted,
        "host": host,
        "host_contention": contention,
        "command": {
            "argv": [Path(__file__).name, *argv],
            "cwd": relative_name(Path.cwd(), repo_root)
            if Path.cwd().resolve() == repo_root.resolve()
            else "<cwd>",
        },
        "artifacts": {
            "parent": {
                "commit": parent["commit"],
                "binary": parent["binary"],
                "dist": parent["dist"],
                "stamp": parent.get("stamp"),
            },
            "head": {
                "commit": head["commit"],
                "binary": head["binary"],
                "dist": head["dist"],
                "stamp": head.get("stamp"),
            },
        },
        "sample_ordering": ordering,
        "samples": {"parent": parent_samples, "head": head_samples},
        "summary": {
            "parent": parent_summary,
            "head": head_summary,
            "budgets": budgets,
        },
        "disabled_request_proof": {
            "phase1_workload_paths": phase1_paths,
            "head_initial_ui": ui_proof,
            "passed": bool(phase1_paths.get("passed") and ui_proof.get("passed")),
        },
        "zero_construction_claim": zero_construction,
        "authoritative_rerun": {
            "required_when": (
                "host_contention.contended or git_dirty or evidence_status != "
                "authoritative_passed"
            ),
            "preconditions": [
                "idle Linux host with cgroup v2 and systemd --user",
                "clean git worktree at the exact head commit under test",
                "parent/head optimized artifacts built or accepted for the exact commits",
            ],
            "command": (
                "python3 scripts/check-phase6-disabled-matched-release.py --build "
                f"--output {DEFAULT_EVIDENCE.as_posix()}"
            ),
        },
    }
    return sanitize_structure(report, repo_root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Phase 6 disabled matched parent/head release evidence "
            f"({PROTOCOL_NAME})"
        )
    )
    parser.add_argument(
        "--parent-commit",
        default=DEFAULT_PARENT_COMMIT,
        help=f"Phase 5 parent base commit (default {DEFAULT_PARENT_SHORT})",
    )
    parser.add_argument(
        "--head-commit",
        default="HEAD",
        help="Exact head commit to measure (default HEAD)",
    )
    parser.add_argument("--parent-server", type=Path, default=None)
    parser.add_argument("--parent-web-dir", type=Path, default=None)
    parser.add_argument("--head-server", type=Path, default=None)
    parser.add_argument("--head-web-dir", type=Path, default=None)
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=DEFAULT_ARTIFACT_ROOT,
        help="Cache directory for built/accepted parent and head artifacts",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="Build missing parent/head optimized server+dist artifacts",
    )
    parser.add_argument(
        "--allow-build-head-dirty",
        action="store_true",
        help="Allow building head artifacts from a dirty worktree (never authoritative)",
    )
    parser.add_argument(
        "--skip-ui-probe",
        action="store_true",
        help="Skip live initial-UI fetch probe (still runs offline graph proof)",
    )
    parser.add_argument("--quick", action="store_true", help="1 interleaved pair; not evidence")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)
    repo_root = REPO_ROOT

    if args.self_check:
        try:
            self_check()
        except AssertionError as error:
            print(f"self-check failed: {error}", file=sys.stderr)
            return 1
        print("self-check passed", file=sys.stderr)
        return 0

    try:
        bench = load_bench()
        bench.require_linux_cgroup_v2()

        parent_commit = resolve_commit(repo_root, args.parent_commit)
        head_commit = resolve_commit(repo_root, args.head_commit)
        host = host_metadata(repo_root)
        # Record the resolved head commit under test, not only live HEAD.
        host["measured_parent_commit"] = parent_commit
        host["measured_head_commit"] = head_commit
        contention = host_contention(host)

        artifact_root = (
            args.artifact_root
            if args.artifact_root.is_absolute()
            else repo_root / args.artifact_root
        )
        parent = accept_or_build_side(
            label="parent",
            commit=parent_commit,
            server=(
                args.parent_server
                if args.parent_server is None or args.parent_server.is_absolute()
                else repo_root / args.parent_server
            ),
            web_dir=(
                args.parent_web_dir
                if args.parent_web_dir is None or args.parent_web_dir.is_absolute()
                else repo_root / args.parent_web_dir
            ),
            artifact_root=artifact_root,
            repo_root=repo_root,
            build=bool(args.build),
            allow_build_head_dirty=bool(args.allow_build_head_dirty),
        )
        head = accept_or_build_side(
            label="head",
            commit=head_commit,
            server=(
                args.head_server
                if args.head_server is None or args.head_server.is_absolute()
                else repo_root / args.head_server
            ),
            web_dir=(
                args.head_web_dir
                if args.head_web_dir is None or args.head_web_dir.is_absolute()
                else repo_root / args.head_web_dir
            ),
            artifact_root=artifact_root,
            repo_root=repo_root,
            build=bool(args.build),
            allow_build_head_dirty=bool(args.allow_build_head_dirty),
        )

        protocol = protocol_config(
            quick=bool(args.quick),
            parent_commit=parent_commit,
            head_commit=head_commit,
        )
        run_id = uuid.uuid4().hex[:12]

        # Disabled request proofs (offline + optional live static fetch).
        phase1_paths = classify_request_paths(capture_phase1_request_paths(protocol))
        offline_ui = initial_static_closure(head["web_dir"])
        if args.skip_ui_probe:
            ui_proof = {
                "side": "head",
                "commit": head_commit,
                "offline_static_closure": offline_ui,
                "live_initial_ui_requests": {
                    "skipped": True,
                    "passed": True,
                    "paths": [],
                },
                "passed": offline_ui["passed"],
            }
        else:
            ui_proof = run_ui_request_probe(
                bench, side=head, repo_root=repo_root, run_id=run_id
            )
            # Ensure offline closure remains authoritative even if live fetch is subset.
            ui_proof["passed"] = bool(ui_proof.get("passed") and offline_ui["passed"])
            ui_proof["offline_static_closure"] = offline_ui

        parent_samples, head_samples, ordering = run_interleaved_samples(
            bench,
            parent=parent,
            head=head,
            repo_root=repo_root,
            protocol=protocol,
            run_id=run_id,
        )
        parent_summary = summarize_side(parent_samples)
        head_summary = summarize_side(head_samples)
        budgets = evaluate_budgets(
            parent_summary=parent_summary,
            head_summary=head_summary,
            ui_proof=ui_proof,
            phase1_paths=phase1_paths,
        )

        zero_construction = {
            "claim": (
                "Disabled ordinary startup constructs no AI HTTP client, model cache, "
                "media device, audio context, speech worker, or provider egress."
            ),
            "provable_from_this_harness": False,
            "reason": (
                "Observing in-process construction would require counters or logging "
                "inside the measured release binary; this harness deliberately does "
                "not alter the binary."
            ),
            "external_proofs_recorded_here": [
                "Phase 1 workload path set contains no /api/v1/ai or /api/v1/voice routes",
                "Head release initial UI static closure contains no AI/voice/model markers",
                "Live initial UI probe issues only static shell/asset paths",
                "Every sample process_count == 1 with Node marker rejection from Phase 1 harness",
            ],
            "separate_executable_evidence": [
                "crates/junban-ai/tests/provider_contract.rs::default_factory_has_zero_client_construction",
                "crates/junban-ai/tests/provider_runtime.rs::zero_construction_when_unused",
                "crates/junban-server voice API tests asserting speech client construct_calls == 0 before use",
                "scripts/check-local-voice-assets.mjs initial-graph engine marker exclusion",
            ],
            "status": "not_proven_by_release_cgroup_harness",
        }

        report = build_report(
            protocol=protocol,
            host=host,
            contention=contention,
            parent=parent,
            head=head,
            parent_samples=parent_samples,
            head_samples=head_samples,
            ordering=ordering,
            ui_proof=ui_proof,
            phase1_paths=phase1_paths,
            budgets=budgets,
            run_id=run_id,
            argv=list(argv if argv is not None else sys.argv[1:]),
            zero_construction=zero_construction,
            repo_root=repo_root,
        )

        text = json.dumps(report, indent=2, sort_keys=True) + "\n"
        output = args.output
        if output is None and not args.quick:
            output = DEFAULT_EVIDENCE
        if output is not None:
            out_path = output if output.is_absolute() else repo_root / output
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text, encoding="utf-8")
            print(f"wrote {out_path}", file=sys.stderr)

        print(
            (
                f"status={report['evidence_status']} "
                f"parent_median={budgets['parent_median_warm_mib']:.4f}MiB "
                f"head_median={budgets['head_median_warm_mib']:.4f}MiB "
                f"delta={budgets['median_warm_delta_mib']:.4f}MiB "
                f"allowed={budgets['median_warm_growth_allowed_mib']:.4f}MiB "
                f"head_max_warm={budgets['head_max_warm_mib']:.4f}MiB "
                f"head_max_peak={budgets['head_max_peak_mib']:.4f}MiB "
                f"budget_passed={budgets['budget_passed']} "
                f"contended={contention['contended']}"
            ),
            file=sys.stderr,
        )
        sys.stdout.write(text)

        # Exit 0 for preliminary-but-passing budget runs so evidence can be retained;
        # exit 1 only when budgets fail or harness errors. Authoritative acceptance
        # is the evidence_status/accepted fields, not the exit code alone.
        return 0 if budgets["budget_passed"] or not protocol["authoritative"] else 1
    except Exception as error:
        if isinstance(error, HarnessError) or error.__class__.__name__ == "BenchError":
            print(f"benchmark failed: {error}", file=sys.stderr)
            return 1
        print(f"benchmark failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    sys.exit(main())
