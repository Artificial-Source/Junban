# Performance and memory

Performance is part of correctness for this rewrite. Phase 1 froze the hosted-server ceiling at 24 MiB maximum warm cgroup memory and 32 MiB peak; every later phase must preserve it.

## Baseline

On 2026-07-28, same-host optimized measurements with empty fresh SQLite data recorded:

| Process                      | Warm cgroup memory |
| ---------------------------- | -----------------: |
| Legacy Junban Tailnet server |         179.25 MiB |
| Kessai optimized Rust server |          13.45 MiB |

Methodology: [`../goals/rust-rewrite/evidence/baseline-memory.md`](../goals/rust-rewrite/evidence/baseline-memory.md).

Kessai is a feasibility comparator, not a Junban promise. Phase 1 established Junban's own numeric ceiling, workload protocol, variance and regression rules. Phase 9 must pass the same protocol and final ceiling.

## Phase 1 hosted-server harness

Protocol authority: [`../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md).

Harness: [`../scripts/bench-hosted-server.py`](../scripts/bench-hosted-server.py) (Python 3 stdlib, Linux cgroup v2 + `systemd --user`). Default `--mode phase1` preserves the frozen Phase 1 protocol.

The driver measures only an optimized `junban-server` inside a transient user service cgroup. Node, Vite, browsers, the seeder, and the benchmark process stay outside that cgroup.

### Build artifacts

```bash
pnpm build
cargo build --locked --release -p junban-server
```

### Authoritative five-sample run

```bash
python3 scripts/bench-hosted-server.py \
  --server target/release/junban-server \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-1-hosted-memory.json
```

Or:

```bash
pnpm bench:hosted-server -- \
  --output goals/rust-rewrite/evidence/phase-1-hosted-memory.json
```

Fixed protocol knobs (not CLI-configurable beyond `--mode` / `--quick`):

| Knob            | Authoritative | Quick | Notes                                                     |
| --------------- | ------------: | ----: | --------------------------------------------------------- |
| samples         |             5 |     1 | Independent fresh profiles                                |
| tasks           |           100 |    10 | Ordinary warm set; Phase 2 owns the 10_000-task fixture   |
| mutation cycles |            20 |     5 | replace → complete → uncomplete → delete                  |
| static / list   |         20/20 |   5/5 | Production shell reads + authenticated list               |
| settle          |          2.0s |  2.0s | Only fixed sleep; readiness/shutdown are condition-polled |

Phase 1 CLI accepts `--mode phase1` (default), `--server`, `--web-dir`, `--output`, `--quick`, and `--self-check`.

Each sample records host/toolchain/commit/binary hash and size, startup-to-health, idle and warm cgroup current/peak, RSS/PSS, process count (must be 1), SQLite size, per-operation latency p50/p95, and cleanup success. The harness fails closed on non-2xx responses, malformed JSON, wrong process count, missing metrics, a lingering unit, or cleanup failure. Ceiling/variance/regression fields remain null until filled from authoritative results.

### Quick dry-run (not evidence)

```bash
python3 scripts/bench-hosted-server.py --quick
pnpm bench:hosted-server:quick
```

Quick mode uses 1 sample, 10 tasks, and 5 mutation cycles. Do not freeze it as the Phase 1 budget.

## Phase 2 scale harness (`junban-phase2-scale-v1`)

Frozen protocol: [`../goals/rust-rewrite/evidence/phase-2-context-map.md`](../goals/rust-rewrite/evidence/phase-2-context-map.md) (Ten-thousand-task protocol).

A development-only Rust seeder (`junban-scale-seed`, Cargo feature `scale-bench` on `junban-storage`) writes exactly N deterministic tasks into a fresh profile **before** server start. It is not linked into `junban-server` release artifacts and does not run inside the measured cgroup. Seed duration is recorded separately from server latency.

### Build artifacts

```bash
pnpm build
cargo build --locked --release -p junban-server
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
```

### Authoritative three-sample run

```bash
python3 scripts/bench-hosted-server.py \
  --mode scale \
  --server target/release/junban-server \
  --seeder target/release/junban-scale-seed \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-2-scale-bench.json
```

Or:

```bash
pnpm bench:scale -- \
  --output goals/rust-rewrite/evidence/phase-2-scale-bench.json
```

| Knob              | Authoritative | Quick | Notes                                                         |
| ----------------- | ------------: | ----: | ------------------------------------------------------------- |
| samples           |             3 |     1 | Independent fresh profiles                                    |
| tasks             |        10_000 |   500 | Pre-seeded; never created through the measured HTTP path      |
| page limit        |           100 |   100 | Stable cursors; harness never lists all tasks in one response |
| settle            |          2.0s |  2.0s | Same condition-polled readiness/shutdown as Phase 1           |
| list/view p95     |        ≤75 ms |  n/a* | Unfiltered first page, Inbox/Today/Project                    |
| search/filter p95 |       ≤100 ms |  n/a* | Hit/miss search, tag+priority, due range, project+section     |
| single mut p95    |        ≤75 ms |  n/a* | 50 patches, 50 complete/uncomplete pairs                      |
| bulk/reorder p95  |       ≤150 ms |  n/a* | Twenty 25-task bulk mutations and twenty 25-task reorders     |
| memory            |   24 / 32 MiB |  same | Warm cgroup current / peak, one Rust process, no Node marker  |

\* Quick mode still enforces the same numeric budgets when it runs; it is not authoritative evidence.

Each scale sample also executes one near-cap pending-descendant completion plus undo and one near-cap subtree delete plus full-closure undo. Fail closed on non-2xx, malformed JSON, ordering/count errors, or operation receipt/replay mismatch.

The authoritative Phase 2 run is checked in at [`../goals/rust-rewrite/evidence/phase-2-scale-bench.json`](../goals/rust-rewrite/evidence/phase-2-scale-bench.json). Across three fresh 10,000-task profiles it measured 14.25–15.11 MiB warm cgroup memory (15.14 MiB maximum peak); every latency class passed its frozen p95 budget. The same-commit five-sample Phase 1 workload result is [`../goals/rust-rewrite/evidence/phase-2-hosted-memory.json`](../goals/rust-rewrite/evidence/phase-2-hosted-memory.json), with 6.89 MiB median / 7.17 MiB maximum warm and 7.64 MiB maximum peak.

### Quick scale smoke (not evidence)

```bash
python3 scripts/bench-hosted-server.py --mode scale --quick
pnpm bench:scale:quick
```

### Protocol self-check

```bash
python3 scripts/bench-hosted-server.py --self-check
pnpm bench:self-check
```

## Phase 3 temporal harness (`junban-phase3-temporal-v1`)

Protocol authority: [`../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md).

`--mode temporal` extends the same cgroup harness; it does not add a second runner or runtime dependency. The existing development-only `junban-scale-seed --temporal-fixture` seeds a deterministic 10,000-task SQLite profile outside the measured cgroup before each server starts. The release server is the only measured process.

```bash
pnpm build
cargo build --locked --release -p junban-server
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
python3 scripts/bench-hosted-server.py \
  --mode temporal \
  --server target/release/junban-server \
  --seeder target/release/junban-scale-seed \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-3-temporal-bench.json
```

Or use `pnpm bench:temporal --output goals/rust-rewrite/evidence/phase-3-temporal-bench.json`.

Each of five fresh profiles records raw startup, idle/warm cgroup current/peak, RSS/PSS, SQLite size, every HTTP latency, response count, user-event revision delta, and scheduler observations. The workload uses Calendar (42 days), block/slot reads, daily/weekly planning, 366-day Stats, Nudges, exact recurring complete/uncomplete, a 250-source recurring bulk completion plus exact reversal (500 affected tasks, the frozen ceiling), and the reminder lifecycle: idle scheduler → SSE due wake → fenced lease → 20 claims → settlements → empty claim/idle.

Pooled p95 budgets are Calendar and timeblocking ≤100 ms, Stats ≤150 ms, single recurrence ≤100 ms, each 500-affected bulk direction ≤1,000 ms, Nudges ≤100 ms, and lease + 20-row claim ≤50 ms. Every run fails closed if any latency budget or the frozen 24 MiB warm / 32 MiB peak memory ceiling fails.

### Quick temporal smoke (not evidence)

```bash
python3 scripts/bench-hosted-server.py --mode temporal --quick
pnpm bench:temporal:quick
```

Quick mode uses one 500-task profile, 25 recurring sources (50 affected tasks), and five reminder claims. It enforces the same ceilings but is not authoritative evidence.

The 2026-07-31 authoritative rerun recorded 16.1523 MiB median / 16.5586 MiB maximum warm cgroup memory and an 18.1953 MiB maximum peak. It passed every frozen budget, including Stats p95 24.995 ms (150 ms budget) and Nudges p95 24.868 ms (100 ms budget); see the protocol for the complete result and scheduler evidence.

## Phase 4 data harness (`junban-phase4-data-v1`)

Protocol authority: [`../goals/rust-rewrite/evidence/phase-4-data-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-4-data-benchmark-protocol.md).

`--mode phase4` extends the same cgroup harness for streamed JSON export, complete backup, restore cutover, and post-restore warm memory. The seeder writes a deterministic profile outside the measured cgroup; the release server is the only measured process. Driver-side artifact I/O streams to/from temporary files without buffering export/backup payloads in Python.

```bash
pnpm build
cargo build --locked --release -p junban-server
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
python3 scripts/bench-hosted-server.py \
  --mode phase4 \
  --server target/release/junban-server \
  --seeder target/release/junban-scale-seed \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-4-data-bench.json
```

Or use `pnpm bench:phase4 -- --output goals/rust-rewrite/evidence/phase-4-data-bench.json`.

| Knob       |                                   Authoritative | Quick | Notes                                           |
| ---------- | ----------------------------------------------: | ----: | ----------------------------------------------- |
| samples    |                                               3 |     1 | Independent fresh profiles                      |
| tasks      |                                          10_000 |   500 | Pre-seeded outside the cgroup                   |
| settle     |                                            2.0s |  2.0s | Same condition-polled readiness/shutdown        |
| operations | export JSON, backup, restore, post-restore warm |  same | Streamed HTTP; restore restarts in a new cgroup |
| memory     |                                     24 / 32 MiB |  same | Post-restore warm current / sample peak         |

Throughput and per-operation latency are recorded. Overall `budget_passed` is integrity (exact task counts, valid backup envelope, `restart_required`, cleanup) plus the frozen memory ceilings — not an invented throughput gate.

The accepted three-sample 10,000-task run exported JSON at 506.48 ms p50 / 510.13 ms p95, created complete backups at 199.17 / 223.88 ms, and restored at 1,136.45 / 1,146.49 ms. Post-restore warm memory was 6.6562 MiB median / 6.8516 MiB maximum and the maximum operation peak was 25.2617 MiB, passing the frozen 24/32 MiB ceilings. See `phase-4-data-bench.json`; the retained preceding failed run and its file-cache root cause are documented in the protocol.

### Quick Phase 4 smoke (not evidence)

```bash
python3 scripts/bench-hosted-server.py --mode phase4 --quick
pnpm bench:phase4:quick
```

## Phase 5 automation harness (`junban-phase5-automation-v1`)

Protocol authority: [`../goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md). Cross-surface state parity is measured separately by [`../scripts/check-phase5-conformance.py`](../scripts/check-phase5-conformance.py) under the frozen conformance protocol.

The automation harness measures optimized `junban`, `junban-mcp`, and the owning `junban-server` in transient cgroup-v2 user services. It covers 20 one-shot local CLI reads, 10 attached CLI reads, three 50-call attached MCP sessions, and three 50-mutation local-owner MCP sessions. Every sample records wall latency, cgroup current/peak memory, process count, process-tree commands, owner-memory before/after, profile-lock release, cleanup, binary hashes, and Node-process rejection.

```bash
cargo build --locked --release -p junban-server -p junban-cli -p junban-mcp
python3 scripts/check-phase5-conformance.py --authoritative \
  --output goals/rust-rewrite/evidence/phase-5-conformance.json
python3 scripts/check-phase5-automation-budget.py \
  --output goals/rust-rewrite/evidence/phase-5-automation-owner-delta-raw.json
```

Or use `pnpm conformance:phase5` and `pnpm bench:phase5`. `--quick` is a development smoke only. Authoritative mode requires Linux cgroup v2, `systemd --user`, a clean tracked worktree, optimized binaries built from that tree, and no environment-carried operator token.

The frozen ceilings are active-owner CLI p95 ≤150 ms, no-owner CLI p95 ≤350 ms, persistent MCP create/get p95 ≤100/75 ms, and attached or local-owner MCP warm current ≤24 MiB / peak ≤32 MiB. Owner post-workload growth normally stays within max(15%, 1 MiB). If a state-creating workload exceeds that relative check, the protocol permits an explicit `--accept-explained-owner-delta durable-sqlite-state-growth` only after the harness retains the raw failure, runs a matched idle-host control, proves the absolute 24/32 MiB ceilings still pass, and attributes the bounded delta to durable SQLite/file-cache growth. The raw assertion remains visible; the decision never waives an absolute ceiling.

If, and only if, the raw run fails solely for that explained delta and all required predicates pass, record the explicit decision:

```bash
python3 scripts/check-phase5-automation-budget.py \
  --accept-explained-owner-delta durable-sqlite-state-growth \
  --output goals/rust-rewrite/evidence/phase-5-automation-bench.json
```

The accepted Phase 5 run measured 22.092 ms active-owner CLI p95, 62.535 ms no-owner CLI p95, 3.729/0.320 ms MCP create/get p95, 20.4648/20.9922 MiB attached MCP maximum warm/peak, and 21.9805/22.7227 MiB local-owner MCP maximum warm/peak.

### Quick Phase 5 smoke (not evidence)

```bash
python3 scripts/check-phase5-conformance.py --quick
python3 scripts/check-phase5-automation-budget.py --quick
pnpm bench:phase5:quick
```

## Phase 6 schema-v6 conformance rerun (`junban-phase6-conformance-v1`)

Protocol authority: [`../goals/rust-rewrite/evidence/phase-6-conformance-protocol.md`](../goals/rust-rewrite/evidence/phase-6-conformance-protocol.md). This is the same frozen 17-revision Phase 5 corpus and four-surface comparison, rerun against current optimized binaries with schema version 6 as the explicit head authority. It does not regenerate or weaken `phase-5-conformance.json`.

```bash
cargo build --locked --release -p junban-server -p junban-cli -p junban-mcp
python3 scripts/check-phase5-conformance.py --phase6 --authoritative \
  --output goals/rust-rewrite/evidence/phase-6-conformance.json
```

Or use `pnpm conformance:phase6`. Authoritative mode requires a clean tracked worktree and optimized binaries built from that tree. Runtime Node remains forbidden.

## Phase 6 disabled matched parent/head release

Protocol authority: [`../goals/rust-rewrite/evidence/phase-6-disabled-matched-release-protocol.md`](../goals/rust-rewrite/evidence/phase-6-disabled-matched-release-protocol.md).

Harness: [`../scripts/check-phase6-disabled-matched-release.py`](../scripts/check-phase6-disabled-matched-release.py). Builds or accepts optimized Phase 5 parent-base (`351c842`) and exact-head `junban-server` plus matching `dist/` trees, then runs five interleaved Phase 1 health/UI/idle samples per side in cgroup-v2 user units.

```bash
python3 scripts/check-phase6-disabled-matched-release.py --self-check
python3 scripts/check-phase6-disabled-matched-release.py --build \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json
pnpm bench:phase6-disabled-matched:quick
```

Acceptance requires head maximum warm ≤24 MiB, head maximum peak ≤32 MiB, head median warm growth versus parent ≤ max(15%, 1 MiB), zero resident Node, and a disabled initial-UI/Phase 1 request proof with no AI/provider/model/media paths. Authoritative status also requires an idle host and a clean worktree. Contended-host numbers may be retained as preliminary only. In-process zero AI client construction is **not** claimed by this external harness; see the protocol’s separate claim section.

Retained JSON/narrative: [`../goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json`](../goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json), [`../goals/rust-rewrite/evidence/phase-6-disabled-matched-release.md`](../goals/rust-rewrite/evidence/phase-6-disabled-matched-release.md).

## Phase 6 enabled local-mock release evidence (`junban-phase6-enabled-local-mock-v1`)

Protocol authority: [`../goals/rust-rewrite/evidence/phase-6-enabled-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-6-enabled-benchmark-protocol.md). Measures the exact optimized `junban-server` against a standalone OpenAI-compatible TLS fixture outside the server cgroup. The production `api.openai.com` origin is preserved via an ephemeral CA (`SSL_CERT_FILE`) and a benchmark-only `LD_PRELOAD` resolver/connect shim; no privileged bind, system trust, `/etc/hosts`, proxy, or shipped binary change is used. Authoritative acceptance requires an idle host and is not claimed from contended preliminary runs.

```bash
python3 scripts/check-phase6-enabled-benchmark.py --self-check
cargo build --locked --release -p junban-server
pnpm build
python3 scripts/check-phase6-enabled-benchmark.py \
  --build \
  --authoritative \
  --idle-host-confirmed \
  --output goals/rust-rewrite/evidence/phase-6-enabled-bench.json
```

Or use `pnpm bench:phase6-enabled:self-check` for the interception preflight. Do not retain contended-host result JSON as accepted evidence.

## Measurement rules

- Optimized release binaries are authoritative. Development servers are not.
- Prefer cgroup memory when available; also record RSS/PSS/process tree as needed.
- Record OS, toolchain, commit, data size, and exact command with every measurement.
- No resident Node process is allowed in release runtime evidence.

## Default-path discipline

- Do not initialize AI provider clients, local voice engines, or Wasmtime during ordinary task-server startup.
- Plugin runtime stays unloaded when no plugin is active.
- Avoid eager dependency aggregation that quietly reintroduces idle cost.

## Phase expectations

| Phase | Evidence focus                                      |
| ----- | --------------------------------------------------- |
| 0     | Toolchain only; no runtime product binary yet       |
| 1     | First optimized hosted idle/warm/startup numbers    |
| 2+    | Workload latency, peak memory, regression vs budget |
| 8     | Desktop process-tree cold/warm and launch time      |
| 9     | Final ceiling and long-run checks                   |
