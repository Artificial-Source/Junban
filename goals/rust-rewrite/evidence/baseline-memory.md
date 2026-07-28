# Hosted Backend Memory Baseline

Date: 2026-07-28

This baseline compares the retired Junban hosted runtime with Kessai's optimized Rust web binary on the same Linux x86_64 host. Both measurements used a private disposable SQLite database, an empty dataset, loopback HTTP, a systemd user cgroup, and twenty warm-up requests. Every process and temporary data root was stopped and removed after measurement.

## Results

| Runtime                     | Phase | Cgroup memory | Cgroup peak | Process RSS total | Process PSS total |    Process count |
| --------------------------- | ----: | ------------: | ----------: | ----------------: | ----------------: | ---------------: |
| Legacy Junban hosted server |  Idle |    178.81 MiB |  209.39 MiB |        235.44 MiB |        192.47 MiB | 2 Node processes |
| Legacy Junban hosted server |  Warm |    179.25 MiB |  209.39 MiB |        236.24 MiB |        193.27 MiB | 2 Node processes |
| Kessai Rust web release     |  Idle |     13.04 MiB |   13.04 MiB |         13.72 MiB |         11.44 MiB |   1 Rust process |
| Kessai Rust web release     |  Warm |     13.45 MiB |   14.04 MiB |         13.83 MiB |         11.55 MiB |   1 Rust process |

The warm cgroup measurement is a 13.3x difference. Kessai used about 92.5% less charged memory in this narrow comparison.

## Legacy Junban method

- Authority: private local checkout of the archived implementation at `5e2b2b5adc865f401843c5030285293c5fabccc5`
- Runtime: Node 22.22.0, matching better-sqlite3 ABI 127
- Entry point: `scripts/share-remote-server.mjs start-host`, the same two-process launcher shape used by the Tailnet/hosted source deployment
- Storage: empty disposable SQLite database
- Frontend: existing production `dist`
- Warm-up: twenty authenticated `/api/tasks` reads and twenty frontend reads

The launcher retained one Node process at roughly 47 MiB RSS, while the application child retained roughly 194 MiB RSS. This confirms that removing only domain functions while retaining the hosted Node process would not satisfy the rewrite objective.

## Rust comparison method

- Authority: local Kessai release binary at `target/release/kessai-web`
- Runtime: one optimized Rust/Axum/rusqlite process
- Storage: empty disposable SQLite database
- Warm-up: twenty frontend reads

Kessai is a directional comparison, not a Junban acceptance target. Junban has more features and may require more memory. The rewrite must establish its own phase-by-phase baselines and explain material growth.

## Operator observation

The user independently observed `junban-web` at 162.5 MiB on Luna. SSH access to Luna was unavailable during this baseline, so that value is recorded as an operator observation rather than reproduced evidence. It is consistent with the local cgroup measurement.

## Measurement rules for the rewrite

For each runnable phase, capture at minimum:

1. cold startup time to healthy;
2. idle cgroup memory after startup settles;
3. warm cgroup memory after a fixed request sequence;
4. peak cgroup memory during that sequence;
5. process count and confirmation that no Node runtime ships or remains resident;
6. task-operation latency against fixed empty, ordinary, and large fixtures.

Use optimized release binaries for acceptance comparisons. Development servers, compilers, test runners, and browser/webview processes must be reported separately.
