# Phase 1 hosted-server memory budget

**Status:** budget frozen from the authoritative five-sample protocol; final integrated measurements are recorded in [`phase-1-hosted-memory.json`](phase-1-hosted-memory.json).

## Protocol

The benchmark runs the optimized `junban-server` release binary and production `dist/` assets as one transient `systemd --user` cgroup with `MemoryAccounting=yes`. The workload driver runs outside that cgroup. Each of five fresh profiles:

1. starts on a loopback ephemeral port and reaches authenticated health;
2. settles for two seconds and records idle cgroup, RSS, and PSS memory;
3. creates 100 tasks;
4. performs 20 complete, uncomplete, replace, and delete cycles;
5. performs 20 static reads and 21 list reads;
6. settles again and records warm memory;
7. verifies SQLite state, graceful cleanup, and the one-process/no-Node boundary.

Phase 2 will add a separate 10,000-task scale fixture. The 100-task protocol stays frozen so later phases remain directly comparable with Phase 1.

## Phase 1 result

| Measure                         |                                                                                    Result |
| ------------------------------- | ----------------------------------------------------------------------------------------: |
| Startup to authenticated health |                                                         52.98 ms median; 68.03 ms maximum |
| Idle cgroup memory              |                                                         2.09 MiB median; 2.30 MiB maximum |
| Idle RSS / PSS                  |                                                                    6.89 / 4.67 MiB median |
| Warm cgroup memory              |                                                        9.00 MiB median; 10.13 MiB maximum |
| Warm cgroup peak                |                                                        9.46 MiB median; 10.26 MiB maximum |
| Warm RSS / PSS                  |                                                                    7.51 / 5.26 MiB median |
| Release binary                  |                                                                           4,715,512 bytes |
| Pooled operation p95            | 0.81–3.99 ms across create/list/replace/complete/uncomplete/delete/static-read operations |

The Phase 1 maximum warm cgroup reading is **94.4% below** the 179.25 MiB legacy hosted-server baseline measured on the same machine. This is an early vertical slice, not a claim that every future subsystem is free.

## Frozen acceptance budget

- **Final hosted-server warm ceiling:** no five-sample warm `memory.current` value may exceed **24 MiB** under this protocol.
- **Final transient peak ceiling:** no five-sample warm-workload cgroup peak may exceed **32 MiB**.
- **Runtime boundary:** exactly one Junban process and no resident Node process.
- **Same-commit variance:** a rerun is considered stable when its warm cgroup median differs by no more than the larger of **15% or 1 MiB**. If it exceeds that band, repeat on an idle host and retain both reports before drawing a conclusion.
- **Per-phase regression rule:** every runnable phase records the same protocol. An increase in warm median greater than the larger of **20% or 2 MiB** must have a measured, in-scope explanation and explicit phase acceptance. An explanation cannot waive the final 24/32 MiB ceilings.
- **Optional subsystems:** default measurements use AI, voice, and plugins disabled. Their phases add separate enabled-path measurements; disabled features may not initialize their heavy runtimes.

The ceiling intentionally leaves room for the preserved feature set while still requiring an order-of-magnitude improvement over the retired Node runtime. It is a product acceptance constraint, not a request for premature micro-optimization.
