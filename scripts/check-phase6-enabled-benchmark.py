#!/usr/bin/env python3
"""Phase 6 enabled local-mock release benchmark.

Runs the exact optimized junban-server binary in a transient cgroup-v2 systemd
unit while a deterministic OpenAI-compatible TLS fixture remains outside.  The
fixed production origin is intercepted only in the measured process through an
ephemeral CA (`SSL_CERT_FILE`) and the compiled benchmark resolver shim
(`LD_PRELOAD`).  Production endpoint policy and system trust are untouched.

The authoritative command is documented in the Phase 6 protocol.  `--self-check`
validates the interception and fixture without starting Junban.  A run marked
`--preliminary` executes the full frozen matrix but can never produce accepted
evidence.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

PROTOCOL_NAME = "junban-phase6-enabled-local-mock-v1"
PROTOCOL_VERSION = 1
PROFILES = 3
SHORT_TURNS_PER_PROFILE = 30
STT_BYTES = 1_048_576
TTS_BYTES = 1_048_576
SETTLE_SECONDS = 2.0
MEMORY_SAMPLE_SECONDS = 0.01
READY_TIMEOUT_SECONDS = 30.0
STOP_TIMEOUT_SECONDS = 20.0
FIXTURE_QUIESCE_SECONDS = 10.0
MAX_DRIVER_JSON_BYTES = 4 * 1024 * 1024

FIRST_EVENT_P95_MS = 250.0
COMPLETED_SHORT_P95_MS = 750.0
CANCEL_QUIESCED_P95_MS = 500.0
STT_P95_MS = 1_000.0
TTS_P95_MS = 1_000.0
POST_SESSION_WARM_MIB = 32.0
OPERATION_PEAK_MIB = 48.0
POST_DRAIN_GROWTH_MIB = 4.0

OFFICIAL_HOST = "api.openai.com"
SENTINEL_IP = "127.66.0.1"
FIXTURE_PORT_ENV = "JUNBAN_PHASE6_FIXTURE_PORT"
MODEL_ID = "phase6-benchmark-model"
TOKEN_FILE = "access-token"
RUNTIME_FILE = "runtime.json"
LOCK_FILE = "profile.lock"
DATABASE_FILE = "junban.sqlite3"
DEFAULT_OUTPUT = Path("goals/rust-rewrite/evidence/phase-6-enabled-bench.json")
FIXTURE_SCRIPT = Path("scripts/phase6-enabled-loopback-fixture.py")
SHIM_SOURCE = Path("scripts/phase6-fixture-getaddrinfo.c")
NODE_MARKERS = frozenset({"node", "nodejs", "npm", "npx", "pnpm", "vite", "playwright"})
TERMINALS = frozenset({"run_completed", "run_cancelled", "run_failed"})


class BenchError(RuntimeError):
    """Fail-closed benchmark error."""


def run_cmd(
    args: list[str],
    *,
    check: bool = True,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise BenchError(f"command failed ({args[0]} …): {detail[:400]}")
    return result


def poll_until(timeout: float, predicate: Callable[[], bool], message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.025)
    raise BenchError(message)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        raise BenchError("cannot summarize an empty latency series")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = pct / 100.0 * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1.0 - weight) + ordered[high] * weight


def series(values: list[float]) -> dict[str, Any]:
    ordered = sorted(values)
    if not ordered:
        raise BenchError("missing metric values")
    return {
        "count": len(ordered),
        "p50": round(percentile(ordered, 50), 4),
        "p95": round(percentile(ordered, 95), 4),
        "min": round(ordered[0], 4),
        "max": round(ordered[-1], 4),
        "values": [round(value, 4) for value in ordered],
    }


def mib(value: int | float) -> float:
    return round(float(value) / 1_048_576.0, 4)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_secret_absent(value: bytes | str, secrets: list[str], where: str) -> None:
    data = value.encode("utf-8", errors="replace") if isinstance(value, str) else value
    for secret in secrets:
        if secret and secret.encode() in data:
            raise BenchError(f"synthetic credential leaked in {where}")


def require_environment() -> None:
    if sys.platform != "linux":
        raise BenchError("enabled benchmark requires Linux")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise BenchError("cgroup v2 is not mounted")
    for tool in ("systemctl", "systemd-run", "openssl", "cc"):
        if shutil.which(tool) is None:
            raise BenchError(f"required benchmark tool is unavailable: {tool}")
    state = run_cmd(["systemctl", "--user", "is-system-running"], check=False)
    if state.returncode not in (0, 1) or (state.stdout or "").strip() not in {
        "running",
        "degraded",
        "starting",
        "maintenance",
    }:
        raise BenchError("systemd --user is unavailable")
    help_text = run_cmd(["systemd-run", "--help"]).stdout or ""
    if "--setenv=" not in help_text:
        raise BenchError("systemd-run lacks required --setenv support")


def require_unprivileged_loopback_bind() -> None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        probe.bind(("127.0.0.1", 0))
        selected = int(probe.getsockname()[1])
        if selected <= 1023:
            raise BenchError("kernel selected a privileged fixture port")
    except OSError as error:
        raise BenchError(f"unprivileged loopback bind is unavailable: {error}") from error
    finally:
        probe.close()


def require_listener_released(port: int) -> None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(1.0)
    try:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise BenchError("fixture listener remained reachable after fixture exit")
    finally:
        probe.close()


def generate_pki(root: Path) -> dict[str, Any]:
    ca_key = root / "ca.key"
    ca_cert = root / "ca.pem"
    leaf_key = root / "leaf.key"
    leaf_csr = root / "leaf.csr"
    leaf_cert = root / "leaf.pem"
    extensions = root / "leaf.ext"
    extensions.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        f"subjectAltName=DNS:{OFFICIAL_HOST}\n",
        encoding="utf-8",
    )
    os.chmod(extensions, 0o600)
    run_cmd(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=Junban Phase 6 Ephemeral Benchmark CA",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca_cert),
        ]
    )
    run_cmd(
        [
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-nodes",
            "-subj",
            f"/CN={OFFICIAL_HOST}",
            "-keyout",
            str(leaf_key),
            "-out",
            str(leaf_csr),
        ]
    )
    run_cmd(
        [
            "openssl",
            "x509",
            "-req",
            "-sha256",
            "-days",
            "1",
            "-in",
            str(leaf_csr),
            "-CA",
            str(ca_cert),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-extfile",
            str(extensions),
            "-out",
            str(leaf_cert),
        ]
    )
    for private in (ca_key, leaf_key):
        os.chmod(private, 0o600)
    verify = run_cmd(
        [
            "openssl",
            "verify",
            "-CAfile",
            str(ca_cert),
            "-verify_hostname",
            OFFICIAL_HOST,
            str(leaf_cert),
        ]
    )
    if "OK" not in (verify.stdout or ""):
        raise BenchError("ephemeral fixture certificate verification failed")
    openssl_version = (run_cmd(["openssl", "version"]).stdout or "").strip()
    return {
        "ca_key": ca_key,
        "ca_cert": ca_cert,
        "leaf_key": leaf_key,
        "leaf_cert": leaf_cert,
        "metadata": {
            "openssl": openssl_version,
            "official_host": OFFICIAL_HOST,
            "san": f"DNS:{OFFICIAL_HOST}",
            "ca_pem_sha256": sha256_file(ca_cert),
            "leaf_pem_sha256": sha256_file(leaf_cert),
            "private_keys_retained": False,
            "system_trust_modified": False,
            "etc_hosts_modified": False,
        },
    }


def compile_shim(repo: Path, root: Path) -> tuple[Path, dict[str, Any]]:
    source = (repo / SHIM_SOURCE).resolve()
    output = root / "phase6-getaddrinfo.so"
    run_cmd(
        [
            "cc",
            "-shared",
            "-fPIC",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-o",
            str(output),
            str(source),
            "-ldl",
        ]
    )
    return output, {
        "source": str(SHIM_SOURCE),
        "source_sha256": sha256_file(source),
        "object_sha256": sha256_file(output),
        "object_size_bytes": output.stat().st_size,
        "compiler": (run_cmd(["cc", "--version"]).stdout or "").splitlines()[0],
        "mapped_hostnames": [OFFICIAL_HOST],
        "sentinel_ip": SENTINEL_IP,
        "connect_rewrite": f"{SENTINEL_IP}:443 -> 127.0.0.1:${FIXTURE_PORT_ENV}",
        "fixture_port_environment": FIXTURE_PORT_ENV,
        "compiled_object_retained": False,
    }


class FixtureProcess:
    def __init__(self, repo: Path, root: Path, pki: dict[str, Any]) -> None:
        self.ready_file = root / "fixture-ready.json"
        fixture_env = dict(os.environ)
        for name in (
            "LD_PRELOAD",
            "SSL_CERT_FILE",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            FIXTURE_PORT_ENV,
        ):
            fixture_env.pop(name, None)
        self.process = subprocess.Popen(
            [
                sys.executable,
                str((repo / FIXTURE_SCRIPT).resolve()),
                "--cert",
                str(pki["leaf_cert"]),
                "--key",
                str(pki["leaf_key"]),
                "--ready-file",
                str(self.ready_file),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=fixture_env,
        )
        holder: dict[str, Any] = {}

        def ready() -> bool:
            if self.process.poll() is not None:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                raise BenchError(f"fixture exited before readiness: {stderr[:300]}")
            if not self.ready_file.exists():
                return False
            try:
                holder["value"] = json.loads(self.ready_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            return True

        poll_until(READY_TIMEOUT_SECONDS, ready, "fixture readiness timed out")
        self.ready = holder["value"]
        if self.ready.get("official_host") != OFFICIAL_HOST:
            raise BenchError("fixture official-host authority mismatch")
        tls_host, separator, tls_port = str(self.ready.get("tls_address", "")).rpartition(":")
        if tls_host != "127.0.0.1" or separator != ":":
            raise BenchError("fixture did not publish an exact loopback TLS address")
        try:
            self.tls_port = int(tls_port)
        except ValueError as error:
            raise BenchError("fixture published an invalid TLS port") from error
        if not 1024 <= self.tls_port <= 65535:
            raise BenchError("fixture did not bind an unprivileged high port")
        self.admin = self.ready["admin_address"]

    def status(self) -> dict[str, Any]:
        payload, _ = plain_json("GET", f"http://{self.admin}/status", {}, None, {200})
        if not isinstance(payload, dict):
            raise BenchError("fixture status was not an object")
        return payload

    def wait_quiesced(self, scenario: str, timeout: float) -> bool:
        query = urllib.parse.urlencode({"scenario": scenario, "timeout": timeout})
        payload, _ = plain_json(
            "GET", f"http://{self.admin}/wait?{query}", {}, None, {200}, timeout=timeout + 2
        )
        return bool(payload.get("quiesced"))

    def stop(self) -> dict[str, Any]:
        before = self.status()
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired as error:
                self.process.kill()
                self.process.wait(timeout=5)
                raise BenchError("fixture did not stop cleanly") from error
        stdout = self.process.stdout.read() if self.process.stdout else ""
        stderr = self.process.stderr.read() if self.process.stderr else ""
        if self.process.returncode != 0:
            raise BenchError(f"fixture exited {self.process.returncode}: {stderr[:300]}")
        if stdout.strip() or stderr.strip():
            raise BenchError("fixture produced unexpected output")
        require_listener_released(self.tls_port)
        return {
            "exit_code": self.process.returncode,
            "active_connections_before_stop": before.get("active_connections"),
            "errors": before.get("errors"),
            "listener_released": True,
            "unprivileged_tls_port": self.tls_port,
            "process_gone": self.process.poll() is not None,
        }


def shim_environment(shim: Path, fixture_port: int) -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "LD_PRELOAD": str(shim),
            FIXTURE_PORT_ENV: str(fixture_port),
            "NO_PROXY": "*",
            "no_proxy": "*",
            "HTTP_PROXY": "",
            "HTTPS_PROXY": "",
            "ALL_PROXY": "",
        }
    )
    env.pop("SSL_CERT_FILE", None)
    return env


def interception_probe(shim: Path, ca_cert: Path, fixture_port: int) -> None:
    code = (
        "import json,ssl,sys,urllib.request; "
        "c=ssl.create_default_context(cafile=sys.argv[1]); "
        "r=urllib.request.urlopen('https://api.openai.com/__fixture/health',context=c,timeout=5); "
        "v=json.load(r); assert v=={'status':'ok','version':1}"
    )
    run_cmd(
        [sys.executable, "-c", code, str(ca_cert)],
        env=shim_environment(shim, fixture_port),
        timeout=10,
    )


def direct_connect_probe(host: str, shim: Path, fixture_port: int) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.settimeout(5.0)
    listener.bind((host, 0))
    listener.listen(1)
    address, port = listener.getsockname()
    code = "import socket,sys; s=socket.create_connection((sys.argv[1],int(sys.argv[2])),5); s.close()"
    child = subprocess.Popen(
        [sys.executable, "-c", code, str(address), str(port)],
        env=shim_environment(shim, fixture_port),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        connection, peer = listener.accept()
        connection.close()
        if not peer[0].startswith("127."):
            raise BenchError("unrelated connect probe had a non-loopback peer")
        stdout, stderr = child.communicate(timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        child.kill()
        child.wait(timeout=5)
        raise BenchError(f"unrelated connect delegation failed for {host}: {error}") from error
    finally:
        listener.close()
    if child.returncode != 0 or stdout or stderr:
        raise BenchError(f"unrelated connect delegation failed for {host}")


def shim_delegation_self_checks(shim: Path, fixture_port: int) -> dict[str, Any]:
    resolver_code = (
        "import json,socket,sys; "
        "v=sorted({x[4][0] for x in socket.getaddrinfo(sys.argv[1],'https',socket.AF_INET)}); "
        "print(json.dumps(v,separators=(',',':')))"
    )
    baseline = run_cmd([sys.executable, "-c", resolver_code, "localhost"]).stdout.strip()
    loaded = run_cmd(
        [sys.executable, "-c", resolver_code, "localhost"],
        env=shim_environment(shim, fixture_port),
    ).stdout.strip()
    if loaded != baseline:
        raise BenchError("resolver shim changed an unrelated hostname")
    official = run_cmd(
        [sys.executable, "-c", resolver_code, OFFICIAL_HOST],
        env=shim_environment(shim, fixture_port),
    ).stdout.strip()
    if json.loads(official) != [SENTINEL_IP]:
        raise BenchError("allowlisted hostname did not resolve only to the sentinel")

    # Both an ordinary loopback address and the sentinel on a non-443 port must
    # reach their original listeners. Only sentinel:443 may be rewritten.
    direct_connect_probe("127.0.0.1", shim, fixture_port)
    direct_connect_probe(SENTINEL_IP, shim, fixture_port)

    invalid_code = (
        "import errno,socket,sys; s=socket.socket(); "
        "e=s.connect_ex(('127.66.0.1',443)); "
        "sys.exit(0 if e==errno.ECONNREFUSED else 1)"
    )
    invalid_env = shim_environment(shim, fixture_port)
    invalid_env.pop(FIXTURE_PORT_ENV, None)
    run_cmd([sys.executable, "-c", invalid_code], env=invalid_env, timeout=5)
    for invalid in ("443", "not-a-port", " 4444", "+4444", "4444 ", "65536"):
        invalid_env[FIXTURE_PORT_ENV] = invalid
        run_cmd([sys.executable, "-c", invalid_code], env=invalid_env, timeout=5)
    return {
        "allowlisted_hostname_to_sentinel": True,
        "unrelated_hostname_unchanged": True,
        "unrelated_address_unchanged": True,
        "sentinel_non_https_port_unchanged": True,
        "missing_or_invalid_port_fails_closed": True,
    }


def plain_json(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | bytes | None,
    statuses: set[int],
    *,
    timeout: float = 30.0,
) -> tuple[Any, float]:
    request_headers = dict(headers)
    data: bytes | None
    if isinstance(body, dict):
        data = json.dumps(body, separators=(",", ":")).encode()
        request_headers.setdefault("Content-Type", "application/json")
    else:
        data = body
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    started = time.perf_counter_ns()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read(MAX_DRIVER_JSON_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read(MAX_DRIVER_JSON_BYTES + 1)
    except (urllib.error.URLError, TimeoutError) as error:
        raise BenchError(f"HTTP {method} failed: {error}") from error
    elapsed = (time.perf_counter_ns() - started) / 1_000_000
    if len(raw) > MAX_DRIVER_JSON_BYTES:
        raise BenchError(f"HTTP {method} JSON exceeded the driver bound")
    if status not in statuses:
        raise BenchError(f"HTTP {method} returned {status}: {raw[:240]!r}")
    if not raw:
        return None, elapsed
    try:
        return json.loads(raw), elapsed
    except json.JSONDecodeError as error:
        raise BenchError(f"HTTP {method} returned malformed JSON") from error


def raw_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes,
    statuses: set[int],
    *,
    timeout: float = 75.0,
    max_response_bytes: int = MAX_DRIVER_JSON_BYTES,
) -> tuple[bytes, dict[str, str], float]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    started = time.perf_counter_ns()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            result_headers = dict(response.headers.items())
            raw = response.read(max_response_bytes + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        result_headers = dict(error.headers.items())
        raw = error.read(max_response_bytes + 1)
    elapsed = (time.perf_counter_ns() - started) / 1_000_000
    if len(raw) > max_response_bytes:
        raise BenchError(f"HTTP {method} response exceeded the driver bound")
    if status not in statuses:
        raise BenchError(f"HTTP {method} returned {status}: {raw[:240]!r}")
    return raw, result_headers, elapsed


def auth_headers(token: str, host: str, mutation: bool, operation: str | None = None) -> dict[str, str]:
    headers = {"Host": host, "Authorization": f"Bearer {token}"}
    if mutation:
        headers["Origin"] = f"http://{host}"
        headers["Idempotency-Key"] = operation or str(uuid.uuid4())
    return headers


def profile_prepare(profile: Path, token: str) -> None:
    profile.mkdir(parents=True, mode=0o700)
    os.chmod(profile, 0o700)
    fd = os.open(profile / TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")


def unit_property(unit: str, prop: str) -> str:
    result = run_cmd(
        ["systemctl", "--user", "show", unit, f"--property={prop}", "--value"],
        check=False,
    )
    return (result.stdout or "").strip() if result.returncode == 0 else ""


def unit_exists(unit: str) -> bool:
    return unit_property(unit, "LoadState") not in {"", "not-found"}


def cgroup_path(unit: str) -> Path:
    value = unit_property(unit, "ControlGroup")
    if not value:
        raise BenchError(f"missing cgroup for {unit}")
    path = Path("/sys/fs/cgroup") / value.lstrip("/")
    if not path.is_dir():
        raise BenchError(f"cgroup path disappeared for {unit}")
    return path


def cgroup_memory(unit: str) -> dict[str, int]:
    path = cgroup_path(unit)
    try:
        current = int((path / "memory.current").read_text().strip())
        peak = int((path / "memory.peak").read_text().strip())
    except (OSError, ValueError) as error:
        raise BenchError(f"invalid cgroup memory for {unit}") from error
    return {"current_bytes": current, "peak_bytes": peak}


def parse_memory_stat(text: str, *, unit: str = "synthetic") -> dict[str, int]:
    """Parse raw cgroup v2 memory.stat key/value pairs (bytes)."""
    stats: dict[str, int] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        key, raw = parts
        try:
            stats[key] = int(raw)
        except ValueError as error:
            raise BenchError(f"invalid memory.stat line for {unit}: {line!r}") from error
    if "anon" not in stats or "file" not in stats:
        raise BenchError(f"memory.stat missing anon/file for {unit}")
    return stats


def read_cgroup_memory_stat(unit: str) -> dict[str, int]:
    path = cgroup_path(unit) / "memory.stat"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise BenchError(f"cgroup memory.stat unavailable for {unit}: {error}") from error
    return parse_memory_stat(text, unit=unit)


def memory_stat_summary(stat: dict[str, int]) -> dict[str, Any]:
    """Evidence-only anon/file composition view; never consulted by gates."""
    return {
        "anon_bytes": int(stat["anon"]),
        "file_bytes": int(stat["file"]),
        "anon_mib": mib(stat["anon"]),
        "file_mib": mib(stat["file"]),
    }


def memory_snapshot(unit: str) -> dict[str, Any]:
    """current/peak plus evidence-only memory.stat composition."""
    memory = cgroup_memory(unit)
    summary = memory_stat_summary(read_cgroup_memory_stat(unit))
    return {
        "current_bytes": memory["current_bytes"],
        "peak_bytes": memory["peak_bytes"],
        "memory_stat": summary,
    }


def process_snapshot(
    unit: str,
    server_name: str,
    fixture_pid: int,
    ca_cert: Path,
    shim: Path,
    fixture_port: int,
) -> dict[str, Any]:
    pids = [int(value) for value in (cgroup_path(unit) / "cgroup.procs").read_text().split()]
    if fixture_pid in pids:
        raise BenchError("standalone fixture entered the measured server cgroup")
    if len(pids) != 1:
        raise BenchError(f"expected exactly one cgroup process, found {pids}")
    pid = pids[0]
    exe = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
    cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    comm = Path(f"/proc/{pid}/comm").read_text().strip()
    tokens = set(re.split(r"[^a-z0-9_.+-]+", f"{exe} {cmdline} {comm}".lower()))
    if tokens.intersection(NODE_MARKERS):
        raise BenchError("Node/tooling process found in measured cgroup")
    if server_name not in exe and "junban-server" not in comm:
        raise BenchError("measured process is not the exact Junban server")
    environment = {}
    for entry in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
        if b"=" in entry:
            key, value = entry.split(b"=", 1)
            environment[key.decode(errors="replace")] = value.decode(errors="replace")
    if environment.get("SSL_CERT_FILE") != str(ca_cert):
        raise BenchError("measured server did not receive the exact ephemeral CA environment")
    if environment.get("LD_PRELOAD") != str(shim):
        raise BenchError("measured server did not receive the exact interception shim environment")
    if environment.get(FIXTURE_PORT_ENV) != str(fixture_port):
        raise BenchError("measured server did not receive the exact fixture port environment")
    children = Path(f"/proc/{pid}/task/{pid}/children")
    child_pids = [int(value) for value in children.read_text().split()] if children.exists() else []
    if child_pids:
        raise BenchError(f"Junban server spawned resident children: {child_pids}")
    return {
        "pid": pid,
        "executable": exe,
        "process_count": 1,
        "resident_node_processes": 0,
        "child_processes": 0,
        "fixture_outside_cgroup": True,
        "ssl_cert_file_exact": True,
        "ld_preload_exact": True,
        "fixture_port_environment_exact": True,
    }


class MemoryMonitor:
    def __init__(self, unit: str) -> None:
        self.unit = unit
        self.path = cgroup_path(unit)
        self.stop_event = threading.Event()
        self.maximum = 0
        self.samples = 0
        self.error: str | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                value = int((self.path / "memory.current").read_text().strip())
                self.maximum = max(self.maximum, value)
                self.samples += 1
            except (OSError, ValueError) as error:
                self.error = f"invalid cgroup memory sample: {error}"
            self.stop_event.wait(MEMORY_SAMPLE_SECONDS)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> dict[str, Any]:
        self.stop_event.set()
        self.thread.join(timeout=2)
        current = cgroup_memory(self.unit)
        self.maximum = max(self.maximum, current["current_bytes"])
        if self.samples == 0:
            raise BenchError(self.error or "memory monitor collected no samples")
        return {
            "samples": self.samples,
            "operation_peak_bytes": self.maximum,
            "operation_peak_mib": mib(self.maximum),
            "unit_absolute_peak_bytes": current["peak_bytes"],
            "unit_absolute_peak_mib": mib(current["peak_bytes"]),
        }


def start_server(
    repo: Path,
    server: Path,
    web_dir: Path,
    profile: Path,
    unit_base: str,
    ca_cert: Path,
    shim: Path,
    fixture_port: int,
) -> tuple[str, str, str]:
    unit = f"{unit_base}.service"
    run_cmd(
        [
            "systemd-run",
            "--user",
            f"--unit={unit_base}",
            "--collect",
            "--property=MemoryAccounting=yes",
            "--property=Type=exec",
            f"--setenv=SSL_CERT_FILE={ca_cert}",
            f"--setenv=LD_PRELOAD={shim}",
            f"--setenv={FIXTURE_PORT_ENV}={fixture_port}",
            "--setenv=HTTP_PROXY=",
            "--setenv=HTTPS_PROXY=",
            "--setenv=ALL_PROXY=",
            "--setenv=NO_PROXY=*",
            f"--working-directory={repo}",
            "--",
            str(server),
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            str(profile),
            "--web-dir",
            str(web_dir),
        ]
    )
    runtime = profile / RUNTIME_FILE
    holder: dict[str, Any] = {}

    def ready() -> bool:
        if not unit_exists(unit) or unit_property(unit, "ActiveState") == "failed":
            raise BenchError("measured server unit failed during startup")
        if not runtime.exists():
            return False
        try:
            holder["runtime"] = json.loads(runtime.read_text())
        except (OSError, json.JSONDecodeError):
            return False
        return "address" in holder["runtime"] and "instance_id" in holder["runtime"]

    poll_until(READY_TIMEOUT_SECONDS, ready, "measured server did not publish runtime metadata")
    address = holder["runtime"]["address"]
    if not str(address).startswith("127.0.0.1:"):
        raise BenchError("measured server did not bind loopback")
    base = f"http://{address}"

    def healthy() -> bool:
        try:
            payload, _ = plain_json("GET", f"{base}/api/v1/health", {"Host": address}, None, {200})
            return payload.get("instance_id") == holder["runtime"]["instance_id"]
        except BenchError:
            return False

    poll_until(READY_TIMEOUT_SECONDS, healthy, "measured server health did not become ready")
    return base, address, unit


def stop_server(unit: str) -> None:
    run_cmd(["systemctl", "--user", "stop", unit], check=False)

    def stopped() -> bool:
        if not unit_exists(unit):
            return True
        return unit_property(unit, "ActiveState") in {"inactive", "failed", "dead"} and unit_property(unit, "MainPID") in {"", "0"}

    try:
        poll_until(STOP_TIMEOUT_SECONDS, stopped, f"server unit {unit} did not stop")
    except BenchError:
        run_cmd(["systemctl", "--user", "kill", unit, "-s", "SIGKILL"], check=False)
        raise
    run_cmd(["systemctl", "--user", "reset-failed", unit], check=False)


def lock_available(profile: Path) -> bool:
    fd = os.open(profile / LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


class SseStream:
    def __init__(
        self,
        base: str,
        path: str,
        headers: dict[str, str],
        body: dict[str, Any],
        timeout: float = 75.0,
    ) -> None:
        parsed = urllib.parse.urlsplit(base)
        self.connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout)
        encoded = json.dumps(body, separators=(",", ":")).encode()
        all_headers = dict(headers)
        all_headers["Content-Type"] = "application/json"
        all_headers["Content-Length"] = str(len(encoded))
        self.started_ns = time.perf_counter_ns()
        self.connection.request("POST", path, body=encoded, headers=all_headers)
        self.response = self.connection.getresponse()
        if self.response.status != 200:
            raw = self.response.read()
            self.close()
            raise BenchError(f"SSE route returned {self.response.status}: {raw[:240]!r}")
        if "text/event-stream" not in self.response.getheader("Content-Type", ""):
            self.close()
            raise BenchError("SSE route returned wrong content type")
        self.buffer = bytearray()
        self.events: list[dict[str, Any]] = []
        self.first_event_ms: float | None = None

    def next_event(self) -> dict[str, Any]:
        while True:
            split = self.buffer.find(b"\n\n")
            if split >= 0:
                frame = bytes(self.buffer[:split])
                del self.buffer[: split + 2]
                for line in frame.splitlines():
                    if line.startswith(b"data: "):
                        try:
                            event = json.loads(line[6:])
                        except json.JSONDecodeError as error:
                            raise BenchError("Junban emitted malformed local SSE JSON") from error
                        if self.first_event_ms is None:
                            self.first_event_ms = (time.perf_counter_ns() - self.started_ns) / 1_000_000
                        self.events.append(event)
                        return event
                continue
            chunk = self.response.read(1)
            if not chunk:
                raise EOFError
            self.buffer.extend(chunk.replace(b"\r\n", b"\n"))
            if len(self.buffer) > 64 * 1024:
                raise BenchError("Junban local SSE frame exceeded 64 KiB")

    def until(self, event_type: str) -> dict[str, Any]:
        while True:
            event = self.next_event()
            if event.get("type") == event_type:
                return event

    def finish(self) -> tuple[list[dict[str, Any]], float, float]:
        try:
            while True:
                self.next_event()
        except EOFError:
            pass
        elapsed = (time.perf_counter_ns() - self.started_ns) / 1_000_000
        first = self.first_event_ms
        self.close()
        if first is None:
            raise BenchError("SSE stream emitted no event")
        validate_sse(self.events)
        return self.events, first, elapsed

    def close(self) -> None:
        self.response.close()
        self.connection.close()


def durable_replay_projection(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project live SSE onto the durable response replay contract.

    `run_started` carries a replay marker and provider usage is intentionally
    transient. Durable assistant text, tool transcript cards, and the terminal
    payload must replay exactly; sequence integrity is validated separately on
    both streams.
    """
    return [
        {
            "version": event.get("version"),
            "run_id": event.get("run_id"),
            "generation": event.get("generation"),
            "type": event.get("type"),
            "payload": event.get("payload"),
        }
        for event in events
        if event.get("type") not in {"run_started", "usage"}
    ]


def validate_sse(events: list[dict[str, Any]]) -> None:
    if not events or events[0].get("type") != "run_started":
        raise BenchError("SSE omitted initial run_started")
    versions = {event.get("version") for event in events}
    run_ids = {event.get("run_id") for event in events}
    generations = {event.get("generation") for event in events}
    sequences = [event.get("sequence") for event in events]
    terminals = [event for event in events if event.get("type") in TERMINALS]
    if versions != {1} or len(run_ids) != 1 or len(generations) != 1:
        raise BenchError("SSE identity/version changed within one stream")
    if sequences != list(range(sequences[0], sequences[0] + len(sequences))):
        raise BenchError("SSE sequence was duplicate or non-monotonic")
    if len(terminals) != 1 or events[-1] is not terminals[0]:
        raise BenchError("SSE did not end with exactly one terminal")
    encoded = json.dumps(events, separators=(",", ":"))
    for forbidden in ("provider-call", "private-provider", "STALE_AFTER_CANCEL"):
        if forbidden in encoded:
            raise BenchError("private or stale provider material crossed local SSE")


def run_response(
    base: str,
    host: str,
    token: str,
    session_id: str,
    message: str,
    operation: str | None = None,
) -> tuple[list[dict[str, Any]], float, float, str]:
    operation_id = operation or str(uuid.uuid4())
    stream = SseStream(
        base,
        f"/api/v1/ai/sessions/{session_id}/responses",
        auth_headers(token, host, True, operation_id),
        {"message": message},
    )
    events, first, elapsed = stream.finish()
    return events, first, elapsed, operation_id


def configure_profile(base: str, host: str, token: str, secrets_list: list[str]) -> str:
    config = {
        "ai": {
            "enabled": True,
            "provider": "openai",
            "model": MODEL_ID,
            "base_url": "https://api.openai.com/v1",
            "custom_instructions": "Answer briefly.",
            "daily_briefing_enabled": False,
            "default_energy": None,
            "auto_send": False,
            "smart_endpoint": False,
        },
        "voice": {
            "cloud_speech_enabled": True,
            "stt_provider": "openai",
            "stt_model": "whisper-1",
            "tts_provider": "openai",
            "tts_model": "tts-1",
            "tts_voice": "alloy",
            "tts_enabled": True,
            "voice_mode": "push_to_talk",
            "grace_period_ms": 1000,
        },
    }
    payload, _ = plain_json(
        "PUT",
        f"{base}/api/v1/ai/config",
        auth_headers(token, host, True),
        config,
        {200},
    )
    for target, secret in zip(("ai_provider", "voice_stt", "voice_tts"), secrets_list[1:]):
        response, _ = plain_json(
            "PUT",
            f"{base}/api/v1/ai/credentials/{target}",
            auth_headers(token, host, True),
            {"kind": "api_key", "secret": secret},
            {200},
        )
        ensure_secret_absent(json.dumps(response), secrets_list, f"{target} response")
        if response.get("credential", {}).get("present") is not True:
            raise BenchError(f"{target} credential was not confirmed")
    models, _ = plain_json(
        "GET",
        f"{base}/api/v1/ai/providers/openai/models",
        auth_headers(token, host, False),
        None,
        {200},
    )
    ids = [model.get("id") for model in models.get("models", [])]
    if ids != [MODEL_ID]:
        raise BenchError(f"model discovery mismatch: {ids}")
    created, _ = plain_json(
        "POST",
        f"{base}/api/v1/ai/sessions",
        auth_headers(token, host, True),
        {"title": "Phase 6 enabled benchmark"},
        {201},
    )
    return created["session"]["id"]


def drain_profile(base: str, host: str, token: str) -> dict[str, Any]:
    for target in ("ai_provider", "voice_stt", "voice_tts"):
        response, _ = plain_json(
            "DELETE",
            f"{base}/api/v1/ai/credentials/{target}",
            auth_headers(token, host, True),
            None,
            {200},
        )
        if response.get("credential") is not None:
            raise BenchError(f"{target} credential remained reachable after deletion")
    disabled = {
        "ai": {
            "enabled": False,
            "provider": None,
            "model": None,
            "base_url": None,
            "custom_instructions": "",
            "daily_briefing_enabled": False,
            "default_energy": None,
            "auto_send": False,
            "smart_endpoint": False,
        },
        "voice": {
            "cloud_speech_enabled": False,
            "stt_provider": "browser",
            "stt_model": None,
            "tts_provider": "browser",
            "tts_model": None,
            "tts_voice": None,
            "tts_enabled": True,
            "voice_mode": "push_to_talk",
            "grace_period_ms": 1000,
        },
    }
    confirmed, _ = plain_json(
        "PUT",
        f"{base}/api/v1/ai/config",
        auth_headers(token, host, True),
        disabled,
        {200},
    )
    maintenance, _ = plain_json(
        "GET",
        f"{base}/api/v1/maintenance/status",
        auth_headers(token, host, False),
        None,
        {200},
    )
    return {"config": confirmed, "maintenance": maintenance}


def task_titles(base: str, host: str, token: str) -> list[str]:
    payload, _ = plain_json(
        "GET", f"{base}/api/v1/tasks?limit=100", auth_headers(token, host, False), None, {200}
    )
    return [task["title"] for task in payload.get("tasks", [])]


def fixture_rounds(fixture: FixtureProcess, scenario: str) -> int:
    return int(fixture.status().get("scenario_rounds", {}).get(scenario, 0))


def profile_workload(
    index: int,
    base: str,
    host: str,
    token: str,
    session_id: str,
    fixture: FixtureProcess,
) -> dict[str, Any]:
    prefix = f"p{index}"
    first_events: list[float] = []
    completions: list[float] = []
    operation_checks: dict[str, Any] = {}

    for turn in range(SHORT_TURNS_PER_PROFILE):
        marker = f"short:{prefix}-{turn:02d}"
        events, first, elapsed, _ = run_response(
            base, host, token, session_id, f"phase6:{marker} short turn"
        )
        if events[-1]["type"] != "run_completed":
            raise BenchError(f"short turn {marker} did not complete")
        text = "".join(
            event.get("payload", {}).get("text", "")
            for event in events
            if event.get("type") == "text_delta"
        )
        if f"fixture-complete-{marker}-世" != text:
            raise BenchError(f"fragmented UTF-8 text mismatch for {marker}")
        first_events.append(first)
        completions.append(elapsed)

    read_marker = f"read:{prefix}"
    read_events, read_first, read_elapsed, _ = run_response(
        base, host, token, session_id, f"phase6:{read_marker} read projects"
    )
    if [event["type"] for event in read_events].count("tool_result") != 1:
        raise BenchError("read tool did not produce exactly one result")
    if read_events[-1]["type"] != "run_completed" or fixture_rounds(fixture, read_marker) != 2:
        raise BenchError("read tool did not continue through exactly two provider rounds")
    operation_checks["read_tool"] = {
        "passed": True,
        "provider_rounds": 2,
        "tool_results": 1,
        "first_event_ms": round(read_first, 4),
        "completed_ms": round(read_elapsed, 4),
    }

    reject_marker = f"reject:{prefix}"
    reject_stream = SseStream(
        base,
        f"/api/v1/ai/sessions/{session_id}/responses",
        auth_headers(token, host, True),
        {"message": f"phase6:{reject_marker} reject mutation"},
    )
    proposal = reject_stream.until("tool_proposed")
    approval_id = proposal["payload"]["approval_id"]
    action_hash = proposal["payload"]["action_hash"]
    rejected, _ = plain_json(
        "POST",
        f"{base}/api/v1/ai/approvals/{approval_id}/reject",
        auth_headers(token, host, True),
        {"action_hash": action_hash},
        {200},
    )
    reject_events, _, _ = reject_stream.finish()
    reject_types = [event["type"] for event in reject_events]
    rejected_title = f"phase6-rejected-{prefix}"
    if reject_types.count("tool_rejected") != 1 or reject_types.count("tool_result") != 1:
        raise BenchError("rejected mutation emitted duplicate/missing tool events")
    if rejected.get("result", {}).get("data", {}).get("code") != "tool_rejected":
        raise BenchError("rejected mutation result mismatch")
    if rejected_title in task_titles(base, host, token):
        raise BenchError("rejected mutation produced a task effect")
    if fixture_rounds(fixture, reject_marker) != 2:
        raise BenchError("rejected mutation did not continue exactly once")
    operation_checks["rejected_mutation"] = {"passed": True, "effects": 0, "provider_rounds": 2}

    approve_marker = f"approve:{prefix}"
    approve_operation = str(uuid.uuid4())
    approve_stream = SseStream(
        base,
        f"/api/v1/ai/sessions/{session_id}/responses",
        auth_headers(token, host, True, approve_operation),
        {"message": f"phase6:{approve_marker} approve mutation"},
    )
    proposal = approve_stream.until("tool_proposed")
    approval_id = proposal["payload"]["approval_id"]
    action_hash = proposal["payload"]["action_hash"]
    decision_operation = str(uuid.uuid4())
    decision_body = {"action_hash": action_hash}
    approved, _ = plain_json(
        "POST",
        f"{base}/api/v1/ai/approvals/{approval_id}/approve",
        auth_headers(token, host, True, decision_operation),
        decision_body,
        {200},
    )
    approve_events, _, _ = approve_stream.finish()
    approve_types = [event["type"] for event in approve_events]
    approved_title = f"phase6-approved-{prefix}"
    if approve_types.count("tool_approved") != 1 or approve_types.count("tool_result") != 1:
        raise BenchError("approved mutation emitted duplicate/missing tool events")
    if task_titles(base, host, token).count(approved_title) != 1:
        raise BenchError("approved mutation did not produce exactly one task")
    fixture_before_replay = fixture_rounds(fixture, approve_marker)
    if fixture_before_replay != 1:
        raise BenchError("approved mutation used an unexpected provider round count")
    replay_decision, _ = plain_json(
        "POST",
        f"{base}/api/v1/ai/approvals/{approval_id}/approve",
        auth_headers(token, host, True, decision_operation),
        decision_body,
        {200},
    )
    replay_events, _, _, _ = run_response(
        base,
        host,
        token,
        session_id,
        f"phase6:{approve_marker} approve mutation",
        approve_operation,
    )
    decision_replay_equal = replay_decision == approved
    response_replay_equal = durable_replay_projection(replay_events) == durable_replay_projection(
        approve_events
    )
    if not decision_replay_equal or not response_replay_equal:
        raise BenchError(
            "approved mutation exact replay changed "
            f"(decision_equal={decision_replay_equal}, response_equal={response_replay_equal}, "
            f"initial_types={[event['type'] for event in approve_events]}, "
            f"replay_types={[event['type'] for event in replay_events]})"
        )
    if fixture_rounds(fixture, approve_marker) != fixture_before_replay:
        raise BenchError("terminal replay performed provider egress")
    if task_titles(base, host, token).count(approved_title) != 1:
        raise BenchError("approved mutation replay duplicated its effect")
    operation_checks["approved_mutation"] = {
        "passed": True,
        "effects": 1,
        "provider_rounds": fixture_before_replay,
        "exact_replay": True,
    }

    retry_marker = f"retry:{prefix}"
    retry_events, _, _, _ = run_response(
        base, host, token, session_id, f"phase6:{retry_marker} retry before body"
    )
    if retry_events[-1]["type"] != "run_completed" or fixture_rounds(fixture, retry_marker) != 2:
        raise BenchError("retry-before-body did not use exactly two attempts")
    operation_checks["retry_before_body"] = {"passed": True, "attempts": 2}

    timeout_marker = f"timeout:{prefix}"
    timeout_events, _, timeout_elapsed, _ = run_response(
        base, host, token, session_id, f"phase6:{timeout_marker} production timeout"
    )
    if timeout_events[-1]["type"] != "run_failed":
        raise BenchError("provider timeout did not terminalize failed")
    if not fixture.wait_quiesced(timeout_marker, FIXTURE_QUIESCE_SECONDS):
        raise BenchError("timed-out provider connection did not quiesce")
    operation_checks["timeout"] = {
        "passed": True,
        "terminal": "run_failed",
        "elapsed_ms": round(timeout_elapsed, 4),
    }

    midstream_marker = f"midstream:{prefix}"
    midstream_events, _, _, _ = run_response(
        base, host, token, session_id, f"phase6:{midstream_marker} fail after body"
    )
    if midstream_events[-1]["type"] != "run_failed" or fixture_rounds(fixture, midstream_marker) != 1:
        raise BenchError("midstream failure retried or did not fail terminally")
    operation_checks["midstream_failure"] = {"passed": True, "attempts": 1}

    cancel_marker = f"cancel:{prefix}"
    cancel_stream = SseStream(
        base,
        f"/api/v1/ai/sessions/{session_id}/responses",
        auth_headers(token, host, True),
        {"message": f"phase6:{cancel_marker} cancellation race"},
    )
    started = cancel_stream.until("run_started")
    cancel_stream.until("text_delta")
    cancel_started = time.perf_counter_ns()
    cancellation, _ = plain_json(
        "POST",
        f"{base}/api/v1/ai/runs/{started['run_id']}/cancel",
        auth_headers(token, host, True),
        None,
        {200},
    )
    cancel_events, _, _ = cancel_stream.finish()
    quiesced = fixture.wait_quiesced(cancel_marker, FIXTURE_QUIESCE_SECONDS)
    cancel_ms = (time.perf_counter_ns() - cancel_started) / 1_000_000
    if cancel_events[-1]["type"] != "run_cancelled" or not quiesced:
        raise BenchError("cancellation did not terminalize and quiesce")
    if cancellation.get("status") not in {"cancel_requested", "already_terminal"}:
        raise BenchError("cancellation response status mismatch")
    operation_checks["cancellation"] = {
        "passed": True,
        "terminal": "run_cancelled",
        "provider_quiesced": True,
        "latency_ms": round(cancel_ms, 4),
    }

    boundary = f"phase6-public-{prefix}"
    marker = f"P6STT:{prefix}".encode("ascii") + b"\0"
    audio = marker + b"A" * (STT_BYTES - len(marker))
    multipart = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"\r\n"
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    stt_headers = auth_headers(token, host, True)
    stt_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    stt_raw, _, stt_ms = raw_request(
        "POST",
        f"{base}/api/v1/voice/transcriptions",
        stt_headers,
        multipart,
        {200},
        max_response_bytes=64 * 1024,
    )
    transcript = json.loads(stt_raw)["text"]
    if transcript != f"phase6-transcript-{prefix}":
        raise BenchError("1 MiB transcription result mismatch")

    tts_body = json.dumps({"text": f"phase6 synthesis {prefix}"}, separators=(",", ":")).encode()
    tts_headers = auth_headers(token, host, True)
    tts_headers["Content-Type"] = "application/json"
    tts_raw, tts_response_headers, tts_ms = raw_request(
        "POST",
        f"{base}/api/v1/voice/speech",
        tts_headers,
        tts_body,
        {200},
        max_response_bytes=TTS_BYTES,
    )
    if len(tts_raw) != TTS_BYTES or not tts_raw.startswith(b"ID3"):
        raise BenchError("1 MiB synthesis result mismatch")
    content_type = next(
        (value for key, value in tts_response_headers.items() if key.lower() == "content-type"), ""
    )
    if content_type != "audio/mpeg":
        raise BenchError("synthesis content type mismatch")

    messages, _ = plain_json(
        "GET",
        f"{base}/api/v1/ai/sessions/{session_id}/messages?limit=100",
        auth_headers(token, host, False),
        None,
        {200},
    )
    durable = json.dumps(messages, separators=(",", ":"))
    if "STALE_AFTER_CANCEL" in durable or rejected_title in task_titles(base, host, token):
        raise BenchError("stale provider or rejected mutation effect became durable")
    if durable.count("phase6-transcript-") or "ID3" in durable:
        raise BenchError("transcript/audio unexpectedly entered durable chat state")

    return {
        "first_event_ms": first_events,
        "completed_short_ms": completions,
        "cancellation_ms": [cancel_ms],
        "stt_ms": [stt_ms],
        "tts_ms": [tts_ms],
        "operations": operation_checks,
        "speech": {
            "stt_input_bytes": STT_BYTES,
            "stt_transcript_exact": True,
            "stt_latency_ms": round(stt_ms, 4),
            "tts_output_bytes": len(tts_raw),
            "tts_audio_exact": True,
            "tts_latency_ms": round(tts_ms, 4),
        },
        "stale_effects_absent": True,
        "duplicate_effects_absent": True,
    }


def run_profile(
    repo: Path,
    root: Path,
    server: Path,
    web_dir: Path,
    ca_cert: Path,
    shim: Path,
    fixture: FixtureProcess,
    index: int,
) -> tuple[dict[str, Any], list[str]]:
    profile = root / f"profile-{index}"
    secrets_list = [os.urandom(32).hex() for _ in range(4)]
    token = secrets_list[0]
    profile_prepare(profile, token)
    unit_base = f"junban-p6-enabled-{os.getpid()}-{index}-{uuid.uuid4().hex[:8]}"
    base = host = unit = ""
    monitor: MemoryMonitor | None = None
    workload: dict[str, Any] | None = None
    report: dict[str, Any] = {"profile": index, "fresh_profile": True}
    stopped = False
    try:
        base, host, unit = start_server(
            repo,
            server,
            web_dir,
            profile,
            unit_base,
            ca_cert,
            shim,
            fixture.tls_port,
        )
        process = process_snapshot(
            unit,
            server.name,
            fixture.process.pid,
            ca_cert,
            shim,
            fixture.tls_port,
        )
        session_id = configure_profile(base, host, token, secrets_list)
        time.sleep(SETTLE_SECONDS)
        pre = memory_snapshot(unit)
        monitor = MemoryMonitor(unit)
        monitor.start()
        workload = profile_workload(index, base, host, token, session_id, fixture)
        time.sleep(SETTLE_SECONDS)
        post_session = memory_snapshot(unit)
        drain = drain_profile(base, host, token)
        time.sleep(SETTLE_SECONDS)
        post_drain = memory_snapshot(unit)
        measured_peak = monitor.stop()
        monitor = None
        if fixture.status().get("active_connections") != 0:
            raise BenchError("provider/speech fixture retained active connections after drain")
        if drain["config"]["ai"]["enabled"] or drain["config"]["voice"]["cloud_speech_enabled"]:
            raise BenchError("confirmed AI/voice settings remained enabled after drain")
        report.update(
            {
                "process": process,
                "pre_session": {
                    "current_bytes": pre["current_bytes"],
                    "current_mib": mib(pre["current_bytes"]),
                    "memory_stat": pre["memory_stat"],
                },
                "post_session": {
                    "current_bytes": post_session["current_bytes"],
                    "current_mib": mib(post_session["current_bytes"]),
                    "memory_stat": post_session["memory_stat"],
                },
                "post_drain": {
                    "current_bytes": post_drain["current_bytes"],
                    "current_mib": mib(post_drain["current_bytes"]),
                    "growth_bytes": post_drain["current_bytes"] - pre["current_bytes"],
                    "growth_mib": round(
                        (post_drain["current_bytes"] - pre["current_bytes"]) / 1_048_576.0, 4
                    ),
                    "memory_stat": post_drain["memory_stat"],
                },
                "memory_peak": measured_peak,
                "workload": workload,
                "maintenance_status_reachable_after_drain": bool(drain["maintenance"]),
                "runtime_cleanup_before_shutdown": True,
            }
        )
        stop_server(unit)
        stopped = True
        poll_until(5, lambda: not (profile / RUNTIME_FILE).exists(), "runtime metadata lingered")
        poll_until(5, lambda: lock_available(profile), "profile lock remained held")
        journal = run_cmd(
            ["journalctl", "--user", "-u", unit, "--no-pager", "-o", "cat"], check=False
        )
        journal_text = (journal.stdout or "") + (journal.stderr or "")
        ensure_secret_absent(journal_text, secrets_list, "server journal")
        for artifact in ("ai-secrets.json", TOKEN_FILE):
            if (profile / artifact).exists():
                ensure_secret_absent((profile / artifact).read_bytes(), [], artifact)
        report.update(
            {
                "server_stopped": True,
                "runtime_metadata_removed": True,
                "profile_lock_reacquired": True,
                "journal_secret_scan_passed": True,
                "cleanup_passed": True,
            }
        )
    finally:
        if monitor is not None:
            try:
                monitor.stop()
            except BenchError:
                pass
        if unit and not stopped:
            try:
                stop_server(unit)
            except BenchError:
                pass
        shutil.rmtree(profile, ignore_errors=True)
    if profile.exists():
        raise BenchError("fresh profile directory was not removed")
    report["profile_artifacts_removed"] = True
    return report, secrets_list


def protocol() -> dict[str, Any]:
    return {
        "name": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "profiles": PROFILES,
        "fresh_profiles": True,
        "short_streamed_turns_per_profile": SHORT_TURNS_PER_PROFILE,
        "provider_fixture": "standalone Python stdlib TLS process outside measured cgroup",
        "interception": {
            "hostname": OFFICIAL_HOST,
            "sentinel_ip": SENTINEL_IP,
            "resolver": "ephemeral LD_PRELOAD getaddrinfo exact-host mapping",
            "connection": "ephemeral LD_PRELOAD exact sentinel:443 high-port rewrite",
            "fixture_port_environment": FIXTURE_PORT_ENV,
            "fixture_bind": "127.0.0.1:0 (kernel-selected unprivileged high port)",
            "trust": "ephemeral CA via SSL_CERT_FILE in measured server environment only",
            "privileged_bind_required": False,
            "system_hosts_or_trust_modified": False,
            "http_proxy_used": False,
        },
        "operations_per_profile": [
            "model_discovery",
            "30_fragmented_utf8_sse_short_turns",
            "one_read_tool",
            "one_rejected_mutation",
            "one_approved_mutation_exactly_once",
            "retry_before_body",
            "production_timeout",
            "midstream_failure",
            "cancellation_race",
            "1_mib_stt",
            "1_mib_tts",
            "idle_drain_cleanup",
        ],
        "budgets": {
            "first_event_p95_ms": FIRST_EVENT_P95_MS,
            "completed_short_turn_p95_ms": COMPLETED_SHORT_P95_MS,
            "cancellation_terminal_quiesced_p95_ms": CANCEL_QUIESCED_P95_MS,
            "stt_1mib_p95_ms": STT_P95_MS,
            "tts_1mib_p95_ms": TTS_P95_MS,
            "post_session_warm_max_mib": POST_SESSION_WARM_MIB,
            "operation_peak_max_mib": OPERATION_PEAK_MIB,
            "post_drain_growth_max_mib": POST_DRAIN_GROWTH_MIB,
            "rust_server_processes": 1,
            "resident_node_processes": 0,
        },
        "no_waivers": True,
    }


def aggregate(profiles: list[dict[str, Any]], fixture_status: dict[str, Any]) -> dict[str, Any]:
    first = [value for profile in profiles for value in profile["workload"]["first_event_ms"]]
    completed = [
        value for profile in profiles for value in profile["workload"]["completed_short_ms"]
    ]
    cancellation = [
        value for profile in profiles for value in profile["workload"]["cancellation_ms"]
    ]
    stt = [value for profile in profiles for value in profile["workload"]["stt_ms"]]
    tts = [value for profile in profiles for value in profile["workload"]["tts_ms"]]
    warm = [profile["post_session"]["current_mib"] for profile in profiles]
    peak = [profile["memory_peak"]["operation_peak_mib"] for profile in profiles]
    absolute_peak = [profile["memory_peak"]["unit_absolute_peak_mib"] for profile in profiles]
    growth = [profile["post_drain"]["growth_mib"] for profile in profiles]
    metrics = {
        "first_event_ms": series(first),
        "completed_short_turn_ms": series(completed),
        "cancellation_terminal_quiesced_ms": series(cancellation),
        "stt_1mib_ms": series(stt),
        "tts_1mib_ms": series(tts),
        "post_session_warm_mib": series(warm),
        "operation_peak_mib": series(peak),
        "unit_absolute_peak_mib": series(absolute_peak),
        "post_drain_growth_mib": series(growth),
    }
    gates = {
        "first_event_p95": metrics["first_event_ms"]["p95"] <= FIRST_EVENT_P95_MS,
        "completed_short_turn_p95": metrics["completed_short_turn_ms"]["p95"]
        <= COMPLETED_SHORT_P95_MS,
        "cancellation_terminal_quiesced_p95": metrics[
            "cancellation_terminal_quiesced_ms"
        ]["p95"]
        <= CANCEL_QUIESCED_P95_MS,
        "stt_1mib_p95": metrics["stt_1mib_ms"]["p95"] <= STT_P95_MS,
        "tts_1mib_p95": metrics["tts_1mib_ms"]["p95"] <= TTS_P95_MS,
        "post_session_warm": max(warm) <= POST_SESSION_WARM_MIB,
        "operation_peak": max(max(peak), max(absolute_peak)) <= OPERATION_PEAK_MIB,
        "post_drain_growth": max(growth) <= POST_DRAIN_GROWTH_MIB,
        "process_boundary": all(
            profile["process"]["process_count"] == 1
            and profile["process"]["resident_node_processes"] == 0
            for profile in profiles
        ),
        "operation_matrix": all(
            all(check["passed"] for check in profile["workload"]["operations"].values())
            and profile["workload"]["stale_effects_absent"]
            and profile["workload"]["duplicate_effects_absent"]
            for profile in profiles
        ),
        "speech_exact": fixture_status.get("stt_audio_sizes") == [STT_BYTES] * PROFILES
        and fixture_status.get("tts_response_sizes") == [TTS_BYTES] * PROFILES,
        "fixture_request_matrix": fixture_status.get("requests")
        == {
            "/v1/audio/speech": PROFILES,
            "/v1/audio/transcriptions": PROFILES,
            "/v1/models": PROFILES,
            "/v1/responses": 40 * PROFILES,
        }
        and fixture_status.get("authenticated_requests") == 43 * PROFILES,
        "fixture_bounded": not fixture_status.get("errors")
        and fixture_status.get("active_connections") == 0
        and 0 < fixture_status.get("fragment_max_bytes", 0) <= max((1, 2, 5, 3, 7, 4, 11)),
        "cleanup": all(profile.get("cleanup_passed") for profile in profiles),
        "secret_scans": all(profile.get("journal_secret_scan_passed") for profile in profiles),
    }
    return {"metrics": metrics, "gates": gates, "all_gates_passed": all(gates.values())}


def metadata(repo: Path, server: Path, web_dir: Path) -> dict[str, Any]:
    commit = (run_cmd(["git", "rev-parse", "HEAD"]).stdout or "").strip()
    status = run_cmd(["git", "status", "--porcelain"]).stdout or ""
    rustc = (run_cmd(["rustc", "-Vv"]).stdout or "").splitlines()
    return {
        "git_commit": commit,
        "git_dirty_before_run": bool(status.strip()),
        "server": {
            "path": str(server.relative_to(repo)),
            "size_bytes": server.stat().st_size,
            "sha256": sha256_file(server),
        },
        "web_dir": str(web_dir.relative_to(repo)),
        "rustc_release": next((line.split(":", 1)[1].strip() for line in rustc if line.startswith("release:")), None),
        "kernel": os.uname().release,
        "machine": os.uname().machine,
        "cpu_count": os.cpu_count(),
    }


def self_check(repo: Path) -> None:
    require_environment()
    # Evidence-only memory.stat parsing/serialization (no cgroup, no gate changes).
    parsed = parse_memory_stat(
        "anon 1048576\nfile 2097152\ninactive_anon 0\n# comment ignored\nbogus\n"
    )
    assert parsed["anon"] == 1_048_576
    assert parsed["file"] == 2_097_152
    summary = memory_stat_summary(parsed)
    assert summary == {
        "anon_bytes": 1_048_576,
        "file_bytes": 2_097_152,
        "anon_mib": 1.0,
        "file_mib": 2.0,
    }
    try:
        parse_memory_stat("only_one_field\n")
        raise AssertionError("missing anon/file must fail closed")
    except BenchError:
        pass
    try:
        parse_memory_stat("anon not-an-int\nfile 1\n")
        raise AssertionError("invalid integer must fail closed")
    except BenchError:
        pass
    encoded = json.dumps(
        {
            "pre_session": {"memory_stat": summary},
            "post_session": {"memory_stat": summary},
            "post_drain": {"memory_stat": summary},
        },
        sort_keys=True,
    )
    round_trip = json.loads(encoded)
    assert round_trip["pre_session"]["memory_stat"]["anon_bytes"] == 1_048_576
    assert round_trip["post_drain"]["memory_stat"]["file_mib"] == 2.0

    fixture_check = run_cmd([sys.executable, str(repo / FIXTURE_SCRIPT), "--self-check"])
    if "self-check passed" not in (fixture_check.stdout or ""):
        raise BenchError("standalone fixture self-check did not report success")
    require_unprivileged_loopback_bind()
    hosts_before = sha256_file(Path("/etc/hosts"))
    with tempfile.TemporaryDirectory(prefix="junban-p6-enabled-self-check-") as temporary:
        root = Path(temporary)
        pki = generate_pki(root)
        shim, _ = compile_shim(repo, root)
        fixture = FixtureProcess(repo, root, pki)
        try:
            delegation = shim_delegation_self_checks(shim, fixture.tls_port)
            if not all(delegation.values()):
                raise BenchError("interception delegation self-check failed")
            interception_probe(shim, pki["ca_cert"], fixture.tls_port)
            status = fixture.status()
            if status.get("requests", {}).get("/__fixture/health") != 1:
                raise BenchError("interception probe did not reach the standalone fixture")
        finally:
            fixture.stop()
    if sha256_file(Path("/etc/hosts")) != hosts_before:
        raise BenchError("/etc/hosts changed during interception self-check")
    print("phase6 enabled benchmark self-check passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, default=Path("target/release/junban-server"))
    parser.add_argument("--web-dir", type=Path, default=Path("dist"))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--authoritative", action="store_true")
    mode.add_argument("--preliminary", action="store_true")
    parser.add_argument(
        "--idle-host-confirmed",
        action="store_true",
        help="required operator attestation for an authoritative run",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    os.chdir(repo)
    if args.self_check:
        if args.authoritative or args.preliminary or args.idle_host_confirmed or args.build:
            raise BenchError("--self-check cannot be combined with run/build flags")
        self_check(repo)
        return 0
    if not args.authoritative and not args.preliminary:
        raise BenchError("choose exactly one of --authoritative or --preliminary")
    if args.authoritative and not args.idle_host_confirmed:
        raise BenchError("authoritative run requires --idle-host-confirmed")
    if args.preliminary and args.idle_host_confirmed:
        raise BenchError("preliminary run cannot carry idle-host attestation")
    require_environment()
    if args.build:
        run_cmd(["cargo", "build", "--locked", "--release", "-p", "junban-server"], timeout=1800)
    server = (repo / args.server).resolve()
    web_dir = (repo / args.web_dir).resolve()
    if not server.is_file() or not os.access(server, os.X_OK):
        raise BenchError("optimized junban-server binary is missing or not executable")
    if not (web_dir / "index.html").is_file():
        raise BenchError("production web assets are missing")
    require_unprivileged_loopback_bind()
    output = (repo / args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    hosts_before = sha256_file(Path("/etc/hosts"))
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    profiles: list[dict[str, Any]] = []
    generated_secrets: list[str] = []
    fixture_cleanup: dict[str, Any] | None = None
    fixture_status: dict[str, Any] = {}
    temporary_removed = False
    with tempfile.TemporaryDirectory(prefix="junban-p6-enabled-") as temporary:
        root = Path(temporary)
        pki = generate_pki(root)
        shim, shim_metadata = compile_shim(repo, root)
        fixture = FixtureProcess(repo, root, pki)
        delegation_evidence: dict[str, Any] = {}
        try:
            delegation_evidence = shim_delegation_self_checks(shim, fixture.tls_port)
            for index in range(PROFILES):
                profile, profile_secrets = run_profile(
                    repo,
                    root,
                    server,
                    web_dir,
                    pki["ca_cert"],
                    shim,
                    fixture,
                    index,
                )
                profiles.append(profile)
                generated_secrets.extend(profile_secrets)
            fixture_status = fixture.status()
            if fixture_status.get("active_connections") != 0 or fixture_status.get("errors"):
                raise BenchError("fixture was not clean after the operation matrix")
        finally:
            fixture_cleanup = fixture.stop()
        report = {
            "protocol": protocol(),
            "status": "authoritative" if args.authoritative else "preliminary_contended_host",
            "authoritative": bool(args.authoritative),
            "idle_host_confirmed": bool(args.idle_host_confirmed),
            "started_at_utc": started_at,
            "completed_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "metadata": metadata(repo, server, web_dir),
            "interception_evidence": {
                "pki": pki["metadata"],
                "shim": shim_metadata,
                "ssl_cert_file_scope": "measured junban-server unit only",
                "ld_preload_scope": "measured server plus isolated delegation probes",
                "fixed_origin_model_discovery_passed": True,
                "delegation_self_checks": delegation_evidence,
                "unprivileged_fixture_port": fixture.tls_port,
                "privileged_bind_required": False,
                "etc_hosts_sha256_before": hosts_before,
                "etc_hosts_sha256_after": sha256_file(Path("/etc/hosts")),
            },
            "profiles": profiles,
            "fixture": fixture_status,
            "fixture_cleanup": fixture_cleanup,
        }
        report["summary"] = aggregate(profiles, fixture_status)
        report["accepted"] = bool(args.authoritative and report["summary"]["all_gates_passed"])
        if not args.authoritative:
            report["acceptance_note"] = (
                "Preliminary runs never satisfy retained acceptance, even when every numeric gate passes."
            )
        serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
        ensure_secret_absent(serialized, generated_secrets, "machine-readable evidence")
        output.write_text(serialized, encoding="utf-8")
    temporary_removed = not Path(temporary).exists()
    if not temporary_removed:
        raise BenchError("ephemeral CA/shim/profile root remained after run")
    if sha256_file(Path("/etc/hosts")) != hosts_before:
        raise BenchError("/etc/hosts changed during benchmark")
    # Reopen the report only to add proof established after TemporaryDirectory cleanup.
    report = json.loads(output.read_text(encoding="utf-8"))
    report["cleanup_proof"] = {
        "temporary_root_removed": True,
        "private_keys_retained": False,
        "compiled_shim_retained": False,
        "fixture_process_gone": bool(fixture_cleanup and fixture_cleanup["process_gone"]),
        "fixture_listener_released": bool(fixture_cleanup and fixture_cleanup["listener_released"]),
        "profile_directories_removed": all(
            profile.get("profile_artifacts_removed") for profile in profiles
        ),
        "server_units_stopped": all(profile.get("server_stopped") for profile in profiles),
        "locks_reacquired": all(profile.get("profile_lock_reacquired") for profile in profiles),
        "system_trust_modified": False,
        "etc_hosts_modified": False,
    }
    cleanup = report["cleanup_proof"]
    report["summary"]["gates"]["cleanup"] = all(
        cleanup[key]
        for key in (
            "temporary_root_removed",
            "fixture_process_gone",
            "fixture_listener_released",
            "profile_directories_removed",
            "server_units_stopped",
            "locks_reacquired",
        )
    ) and all(
        not cleanup[key]
        for key in (
            "private_keys_retained",
            "compiled_shim_retained",
            "system_trust_modified",
            "etc_hosts_modified",
        )
    )
    report["summary"]["all_gates_passed"] = all(report["summary"]["gates"].values())
    report["accepted"] = bool(args.authoritative and report["summary"]["all_gates_passed"])
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    ensure_secret_absent(serialized, generated_secrets, "final machine-readable evidence")
    output.write_text(serialized, encoding="utf-8")
    try:
        output_display = str(output.relative_to(repo))
    except ValueError:
        output_display = str(output)
    print(
        f"{PROTOCOL_NAME}: {'ACCEPTED' if report['accepted'] else report['status']} "
        f"({output_display})"
    )
    return 0 if (report["accepted"] or args.preliminary) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BenchError, OSError, subprocess.TimeoutExpired) as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        raise SystemExit(2)
