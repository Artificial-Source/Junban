# Phase 3 outcome — planning and time

Phase 3 completes the Rust-owned temporal and planning feature set without adding a runtime owner, scheduler framework, recurrence dependency, or shipped Node process.

## Delivered

- deterministic date-only and timezone-aware recurrence with anchored monthly/yearly behavior and DST coverage;
- atomic recurring completion plus exact receipt-owned reversal and honest source-only fallback;
- fenced reminder leases, deterministic claims, durable settlement, bounded recovery/backoff, one dormant wakeable Tokio coordinator, authenticated reminder SSE, and browser-owner failover recovery;
- verified private pre-migration backups and retry-safe schema-v3 migration;
- Calendar day/week/month views, project filtering, Matrix, Plan My Day, End of Day, Weekly Review, Focus Mode, motivation tools, Stats, Smart Nudges, and first-party day/week timeblocking;
- durable blocks, slots, ordered membership, move/resize/replan operations, recurring-owner expansion, and server-authoritative replan preview/conflict handling;
- one bounded SQLite analysis snapshot for Stats and Nudges instead of paged and per-task reads;
- twelve immutable legacy visual authorities with the standard 1% screenshot budget.

## Correctness and review

The final review ledger is [`phase-3-review-ledger.md`](phase-3-review-ledger.md). All material findings `P3-REMDB-001`–`003` and `P3-FINAL-001`–`010` are fixed with focused regressions. Narrow final re-review found no material issue after replan preview overflow was isolated from ordinary schedule loading.

Notable guarantees:

- recurrence, reminder, timeblock, planning, and task mutations remain transactionally idempotent;
- reminder control-plane operations do not create user-task revisions;
- task-list, planning, Matrix, replan, and review decisions use Rust server-local civil-date authority rather than browser-local dates;
- destructive replan is bound to the exact preview date and candidate ID set and fails closed on drift;
- unsupported timeblock undo is never advertised or pushed;
- optional reminder work adds no polling loop when idle.

## Validation

Final local validation on 2026-07-31 passed:

- `cargo fmt --all -- --check`;
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
- `cargo test --workspace --all-features` — **300 Rust tests**;
- `cargo build --locked --release --bin junban-server`;
- `pnpm check` — formatting, Oxlint, typecheck, **292 Vitest tests**, production build, OpenAPI/TypeScript contract drift, docs, and runtime boundary;
- `pnpm test:e2e` — **77 Playwright scenarios**: 26 functional, 24 immutable visual, and 27 axe/keyboard/accessibility checks;
- `pnpm audit --audit-level high` — no known vulnerabilities;
- `cargo audit --deny warnings` — no RustSec advisories;
- `cargo deny check` — advisories, bans, licenses, and sources passed (informational duplicate-version warnings only);
- `git diff --check`.

The production frontend build retains one known Vite advisory that the main application chunk is larger than 500 kB. It is not a Phase 3 correctness or memory-budget failure; Phase 10 owns evidence-driven bundle and DX review rather than speculative splitting now.

## Memory and temporal performance

The authoritative five-sample 10,000-task result is [`phase-3-temporal-bench.json`](phase-3-temporal-bench.json), governed by [`phase-3-temporal-benchmark-protocol.md`](phase-3-temporal-benchmark-protocol.md).

| Metric                                 |      Result |    Budget |
| -------------------------------------- | ----------: | --------: |
| Warm cgroup memory, median             | 16.1523 MiB |   ≤24 MiB |
| Warm cgroup memory, maximum            | 16.5586 MiB |   ≤24 MiB |
| Peak cgroup memory, maximum            | 18.1953 MiB |   ≤32 MiB |
| Calendar 42-day p95                    |   46.724 ms |   ≤100 ms |
| Timeblocking 42-day p95                |    0.472 ms |   ≤100 ms |
| Stats 366-day p95                      |   24.995 ms |   ≤150 ms |
| Nudges p95                             |   24.868 ms |   ≤100 ms |
| Single recurrence completion p95       |    1.462 ms |   ≤100 ms |
| 500-affected recurrence completion p95 |  285.390 ms | ≤1,000 ms |
| 500-affected recurrence reversal p95   |  343.658 ms | ≤1,000 ms |
| Reminder lease + 20 claims p95         |    2.307 ms |    ≤50 ms |

The measured cgroup contained one optimized `junban-server` process. Node, Vite, browser, benchmark driver, and seeder remained outside it. Every sample cleaned up successfully, and the dormant/due scheduler observations passed.

## Phase boundary

Phase 3 is complete. Phase 4 may build settings, import/export, complete backup/restore, hosted controls, token rotation, diagnostics, and multi-client maintenance barriers on this same four-crate authority.
