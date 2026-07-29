# Phase 1 hosted-server benchmark protocol

Date: 2026-07-28

Protocol name: `junban-phase1-hosted-server-v1`

This document freezes the **measurement method** for Phase 1 hosted-server evidence. It does **not** freeze a numeric memory ceiling, variance band, or regression rule. Those fields stay null in harness output until the main agent runs an authoritative five-sample pass and records approved bounds before Phase 2.

Harness: [`../../../scripts/bench-hosted-server.py`](../../../scripts/bench-hosted-server.py)

## Scope

| In scope                                                         | Out of scope                                      |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Optimized `target/release/junban-server`                         | `cargo run`, dev profiles                         |
| Production `dist/` static assets                                 | Vite dev server                                   |
| Fresh mode-`0700` profile + deterministic private token          | Reused/dirty profiles                             |
| Loopback bind only (`127.0.0.1:0`)                               | Tailnet/public bind                               |
| Transient `systemd --user` cgroup charging only the Rust process | Driver/browser/Node memory                        |
| Idle, warm, peak, startup-to-health, op latency, SQLite size     | Desktop/webview, CLI, MCP, 10k-task Phase 2 bench |

## Prerequisites

- Linux with cgroup v2 and a working `systemd --user` session
- `systemd-run`, `systemctl`
- Python 3 stdlib only (no third-party Python deps)
- Built artifacts:

```bash
pnpm build
cargo build --locked --release -p junban-server
```

## Authoritative command

Five samples, ordinary 100-task warm set, full mutation cycle counts:

```bash
python3 scripts/bench-hosted-server.py \
  --server target/release/junban-server \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-1-hosted-memory.json
```

Equivalent package script:

```bash
pnpm bench:hosted-server -- \
  --output goals/rust-rewrite/evidence/phase-1-hosted-memory.json
```

Only a report with `"evidence_status": "authoritative_candidate"` and `"protocol.authoritative": true` may be used to freeze the ceiling.

## Quick dry-run (non-authoritative)

```bash
python3 scripts/bench-hosted-server.py --quick
# or
pnpm bench:hosted-server:quick
```

Quick mode uses 1 sample, 10 tasks, and 5 mutation cycles. It validates the harness only. Do not accept it as final Phase 1 evidence.

## Why 100 tasks

Phase 2 owns the large 10_000-task list/search/filter benchmark. Phase 1 needs a **meaningful ordinary** warm set: enough creates to touch multiple SQLite pages and exercise list serialization for a personal working set, without pretending to be a scale test. **100 creates**, plus **20** replace/complete/uncomplete/delete cycles on the first tasks, matches that goal.

## Sample procedure

For each independent sample:

1. Create a fresh profile directory mode `0700`.
2. Pre-write owner-only `access-token` with a deterministic ≥64-character token for that sample.
3. Start `junban-server` inside a transient `systemd --user` service (`MemoryAccounting=yes`, `Type=exec`) so only that process is charged. The Python driver stays outside the unit.
4. Bind `127.0.0.1:0`; discover the port from `runtime.json`.
5. Poll `GET /api/v1/health` until ready (bounded; no fixed startup sleep).
6. Record **startup-to-health** wall time from unit launch through first healthy response.
7. Wait the documented settle window (**2.0s**). This is the only intentional fixed sleep.
8. **Idle snapshot:** cgroup `memory.current` / `memory.peak`, process RSS/PSS, process count.
9. **Warm workload** through the real authenticated HTTP contract:
   - static `GET /` and `GET /index.html` (×20 authoritative; ×5 quick)
   - `POST /api/v1/tasks` × task count with `Authorization`, matching `Origin`, and unique UUID `Idempotency-Key`
   - `GET /api/v1/tasks` list reads (×20 authoritative; ×5 quick)
   - for each mutation cycle: replace → complete → uncomplete → delete with fresh idempotency keys
   - final list read asserting remaining task count
10. **Warm snapshot:** same memory fields after the workload; peak is cumulative from process start.
11. Record SQLite file + WAL + SHM bytes.
12. Stop the unit (condition-polled), confirm it does not linger, delete the profile, require cleanup success.

## Fail-closed conditions

The harness exits non-zero if any of the following occur:

- non-2xx HTTP where success is required
- malformed JSON response bodies
- process count ≠ 1 inside the server cgroup
- Node/npm/pnpm/vite/playwright appears in the server process or its children
- missing cgroup/RSS/PSS metrics
- server not on loopback
- lingering systemd unit after stop
- profile/unit cleanup failure

## Report fields

Machine-readable JSON includes:

- host/kernel/CPU/rustc/commit/dirty flag
- binary path, size, SHA-256
- protocol knobs and authoritative flag
- every raw sample (startup, idle/warm memory, latencies, SQLite, cleanup)
- summary medians/ranges and pooled latency p50/p95
- `summary.memory_ceiling_mib`, `summary.variance_rule`, and `summary.regression_rule` left **null** for the main agent to fill after review

## Ceiling freeze (main agent, not this harness)

After an authoritative five-sample run on the integration commit:

1. Inspect median/range idle and warm cgroup MiB, peak, startup, and latency p95.
2. Record the numeric final hosted-server ceiling, allowed measurement variance, and per-phase regression rule in ExecPlan/evidence.
3. Phase 9 must pass that same protocol and ceiling.

## Assumptions

- User systemd session is available (`systemctl --user`).
- cgroup v2 provides `memory.current` and `memory.peak`.
- PSS comes from `/proc/<pid>/smaps_rollup`.
- No other tool may place processes into the bench unit; the harness creates a unique unit name per sample.
- Protocol knobs are fixed in the harness (authoritative vs `--quick` only). CLI accepts only `--server`, `--web-dir`, `--output`, and `--quick`.
