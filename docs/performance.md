# Performance and memory

Performance is part of correctness for this rewrite. The legacy hosted baseline is the reference point until Phase 1 freezes a numeric native ceiling.

## Baseline

On 2026-07-28, same-host optimized measurements with empty fresh SQLite data recorded:

| Process                      | Warm cgroup memory |
| ---------------------------- | -----------------: |
| Legacy Junban Tailnet server |         179.25 MiB |
| Kessai optimized Rust server |          13.45 MiB |

Methodology: [`../goals/rust-rewrite/evidence/baseline-memory.md`](../goals/rust-rewrite/evidence/baseline-memory.md).

Kessai is a feasibility comparator, not a Junban promise. Phase 1 must record and approve the numeric final hosted-server memory ceiling, workload protocol, variance, and regression rule before Phase 2 starts. Phase 9 must pass that same protocol.

## Phase 1 hosted-server harness

Protocol authority: [`../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md).

Harness: [`../scripts/bench-hosted-server.py`](../scripts/bench-hosted-server.py) (Python 3 stdlib, Linux cgroup v2 + `systemd --user`).

The driver measures only an optimized `junban-server` inside a transient user service cgroup. Node, Vite, browsers, and the benchmark process stay outside that cgroup.

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

Default protocol knobs:

| Knob            | Default | Notes                                                     |
| --------------- | ------: | --------------------------------------------------------- |
| samples         |       5 | Independent fresh profiles                                |
| tasks           |     100 | Ordinary warm set; Phase 2 owns the 10_000-task fixture   |
| mutation cycles |      20 | replace → complete → uncomplete → delete                  |
| static / list   |   20/20 | Production shell reads + authenticated list               |
| settle          |    2.0s | Only fixed sleep; readiness/shutdown are condition-polled |

Each sample records host/toolchain/commit/binary hash and size, startup-to-health, idle and warm cgroup current/peak, RSS/PSS, process count (must be 1), SQLite size, per-operation latency p50/p95, and cleanup success. The harness fails closed on non-2xx responses, malformed JSON, wrong process count, missing metrics, a lingering unit, or cleanup failure. Ceiling/variance/regression fields remain null until filled from authoritative results.

### Quick dry-run (not evidence)

```bash
python3 scripts/bench-hosted-server.py --quick
pnpm bench:hosted-server:quick
```

Quick mode uses one sample and fewer tasks. Do not freeze it as the Phase 1 budget.

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
