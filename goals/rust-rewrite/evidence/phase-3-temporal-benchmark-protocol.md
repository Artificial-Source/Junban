# Phase 3 temporal benchmark protocol

`junban-phase3-temporal-v1` measures the Phase 3 temporal authority with the existing Linux cgroup-v2 hosted-server harness. It extends `scripts/bench-hosted-server.py`; it is not a parallel harness and adds no dependency.

## Preconditions

```bash
pnpm build
cargo build --locked --release -p junban-server
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
python3 scripts/bench-hosted-server.py --self-check
```

The development-only `junban-scale-seed --temporal-fixture` writes each fresh, deterministic profile before the measured `junban-server` begins. Seeder time is recorded but stays outside the transient `systemd --user` cgroup. The cgroup must contain exactly one optimized Rust server process and no Node/tooling marker.

## Fixed authoritative workload

Five independent 10,000-task profiles use a two-second post-health settle. The harness records raw per-sample startup, idle/warm cgroup current and peak, RSS/PSS, SQLite bytes, all HTTP latency values, response counts, revision/event deltas, and scheduler observations.

| Operation       | Fixed workload and p95 budget                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar        | 42 inclusive civil days, nonempty and at most 2,000 tasks; ≤100 ms                                                                            |
| Timeblocking    | create a block and a slot, then range reads; ≤100 ms                                                                                          |
| Planning        | daily and weekly server-derived reads                                                                                                         |
| Stats           | 366 inclusive civil days; ≤150 ms                                                                                                             |
| Nudges          | configured 60-minute capacity; ≤100 ms                                                                                                        |
| Recurrence      | one complete + exact uncomplete; ≤100 ms complete                                                                                             |
| Bulk recurrence | 250 independent recurring sources + 250 generated children, then exact reversal; 500 affected tasks and ≤1,000 ms each direction              |
| Reminders       | idle scheduler → authenticated content-free SSE due wake → fenced lease → 20 claim/settle deliveries → empty claim/idle; lease + claim ≤50 ms |

The 250-source recurring bulk is intentional: the frozen 500 affected-task ceiling includes generated occurrences. A 500-source recurring completion would create 1,000 affected tasks and must fail closed.

All authoritative samples fail closed when any listed latency budget fails, warm cgroup memory exceeds 24 MiB, peak cgroup memory exceeds 32 MiB, a request/receipt/revision/count/SSE observation is malformed, server cleanup fails, or the scheduler does not return to an empty claim after 20 settlements.

## Commands

```bash
python3 scripts/bench-hosted-server.py \
  --mode temporal \
  --server target/release/junban-server \
  --seeder target/release/junban-scale-seed \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-3-temporal-bench.json
```

Quick smoke only:

```bash
python3 scripts/bench-hosted-server.py --mode temporal --quick
```

Quick mode uses one 500-task profile, 25 recurring sources / 50 affected tasks, and five reminder claims. It enforces the same numeric ceilings but is not evidence.

## Measured result

The five-sample command ran on 2026-07-31 and wrote [`phase-3-temporal-bench.json`](phase-3-temporal-bench.json). It correctly failed closed with `authoritative_failed`: memory passed, but the Stats and Nudge p95 budgets did not.

| Measure                                    |                        Result |
| ------------------------------------------ | ----------------------------: |
| Warm cgroup memory (median / maximum)      |         17.9453 / 18.6680 MiB |
| Warm cgroup peak (maximum)                 |                   20.1758 MiB |
| Idle cgroup memory (median / maximum)      |           3.0078 / 3.7812 MiB |
| Startup to health (median / maximum)       |            49.768 / 66.715 ms |
| Calendar 42-day p95                        |              46.145 ms (pass) |
| Timeblocking 42-day p95                    |               0.550 ms (pass) |
| Stats 366-day p95                          | 304.074 ms (**fails 150 ms**) |
| Nudges p95                                 | 292.476 ms (**fails 100 ms**) |
| Recurrence complete p95                    |               1.625 ms (pass) |
| Bulk recurrence complete / reversal p95    |   159.170 / 197.680 ms (pass) |
| Reminder lease + 20-row claim p95          |               1.655 ms (pass) |
| Scheduler due-wake wait (median / maximum) |           52.056 / 101.798 ms |

All five samples observed one scheduler due wake after the idle state, claimed and settled exactly 20 reminders, observed an empty post-settlement claim, and produced a 26-revision user-event delta. No Node process appeared in a measured cgroup and every profile cleaned up. `P3-FINAL-007` remains open until the two latency regressions are resolved and this exact protocol passes.
