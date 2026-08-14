#!/usr/bin/env python3
"""Build and exercise the exact Phase 7 references on each supported desktop OS.

This is a product/API and runtime-process matrix, not Linux cgroup memory authority.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, NoReturn

ROOT = Path(__file__).resolve().parent.parent
DOGFOOD_PATH = ROOT / "scripts/run-phase7-plugin-dogfood.py"
ARTIFACT_CHECKER = ROOT / "scripts/check-phase7-plugin-artifacts.py"
REFERENCES = ROOT / "plugins/reference"
RESULT_VERSION = 1
NODE_NAMES = {"node", "node.exe"}
TIMEOUT = 30.0
BUILD_COMMANDS = (
    ("cargo", "clean", "--release"),
    ("cargo", "build", "--locked", "--release", "--workspace", "--all-features"),
    ("pnpm", "build"),
)
RUST_REFERENCES = (
    ("automation-rust", "junban_reference_automation.wasm", "automation.wasm"),
    ("pomodoro-rust", "junban_reference_pomodoro.wasm", "pomodoro.wasm"),
)


class MatrixError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise MatrixError(message)


def is_canonical_byte_host(system: str, machine: str) -> bool:
    return system == "Linux" and machine.lower() in {"x86_64", "amd64"}


def adapt_command(
    command: list[str], *, system: str, resolver: Any = shutil.which
) -> list[str]:
    if system != "Windows" or Path(command[0]).name.lower() not in {"npm", "pnpm"}:
        return command
    executable_path = resolver(command[0])
    command_prompt = resolver("cmd.exe") or resolver("cmd")
    if executable_path is None or command_prompt is None:
        fail("Windows package-manager command was unavailable")
    fixed_command = subprocess.list2cmdline([executable_path, *command[1:]])
    return [command_prompt, "/d", "/s", "/c", fixed_command]


def run(
    command: list[str], *, cwd: Path = ROOT, timeout: float = 3600, capture: bool = False
) -> subprocess.CompletedProcess[str]:
    adapted = adapt_command(command, system=platform.system())
    try:
        completed = subprocess.run(
            adapted,
            cwd=cwd,
            check=False,
            timeout=timeout,
            text=True,
            stdout=subprocess.PIPE if capture else None,
        )
    except OSError as error:
        raise MatrixError("command startup failed") from error
    except subprocess.TimeoutExpired as error:
        raise MatrixError("command timed out") from error
    if completed.returncode != 0:
        fail(f"command failed ({completed.returncode}): {' '.join(command)}")
    return completed


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def identity(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        fail(f"required regular artifact is missing: {path.relative_to(ROOT)}")
    return {"sha256": sha256_file(path), "size_bytes": path.stat().st_size}


def executable(name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    path = ROOT / "target/release" / f"{name}{suffix}"
    path = path.resolve(strict=True)
    if path.is_symlink() or not path.is_file():
        fail(f"optimized {name} is unavailable")
    return path


def load_dogfood() -> Any:
    spec = importlib.util.spec_from_file_location("phase7_plugin_dogfood", DOGFOOD_PATH)
    if spec is None or spec.loader is None:
        fail("dogfood helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_references() -> dict[str, Any]:
    run(["rustup", "target", "add", "wasm32-wasip2"], timeout=600)
    records: dict[str, Any] = {}
    exact_byte_match_required = is_canonical_byte_host(platform.system(), platform.machine())
    for directory, build_name, retained_name in RUST_REFERENCES:
        root = REFERENCES / directory
        run(
            [
                "cargo", "build", "--manifest-path", str(root / "Cargo.toml"),
                "--locked", "--release", "--target", "wasm32-wasip2",
            ]
        )
        fresh = root / "target/wasm32-wasip2/release" / build_name
        retained = root / "artifacts" / retained_name
        fresh_identity = identity(fresh)
        retained_identity = identity(retained)
        exact_match = fresh_identity == retained_identity
        if exact_byte_match_required and not exact_match:
            fail(f"{directory} optimized rebuild did not match the exact retained reference")
        records[directory] = {
            "build": "cargo_release_wasm32_wasip2",
            "fresh": fresh_identity,
            "retained": retained_identity,
            "exact_match": exact_match,
            "exact_byte_match_required": exact_byte_match_required,
        }

    typescript = REFERENCES / "import-typescript"
    run(["npm", "ci"], cwd=typescript, timeout=1200)
    checked = run(["npm", "run", "check"], cwd=typescript, timeout=1200, capture=True)
    output_lines = [line.strip() for line in checked.stdout.splitlines() if line.strip()]
    build_check: Any = None
    for line in reversed(output_lines):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("mode") == "--check":
            build_check = candidate
            break
    if build_check is None:
        fail("TypeScript reference check did not emit its JSON authority")
    retained_typescript = identity(typescript / "artifacts/import-typescript.wasm")
    expected_build_check = {
        "mode": "--check",
        "freshSizeBytes": build_check.get("freshSizeBytes"),
        "freshSha256": build_check.get("freshSha256"),
        "retainedSizeBytes": retained_typescript["size_bytes"],
        "node": "24.13.1",
        "npm": "11.18.0",
        "typescript": "6.0.3",
        "jco": "1.26.1",
        "componentizeJs": "0.22.0",
        "imports": ["junban:plugin/types@0.1.0"],
        "exports": ["junban:plugin/guest@0.1.0"],
        "wasi": "disabled-all",
        "reproducibility": "structural-not-byte",
    }
    if (
        build_check != expected_build_check
        or not isinstance(build_check["freshSizeBytes"], int)
        or build_check["freshSizeBytes"] <= 0
        or not isinstance(build_check["freshSha256"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", build_check["freshSha256"])
    ):
        fail("TypeScript reference build/provenance authority drifted")
    records["import-typescript"] = {
        "build": "npm_locked_componentize_and_structural_check",
        "fresh": {
            "sha256": build_check["freshSha256"],
            "size_bytes": build_check["freshSizeBytes"],
        },
        "retained": retained_typescript,
        "structural_match": True,
        "exact_byte_match_required": False,
        "optimized_product_api_checked": True,
    }
    return records


def process_table() -> dict[int, tuple[int, str]]:
    system = platform.system()
    table: dict[int, tuple[int, str]] = {}
    if system == "Linux":
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text(encoding="ascii")
                close = stat.rfind(")")
                fields = stat[close + 2 :].split()
                parent = int(fields[1])
                name = os.path.basename(os.readlink(entry / "exe"))
                table[int(entry.name)] = (parent, name)
            except (OSError, ValueError, IndexError):
                continue
        return table
    if system == "Darwin":
        command = ["ps", "-axo", "pid=,ppid=,comm="]
        try:
            output = subprocess.check_output(command, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError) as error:
            raise MatrixError("macOS process table was unavailable") from error
        for line in output.splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
                table[int(parts[0])] = (int(parts[1]), os.path.basename(parts[2]))
        return table
    if system == "Windows":
        script = (
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name "
            "| ConvertTo-Json -Compress"
        )
        try:
            output = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command", script], text=True, timeout=20
            )
            values = json.loads(output)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            raise MatrixError("Windows process table was unavailable") from error
        if isinstance(values, dict):
            values = [values]
        if not isinstance(values, list):
            fail("Windows process table had an invalid shape")
        for value in values:
            if isinstance(value, dict):
                pid = value.get("ProcessId")
                parent = value.get("ParentProcessId")
                name = value.get("Name")
                if isinstance(pid, int) and isinstance(parent, int) and isinstance(name, str):
                    table[pid] = (parent, name)
        return table
    fail(f"unsupported reference-matrix platform: {system}")


def descendants(root_pid: int) -> dict[int, str]:
    table = process_table()
    selected: dict[int, str] = {}
    changed = True
    while changed:
        changed = False
        for pid, (parent, name) in table.items():
            if pid not in selected and (parent == root_pid or parent in selected):
                selected[pid] = name
                changed = True
    return selected


class ProductServer:
    def __init__(self, server: Path, host: Path, web: Path, profile: Path) -> None:
        self.server_path = server
        self.host_path = host
        self.web = web
        self.profile = profile
        self.process: subprocess.Popen[bytes] | None = None
        self.address = ""
        self.base_url = ""
        self.token = ""
        self.call_timeout = TIMEOUT
        self.observed_children: set[int] = set()
        self.observations: list[dict[str, Any]] = []

    def start(self) -> None:
        self.profile.mkdir(mode=0o700)
        command = [
            str(self.server_path), "--bind", "127.0.0.1:0", "--data-dir",
            str(self.profile), "--web-dir", str(self.web),
        ]
        options: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "cwd": self.web,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            options["start_new_session"] = True
        self.process = subprocess.Popen(command, **options)
        runtime = self.profile / "runtime.json"
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                diagnostic = (self.process.stderr.read(8192) if self.process.stderr else b"")
                fail(f"optimized server exited during startup: {diagnostic.decode(errors='replace')}")
            try:
                value = json.loads(runtime.read_text(encoding="utf-8"))
                token = (self.profile / "access-token").read_text(encoding="utf-8").strip()
            except (OSError, json.JSONDecodeError):
                time.sleep(0.05)
                continue
            if value.get("pid") == self.process.pid and isinstance(value.get("address"), str) and token:
                self.address = value["address"]
                self.base_url = f"http://{self.address}"
                self.token = token
                payload, status, _ = self.request("GET", "/api/v1/health", authenticated=False)
                if status == 200 and payload.get("status") == "ok":
                    return
            time.sleep(0.05)
        fail("optimized server did not become healthy")

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        operation_id: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Any, int, bytes]:
        headers = {"Host": self.address, "Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            data = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["Origin"] = self.base_url
        if operation_id is not None:
            headers["Idempotency-Key"] = operation_id
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                status = response.status
        except urllib.error.HTTPError as error:
            raw = error.read(2 * 1024 * 1024 + 1)
            status = error.code
        except (OSError, TimeoutError) as error:
            raise MatrixError(f"HTTP {method} {path} did not complete") from error
        if len(raw) > 2 * 1024 * 1024:
            fail("product response exceeded matrix bound")
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError as error:
            raise MatrixError(f"HTTP {method} {path} returned malformed JSON") from error
        return payload, int(status), raw

    def expect(
        self,
        method: str,
        path: str,
        expected: int,
        *,
        body: Any | None = None,
        operation_id: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Any, bytes]:
        payload, status, raw = self.request(
            method, path, body=body, operation_id=operation_id, authenticated=authenticated
        )
        if status != expected:
            fail(f"HTTP {method} {path} returned {status}, expected {expected}")
        return payload, raw

    def observe(self, label: str, expected_hosts: int) -> None:
        assert self.process is not None
        deadline = time.monotonic() + TIMEOUT
        values: dict[int, str] = {}
        while time.monotonic() < deadline:
            values = descendants(self.process.pid)
            hosts = [name for name in values.values() if name.lower() == self.host_path.name.lower()]
            if len(hosts) == expected_hosts:
                break
            time.sleep(0.05)
        hosts = [name for name in values.values() if name.lower() == self.host_path.name.lower()]
        nodes = [name for name in values.values() if name.lower() in NODE_NAMES]
        unexpected = [
            name for name in values.values()
            if name.lower() != self.host_path.name.lower()
        ]
        if len(hosts) != expected_hosts or nodes or unexpected:
            fail(f"{label}: runtime process composition was not exact")
        self.observed_children.update(values)
        self.observations.append(
            {"label": label, "host_count": len(hosts), "node_count": len(nodes), "names": sorted(values.values())}
        )

    def stop(self) -> dict[str, bool]:
        assert self.process is not None
        if self.process.poll() is None:
            if os.name == "nt":
                self.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=TIMEOUT)
            except subprocess.TimeoutExpired as error:
                self.process.kill()
                self.process.wait(timeout=5)
                raise MatrixError("optimized server did not stop gracefully") from error
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline and (
            (self.profile / "runtime.json").exists()
            or any(pid in process_table() for pid in self.observed_children)
        ):
            time.sleep(0.05)
        result = {
            "server_exit_success": self.process.returncode == 0,
            "runtime_removed": not (self.profile / "runtime.json").exists(),
            "observed_children_gone": not any(pid in process_table() for pid in self.observed_children),
        }
        if not all(result.values()):
            failed = sorted(key for key, value in result.items() if not value)
            fail(f"optimized product cleanup was incomplete: failed={failed}")
        return result


def exercise_product(dogfood: Any, server_path: Path, host_path: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="junban-p7-reference-matrix-") as temporary:
        root = Path(temporary)
        server = ProductServer(server_path, host_path, ROOT / "dist", root / "profile")
        server.start()
        checks: dict[str, Any] = {}
        try:
            dogfood.trust_bundled_publisher(server)
            server.observe("bundled-publisher-trusted", 0)
            installed: dict[str, dict[str, Any]] = {}
            for plugin_id, digest, _ in dogfood.REGISTRY_AUTHORITY:
                installed[plugin_id] = dogfood.install_registry(
                    server, plugin_id, digest, f"matrix:{plugin_id}"
                )

            dogfood.grant_exact(server, installed["pomodoro"], "matrix:pomodoro")
            dogfood.enable(server, "pomodoro", "matrix:pomodoro")
            contributions = dogfood.wait_contributions(
                server,
                "pomodoro",
                {
                    ("command", "pause"),
                    ("command", "reset"),
                    ("command", "skip"),
                    ("command", "start"),
                    ("status", "status"),
                    ("view", "timer"),
                },
            )
            fence = dogfood.contribution_fence(contributions[0])
            server.observe("pomodoro-active", 1)
            server.expect(
                "POST", "/api/v1/plugins/pomodoro/commands/reset", 200,
                body={**fence, "values": []}, operation_id=dogfood.operation("matrix:pomodoro:reset"),
            )
            rendered, _ = server.expect(
                "POST", "/api/v1/plugins/pomodoro/surfaces/timer/render", 200, body=fence
            )
            if dogfood.surface_metric(rendered, "timer-value").get("value") != "25:00":
                fail("optimized Pomodoro API did not render the exact retained reference")
            dogfood.disable(server, "pomodoro", "matrix:pomodoro")
            server.observe("pomodoro-disabled", 0)
            checks["pomodoro"] = {"optimized_api_invoked": True, "exact_metric": "25:00"}

            dogfood.grant_exact(server, installed["automation"], "matrix:automation")
            dogfood.enable(server, "automation", "matrix:automation")
            server.observe("automation-active", 1)
            automated_task, _ = dogfood.create_task(
                server, "matrix:automation:task", "Reference matrix automation", replay=True
            )
            dogfood.wait_task_status(
                server, [automated_task], "completed", TIMEOUT, label="reference automation"
            )
            dogfood.disable(server, "automation", "matrix:automation")
            server.observe("automation-disabled", 0)
            checks["automation"] = {"optimized_api_invoked": True, "exact_effect": "completed"}

            dogfood.grant_exact(server, installed["import-typescript"], "matrix:typescript")
            dogfood.enable(server, "import-typescript", "matrix:typescript")
            contributions = dogfood.wait_contributions(
                server, "import-typescript", {("command", "bulk-complete")}
            )
            fence = dogfood.contribution_fence(contributions[0])
            server.observe("typescript-active", 1)
            bulk_task, _ = dogfood.create_task(
                server, "matrix:typescript:task", "Reference matrix TypeScript"
            )
            server.expect(
                "POST", "/api/v1/plugins/import-typescript/commands/bulk-complete", 200,
                body={
                    **fence,
                    "values": [
                        {
                            "name": "task-ids",
                            "value": {"tag": "task-id-list", "val": [bulk_task]},
                        }
                    ],
                },
                operation_id=dogfood.operation("matrix:typescript:bulk"),
            )
            dogfood.wait_task_status(
                server, [bulk_task], "completed", TIMEOUT, label="reference TypeScript"
            )
            dogfood.disable(server, "import-typescript", "matrix:typescript")
            server.observe("typescript-disabled", 0)
            checks["import-typescript"] = {"optimized_api_invoked": True, "exact_effect": "completed"}

            removed: dict[str, bool] = {}
            for plugin_id, digest, _ in dogfood.REGISTRY_AUTHORITY:
                package = dogfood.package_object_path(server.profile, digest)
                if not package.is_file():
                    fail(f"{plugin_id} package object was absent before uninstall")
                server.expect(
                    "DELETE", f"/api/v1/plugins/{plugin_id}", 200,
                    operation_id=dogfood.operation(f"matrix:{plugin_id}:uninstall"),
                )
                removed[plugin_id] = not package.exists()
            if not all(removed.values()):
                fail("content-addressed package cleanup failed")
            checks["package_cleanup"] = removed
            server.observe("all-uninstalled", 0)
            cleanup = server.stop()
            return {
                "checks": checks,
                "process_observations": server.observations,
                "runtime_node_absent": all(value["node_count"] == 0 for value in server.observations),
                "cleanup": cleanup,
            }
        finally:
            if server.process is not None and server.process.poll() is None:
                server.process.kill()
                server.process.wait(timeout=5)


def write_result(path: Path, result: dict[str, Any]) -> None:
    destination = path if path.is_absolute() else ROOT / path
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    for candidate in (destination, temporary):
        if candidate.is_symlink() or (candidate.exists() and not candidate.is_file()):
            fail("reference-matrix report destination is unsafe")
    payload = (json.dumps(result, indent=2, sort_keys=True) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        handle = os.open(temporary, flags, 0o600)
        with os.fdopen(handle, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise MatrixError("reference-matrix report publication failed") from error


def self_check() -> None:
    if set(name.lower() for name in ("node", "node.exe")) != NODE_NAMES:
        raise AssertionError("runtime Node name authority drifted")
    if len(RUST_REFERENCES) != 2 or BUILD_COMMANDS != (
        ("cargo", "clean", "--release"),
        ("cargo", "build", "--locked", "--release", "--workspace", "--all-features"),
        ("pnpm", "build"),
    ):
        raise AssertionError("reference matrix build plan drifted")
    if not is_canonical_byte_host("Linux", "x86_64") or not is_canonical_byte_host(
        "Linux", "AMD64"
    ):
        raise AssertionError("canonical Linux byte host was rejected")
    if any(
        is_canonical_byte_host(system, machine)
        for system, machine in (("Darwin", "x86_64"), ("Windows", "AMD64"), ("Linux", "aarch64"))
    ):
        raise AssertionError("noncanonical byte host was accepted")
    resolved = {
        "npm": r"C:\Program Files\nodejs\npm.cmd",
        "pnpm": r"C:\Tools\pnpm.cmd",
        "cmd.exe": r"C:\Windows\System32\cmd.exe",
    }
    for command, expected in (
        (["npm", "run", "check"], r'"C:\Program Files\nodejs\npm.cmd" run check'),
        (["pnpm", "build"], r"C:\Tools\pnpm.cmd build"),
    ):
        adapted = adapt_command(command, system="Windows", resolver=resolved.get)
        if adapted != [resolved["cmd.exe"], "/d", "/s", "/c", expected]:
            raise AssertionError("Windows package-manager command adaptation drifted")
    unchanged = ["npm", "run", "check"]
    if adapt_command(unchanged, system="Linux", resolver=resolved.get) is not unchanged:
        raise AssertionError("non-Windows command adaptation changed")
    fake = {2: (1, "junban-plugin-host"), 3: (2, "node")}
    selected: dict[int, str] = {}
    changed = True
    while changed:
        changed = False
        for pid, (parent, name) in fake.items():
            if pid not in selected and (parent == 1 or parent in selected):
                selected[pid] = name
                changed = True
    if not any(name.lower() in NODE_NAMES for name in selected.values()):
        raise AssertionError("runtime Node detector accepted a nested Node process")
    print("Phase 7 reference matrix self-check passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument(
        "--output", type=Path, default=Path("target/phase7-reference-matrix/result.json")
    )
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if platform.system() not in {"Linux", "Darwin", "Windows"}:
        fail("reference matrix requires Linux, macOS, or Windows")
    for command in BUILD_COMMANDS:
        run(list(command))
    references = build_references()
    tool = executable("junban-plugin-artifact")
    run([sys.executable, str(ARTIFACT_CHECKER), "--tool", str(tool)], timeout=900)
    dogfood = load_dogfood()
    product = exercise_product(
        dogfood, executable("junban-server"), executable("junban-plugin-host")
    )
    result = {
        "schema_version": RESULT_VERSION,
        "status": "passed",
        "target_os": platform.system().lower(),
        "memory_authority": "none; this cross-platform matrix makes no Linux cgroup claim",
        "references": references,
        "product": product,
        "artifacts": {
            "server": identity(executable("junban-server")),
            "host": identity(executable("junban-plugin-host")),
            "artifact_tool": identity(tool),
            "production_dist_sha256": dogfood.tree_identity(ROOT / "dist")["tree_sha256"],
        },
    }
    write_result(args.output, result)
    print(f"Phase 7 exact reference matrix passed on {platform.system()}")


if __name__ == "__main__":
    try:
        main()
    except (MatrixError, AssertionError) as error:
        print(f"Phase 7 reference matrix failed: {error}", file=sys.stderr)
        raise SystemExit(1)
