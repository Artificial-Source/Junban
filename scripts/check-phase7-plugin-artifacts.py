#!/usr/bin/env python3
"""Public-only Phase 7 reference artifact and product include verification."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parent.parent
REFERENCES = ROOT / "plugins" / "reference"
REFERENCE_DIRECTORIES = ("automation-rust", "import-typescript", "pomodoro-rust")
EXPECTED_REFERENCE_IDS = ("automation", "import-typescript", "pomodoro")
REGISTRY = ROOT / "plugins" / "registry"
REGISTRY_SOURCE_METADATA = REGISTRY / "registry-source.json"
ROOT_PUBLIC_KEY = REGISTRY / "root-public-key.bin"
PUBLISHER_PUBLIC_KEY = REGISTRY / "publisher-public-key.bin"
INDEX = REGISTRY / "index.jri"
PACKAGES = REGISTRY / "sha256"
INCLUDE_TABLE = ROOT / "crates" / "junban-server" / "src" / "bundled_registry_include.rs"
OUTPUT_BYTES_MAX = 8 * 1024


def fail(message: str) -> NoReturn:
    print(f"Phase 7 plugin artifact check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_file(path: Path, label: str) -> None:
    if not path.is_file() or path.is_symlink():
        fail(f"canonical {label} is missing or is not a regular file")


def require_exact_references() -> None:
    if not REFERENCES.is_dir() or REFERENCES.is_symlink():
        fail("canonical reference directory is missing or unsafe")
    actual = []
    try:
        with os.scandir(REFERENCES) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    fail("canonical reference directory contains a non-directory entry")
                actual.append(entry.name)
    except OSError:
        fail("canonical reference directory could not be read safely")
    if tuple(sorted(actual)) != REFERENCE_DIRECTORIES:
        fail(
            "immediate reference directories must be exactly automation-rust, "
            "import-typescript, pomodoro-rust"
        )
    for directory in REFERENCE_DIRECTORIES:
        require_file(REFERENCES / directory / "plugin-source.json", f"{directory} source manifest")


def require_exact_reference_ids() -> None:
    actual = []
    for directory in REFERENCE_DIRECTORIES:
        source = REFERENCES / directory / "plugin-source.json"
        try:
            manifest = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            fail("canonical reference ID preflight could not read a source manifest")
        reference_id = manifest.get("id") if isinstance(manifest, dict) else None
        if not isinstance(reference_id, str):
            fail("canonical reference ID preflight found a missing or invalid ID")
        actual.append(reference_id)
    if tuple(sorted(actual)) != EXPECTED_REFERENCE_IDS:
        fail("immediate reference IDs must be exactly automation, import-typescript, pomodoro")


def bounded_output(completed: subprocess.CompletedProcess[bytes]) -> str:
    output = completed.stdout + completed.stderr
    if len(output) > OUTPUT_BYTES_MAX:
        output = output[-OUTPUT_BYTES_MAX:]
        prefix = "[tool output truncated to final 8192 bytes]\n"
    else:
        prefix = ""
    return prefix + output.decode("utf-8", errors="replace").strip()


class ArtifactTool:
    def __init__(self, exact_path: Path | None) -> None:
        if exact_path is None:
            self.command = [
                "cargo",
                "run",
                "--quiet",
                "--locked",
                "-p",
                "junban-plugin-sdk",
                "--features",
                "artifact-cli",
                "--bin",
                "junban-plugin-artifact",
                "--",
            ]
            return
        try:
            resolved = exact_path.expanduser().resolve(strict=True)
        except OSError:
            fail("the exact artifact tool path is missing or unsafe")
        if not resolved.is_file():
            fail("the exact artifact tool path is not a regular file")
        self.command = [str(resolved)]

    def run(self, label: str, *arguments: str | Path) -> None:
        command = [*self.command, *(str(argument) for argument in arguments)]
        try:
            completed = subprocess.run(
                command,
                cwd=ROOT,
                check=False,
                capture_output=True,
                timeout=600,
            )
        except (OSError, subprocess.TimeoutExpired):
            fail(f"{label} could not run to completion")
        if completed.returncode != 0:
            output = bounded_output(completed)
            if output:
                print(output, file=sys.stderr)
            fail(f"{label} was rejected")
        print(f"Phase 7 plugin artifact check: {label} passed")


def check_source_manifests(tool: ArtifactTool) -> None:
    for directory in REFERENCE_DIRECTORIES:
        tool.run(
            f"source manifest ({directory})",
            "source-manifest",
            "check",
            REFERENCES / directory / "plugin-source.json",
        )
    require_exact_reference_ids()


def strict_check(tool: ArtifactTool) -> None:
    require_file(REGISTRY_SOURCE_METADATA, "registry source metadata")
    require_file(ROOT_PUBLIC_KEY, "registry root public key")
    require_file(PUBLISHER_PUBLIC_KEY, "publisher public key")
    require_file(INDEX, "registry index")
    require_file(INCLUDE_TABLE, "server registry include module")
    if not PACKAGES.is_dir() or PACKAGES.is_symlink():
        fail("canonical registry sha256 package directory is missing or unsafe")

    tool.run(
        "signed registry and references",
        "registry",
        "verify",
        "--references",
        REFERENCES,
        "--metadata",
        REGISTRY_SOURCE_METADATA,
        "--root-public-key",
        ROOT_PUBLIC_KEY,
        "--publisher-public-key",
        PUBLISHER_PUBLIC_KEY,
        "--index",
        INDEX,
        "--packages",
        PACKAGES,
        "--include-table",
        INCLUDE_TABLE,
    )
    tool.run(
        "generated server include table",
        "registry",
        "include-table",
        "--root-public-key",
        ROOT_PUBLIC_KEY,
        "--publisher-public-key",
        PUBLISHER_PUBLIC_KEY,
        "--index",
        INDEX,
        "--packages",
        PACKAGES,
        "--output",
        INCLUDE_TABLE,
        "--check",
    )
    print("Phase 7 strict public artifact verification passed")


def bootstrap_check(tool: ArtifactTool) -> None:
    if PUBLISHER_PUBLIC_KEY.exists() or PACKAGES.exists():
        fail("bootstrap mode is only permitted before publisher/package ceremony outputs exist")
    require_file(ROOT_PUBLIC_KEY, "registry root public key")
    require_file(INDEX, "registry index")
    require_file(INCLUDE_TABLE, "server registry include module")

    # The SDK verifier proves that the signed current index agrees with an empty
    # package set and generates the exact empty include table. The existing root
    # public key is also a valid non-secret placeholder for the publisher input;
    # publisher authority is vacuous because the package set must be empty.
    with tempfile.TemporaryDirectory(prefix="junban-plugin-bootstrap-") as temporary:
        tool.run(
            "empty signed registry and generated server include table (bootstrap only)",
            "registry",
            "include-table",
            "--root-public-key",
            ROOT_PUBLIC_KEY,
            "--publisher-public-key",
            ROOT_PUBLIC_KEY,
            "--index",
            INDEX,
            "--packages",
            temporary,
            "--output",
            INCLUDE_TABLE,
            "--check",
        )
    print(
        "BOOTSTRAP ONLY: source manifests and the current empty server include table passed; "
        "no signed reference package verification is claimed"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Public-only verification of the three canonical Phase 7 references, signed registry, "
            "and generated server include table. Strict verification is the default and intentionally "
            "fails before ceremony outputs exist."
        ),
        epilog=(
            "Pre-ceremony only: --bootstrap-empty validates exactly the three source manifests and "
            "proves the current signed registry/include table are empty. It does not verify or claim "
            "signed reference artifacts. After the ceremony, CI must use strict mode without this flag."
        ),
    )
    parser.add_argument(
        "--bootstrap-empty",
        action="store_true",
        help="run the explicit pre-ceremony empty-registry check (not final artifact evidence)",
    )
    parser.add_argument(
        "--tool",
        type=Path,
        metavar="EXACT_JUNBAN_PLUGIN_ARTIFACT_PATH",
        help="invoke this exact built artifact tool instead of cargo run --locked",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    require_exact_references()
    tool = ArtifactTool(args.tool)
    check_source_manifests(tool)
    if args.bootstrap_empty:
        bootstrap_check(tool)
    else:
        strict_check(tool)


if __name__ == "__main__":
    main()
