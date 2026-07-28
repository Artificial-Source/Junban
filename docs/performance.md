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
