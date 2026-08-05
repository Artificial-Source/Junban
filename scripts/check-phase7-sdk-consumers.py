#!/usr/bin/env python3
"""Regenerate/check the real Phase 7 Rust and TypeScript WIT consumers."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SDK = ROOT / "crates" / "junban-plugin-sdk"
RUST = SDK / "consumers" / "rust"
TS = SDK / "consumers" / "typescript"
AUTHORITY = SDK / "wit" / "plugin.wit"
DEPENDENCIES = [RUST / "wit/deps/junban-plugin/plugin.wit", TS / "wit/deps/junban-plugin/plugin.wit"]
RUST_ARTIFACT = RUST / "rust-consumer.wasm"
TS_ARTIFACT = TS / "artifacts/typescript-consumer.wasm"
PROVENANCE = SDK / "consumers" / "artifact-provenance.json"
EXPECTED_RUST = {
    "junban:plugin/types@0.1.0",
    "junban:plugin/host-tasks@0.1.0",
    "junban:plugin/host-settings@0.1.0",
    "junban:plugin/host-storage@0.1.0",
    "junban:plugin/host-log@0.1.0",
    "wasi:io/error@0.2.6",
    "wasi:io/streams@0.2.6",
    "wasi:cli/environment@0.2.6",
    "wasi:cli/exit@0.2.6",
    "wasi:cli/stderr@0.2.6",
}
EXPECTED_TS = {name for name in EXPECTED_RUST if not name.startswith("wasi:")} | {
    "junban:plugin/host-services@0.1.0",
}


def run(args: list[str], cwd: Path, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=capture)
    return result.stdout if capture else ""


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def imports(jco: Path, artifact: Path) -> set[str]:
    rendered = run([str(jco), "wit", str(artifact)], ROOT, capture=True)
    return {
        line.strip().removeprefix("import ").removesuffix(";")
        for line in rendered.splitlines()
        if line.strip().startswith("import ")
    }


def provenance() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "authority": "crates/junban-plugin-sdk/wit/plugin.wit",
        "witSha256": digest(AUTHORITY),
        "rust": {
            "toolchain": "rustc 1.93.0",
            "target": "wasm32-wasip2",
            "witBindgen": "0.51.0",
            "sizeBytes": RUST_ARTIFACT.stat().st_size,
            "sha256": digest(RUST_ARTIFACT),
        },
        "typescript": {
            "jco": "1.26.1",
            "componentizeJs": "0.22.0",
            "wasi": "--disable all",
            "byteReproducible": False,
            "sizeBytes": TS_ARTIFACT.stat().st_size,
            "sha256": digest(TS_ARTIFACT),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--regenerate", action="store_true")
    options = parser.parse_args()

    source = AUTHORITY.read_bytes()
    for dependency in DEPENDENCIES:
        if options.regenerate:
            dependency.write_bytes(source)
        elif dependency.read_bytes() != source:
            raise SystemExit(f"WIT dependency drift: {dependency.relative_to(ROOT)}")

    wit_bindgen = shutil.which("wit-bindgen")
    if not wit_bindgen:
        raise SystemExit("wit-bindgen-cli 0.51.0 is required")
    version = run([wit_bindgen, "--version"], ROOT, capture=True).strip()
    if version != "wit-bindgen-cli 0.51.0":
        raise SystemExit(f"expected wit-bindgen 0.51.0, got {version}")
    bindgen = [wit_bindgen, "rust", "wit", "--world", "rust-consumer", "--generate-all", "--generate-unused-types", "--out-dir", "generated", "--format"]
    if not options.regenerate:
        bindgen.append("--check")
    run(bindgen, RUST)

    run(["cargo", "check", "--locked", "--target", "wasm32-wasip2"], RUST)
    run(["cargo", "build", "--locked", "--release", "--target", "wasm32-wasip2"], RUST)
    built_rust = RUST / "target/wasm32-wasip2/release/junban_plugin_sdk_rust_consumer.wasm"
    if options.regenerate:
        shutil.copyfile(built_rust, RUST_ARTIFACT)
    elif built_rust.read_bytes() != RUST_ARTIFACT.read_bytes():
        raise SystemExit("Rust consumer artifact drifted")

    jco = TS / "node_modules/.bin" / ("jco.cmd" if os.name == "nt" else "jco")
    if not jco.exists():
        raise SystemExit("TypeScript consumer dependencies missing; run npm ci in its directory")
    if run([str(jco), "--version"], TS, capture=True).strip() != "1.26.1":
        raise SystemExit("expected jco 1.26.1")

    if options.regenerate:
        shutil.rmtree(TS / "generated", ignore_errors=True)
        run([str(jco), "guest-types", "wit", "-n", "typescript-consumer", "-o", "generated", "--strict", "--quiet"], TS)
        for binding in (TS / "generated").rglob("*.d.ts"):
            lines = binding.read_text(encoding="utf-8").splitlines()
            binding.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="utf-8")
    run([sys.executable, "-c", "import pathlib; assert pathlib.Path('generated/typescript-consumer.d.ts').is_file()"], TS)

    tsc = ROOT / "node_modules/.bin" / ("tsc.cmd" if os.name == "nt" else "tsc")
    if not tsc.exists():
        raise SystemExit("root TypeScript compiler missing; run pnpm install --frozen-lockfile")
    run([str(tsc), "-p", "tsconfig.json", "--pretty", "false"], TS)

    run(["node", "build.mjs", "--build" if options.regenerate else "--check"], TS)

    if imports(jco, RUST_ARTIFACT) != EXPECTED_RUST:
        raise SystemExit("Rust import set drifted")
    if imports(jco, TS_ARTIFACT) != EXPECTED_TS:
        raise SystemExit("TypeScript import set/WASI-zero authority drifted")
    if TS_ARTIFACT.stat().st_size > 32 * 1024 * 1024:
        raise SystemExit("TypeScript component exceeds the 32 MiB JBP1 component ceiling")

    expected = json.dumps(provenance(), indent=2) + "\n"
    if options.regenerate:
        PROVENANCE.write_text(expected, encoding="utf-8")
    elif PROVENANCE.read_text(encoding="utf-8") != expected:
        raise SystemExit("consumer provenance drifted")
    print("Phase 7 SDK consumer sources, retained hashes, and structures are exact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
