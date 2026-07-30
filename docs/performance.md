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
