# Phase 7 SDK matched-release protocol

Date: 2026-08-04
Protocol: `junban-phase7-sdk-matched-release-v1`
Status: implementation complete; authoritative parent-run evidence pending

## Purpose

This is Phase 7 Wave 1's first production subgate. It measures the optimized
`junban-server` twice at one exact commit:

1. `--no-default-features`, the matched pre-SDK linkage baseline;
2. default features, which links `junban-plugin-sdk` and touches only its static
   linkage marker, stable name table, and typed production function table.

Neither binary may link Wasmtime, construct an Engine, inspect a package, start
a plugin host, add a route, open another database, or launch Node. This evidence
is required before schema-v7 or runtime work begins. It does not measure an
active plugin and cannot substitute for Wave 5 integrated server+child evidence.

## Build and linkage proof

The harness builds into separate target roots so one binary cannot overwrite
the other:

```text
target/phase7-sdk-matched/feature-off/release/junban-server
target/phase7-sdk-matched/default/release/junban-server
```

It checks both the resolved normal/build Cargo tree and optimized binary bytes.
The stable `JUNBAN_PLUGIN_SDK_LINKAGE_V1` marker must be absent from feature-off
and present in default. Wasmtime/wasmtime-wasi/Cranelift runtime markers must be
absent from both, and neither Cargo tree may contain Wasmtime. Binary SHA-256 and
size are recorded. The linked authority references all ten production parser,
packer, hash, graph, lock, grant, agreement, and signer functions so optimized
linkage retains executable SDK code without constructing a runtime.

## Frozen SDK stdio payload boundary

The private host protocol keeps each canonical JSON header u32be-length-prefixed
and capped at 256 KiB. Exactly one raw, unencoded body follows `Load` (component
bytes, 1–32 MiB), `Invoke` (request bytes, 1–256 KiB), `Outcome` (outcome
bytes, 1–256 KiB), child capability requests, and parent capability replies
(the latter two 0–4 MiB so typed HTTP/KV host calls are not incorrectly capped
by the outcome ceiling). The declared size is the body boundary; there is no
second length prefix. Receivers validate exact length and SHA-256 before the
next header and reject short, trailing, unexpected, oversized, or mismatched
bodies. Every callback/reply carries the complete plugin/generation/epoch/
session/invocation fence and a bounded callback ID. Load freezes canonical
sorted grants/scopes, permission hash, runtime profile, and exact numeric
limits; invoke freezes both guest kind and its required mode. Closed host-call
kinds cover every WIT host function, enforce the mode/grant matrix, and have no
generic name escape hatch. Cancellation has a full-fence acknowledgement.
Bodies are never JSON byte arrays or base64 and carry no filesystem/profile
path, credential, token, or database authority.

## Workload and measurements

The harness imports `scripts/bench-hosted-server.py` and calls its frozen Phase
1 protocol directly. For each side, authoritative mode uses five independent
fresh profiles, 100 task creates, 20 update/complete/uncomplete/delete cycles,
20 static reads, 20 list reads, and the fixed 2-second settle. Samples interleave
feature-off then default at each index on the same host.

Both servers run as transient cgroup-v2 user units with MemoryAccounting. Raw
samples retain startup-to-health, idle/warm cgroup current and peak, RSS/PSS,
PID/executable/command line (the one-process tree), every workload latency,
SQLite file sizes, process count, stop behavior, and cleanup. The benchmark
driver and all build tools stay outside the measured cgroup. One Rust server and
zero Node/plugin-host processes are required in every sample.

## Report schema

The version-1 JSON has these fixed top-level fields: `protocol`,
`evidence_status`, `accepted`, `acceptance_blockers`, `git`,
`host_cleanliness`, `artifacts`, `linkage`, `feature_off`, `default`, and `gate`.
Each side contains `summary` plus ordered `samples`; linkage contains both Cargo
tree digests and both marker inspections. Additive or renamed fields require a
protocol-version change rather than silent reinterpretation.

## Frozen pass rules

The default SDK-linked server must satisfy all of:

- maximum warm cgroup current ≤ **24 MiB**;
- maximum cgroup peak ≤ **32 MiB**;
- default median warm increase over matched feature-off ≤
  `max(15% of feature-off median, 1 MiB)`;
- default median warm increase over frozen Phase 6 **8.3711 MiB** ≤
  **1.255665 MiB** (15%);
- exactly one measured process, no Node/plugin host, and complete cleanup;
- SDK marker only in default and Wasmtime absent from both builds.

Quick mode uses one interleaved sample, enforces the same numeric checks, and is
always preliminary. A five-sample report is only an authoritative candidate.
Acceptance additionally requires all of:

- non-quick five-sample mode;
- explicit `--idle-host-confirmed`;
- clean git tree at campaign **start** and again **after measurements** (the
  evidence JSON write afterward must not retroactively dirty eligibility);
- uncontended pre/post host snapshots under the accepted Phase 7 host-placement
  activity policy (not mere load1>0.75×CPU or static swap-free percentage);
- all memory/process/cleanup/linkage gates above;
- parent-run review.

The harness never self-approves evidence produced in an implementation worktree.

### Host cleanliness (activity, not existence)

Host contention matches the accepted Phase 7 host-placement evidence policy:

- **pre-run** enforces CPU-scaled historical load gates:
  `load1 > max(1, 0.50×CPU)` **or** `load5 > max(1, 0.30×CPU)` (must not reject a
  Phase 6-class idle host solely for load5≈3.28 on ~20 CPUs);
- sample external confounder CPU over a **0.25s** `/proc` window;
  cargo/rustc/rustdoc/clippy/sccache/npm/npx/pnpm/yarn/wasm-opt/wizer and browser
  executables match directly; `node`/`nodejs` count only when the command line has
  recognized build/test/preview markers; existence alone is never contention;
  the harness PID and its bounded ancestor chain are excluded;
- active swap I/O gate is sustained combined `pswpin`+`pswpout` **≥256 pages/s**
  over that same interval; static allocated swap is informational only;
- **post-run** historical load is informational (the campaign caused it), but
  active external confounder CPU and swap I/O remain blocking;
- evidence records complete pre/post signals, active process details, swap rates,
  thresholds, reasons, and static swap informational value.

## Commands

```bash
python3 scripts/check-phase7-sdk-matched-release.py --self-check
pnpm install --frozen-lockfile
pnpm build # creates the production dist/ input outside measured cgroups

# Optional smoke only; never authoritative.
python3 scripts/check-phase7-sdk-matched-release.py --quick \
  --output /tmp/phase-7-sdk-matched-quick.json

# Parent-run candidate after this commit, on a clean explicitly idle host.
python3 scripts/check-phase7-sdk-matched-release.py --idle-host-confirmed \
  --output goals/rust-rewrite/evidence/phase-7-sdk-matched-release.json
```

No result JSON is committed by this implementation subgate. Wave 1 remains
blocked until the clean parent-run five-sample report passes and the package
security review closes all material `P7-PKG-*` findings.
