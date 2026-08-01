# Phase 3 outcome — planning and time

Phase 3 completes the Rust-owned temporal and planning feature set without adding a runtime owner, scheduler framework, recurrence dependency, or shipped Node process.

## Delivered

- deterministic date-only and timezone-aware recurrence with anchored monthly/yearly behavior and DST coverage;
- atomic recurring completion plus exact receipt-owned reversal and honest source-only fallback;
- fenced reminder leases, deterministic claims, durable settlement, bounded recovery/backoff, one dormant wakeable Tokio coordinator, authenticated reminder SSE, and browser-owner failover recovery;
- verified private pre-migration backups, retry-safe temporal migrations, and immutable cancellation-transition history with reconciled retained undo snapshots;
- Calendar day/week/month views, project filtering, Matrix, Plan My Day, End of Day, Weekly Review, Focus Mode, motivation tools, Stats, Smart Nudges, and first-party day/week timeblocking;
- durable blocks, slots, ordered membership, move/resize/replan operations, recurring-owner expansion, and server-authoritative replan preview/conflict handling;
- one bounded SQLite analysis snapshot for Stats and Nudges instead of paged and per-task reads;
- twelve immutable legacy visual authorities with the standard 1% screenshot budget.

## Correctness and review

The final review ledger is [`phase-3-review-ledger.md`](phase-3-review-ledger.md). All material findings `P3-REMDB-001`–`003`, `P3-FINAL-001`–`016`, and `DB-F555B1B-001` are fixed with focused regressions. Final focused database re-review confirmed retained undo snapshots migrate transactionally with bounded memory, stable receipt bytes, and no remaining material issue.

Notable guarantees:

- recurrence, reminder, timeblock, planning, and task mutations remain transactionally idempotent;
- reminder control-plane operations do not create user-task revisions;
- task-list, planning, Matrix, replan, and review decisions use Rust server-local civil-date authority rather than browser-local dates;
- destructive replan is bound to the exact preview date and candidate ID set and fails closed on drift;
- unsupported timeblock undo is never advertised or pushed;
- optional reminder work adds no polling loop when idle;
- exact recurring reversal rejects every divergent dependent-data class before mutation;
- reminder and virtual recurring-block edits preserve instant, owner anchor, and timezone semantics;
- cancellation history survives later edits, reopen, undo/redo, migration retry, and receipt replay.

## Validation

Final local validation on 2026-07-31 passed:

- `cargo fmt --all -- --check`;
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
- `cargo test --workspace --all-features` — **314 Rust tests**;
- `cargo build --locked --release --bin junban-server`;
- `pnpm check` — formatting, Oxlint, typecheck, **294 Vitest tests**, production build, OpenAPI/TypeScript contract drift, docs, and runtime boundary;
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
| Warm cgroup memory, median             | 16.7812 MiB |   ≤24 MiB |
| Warm cgroup memory, maximum            | 23.8047 MiB |   ≤24 MiB |
| Peak cgroup memory, maximum            | 25.6328 MiB |   ≤32 MiB |
| Calendar 42-day p95                    |   61.987 ms |   ≤100 ms |
| Timeblocking 42-day p95                |    1.376 ms |   ≤100 ms |
| Stats 366-day p95                      |   27.356 ms |   ≤150 ms |
| Nudges p95                             |   29.528 ms |   ≤100 ms |
| Single recurrence completion p95       |    2.513 ms |   ≤100 ms |
| 500-affected recurrence completion p95 |  107.637 ms | ≤1,000 ms |
| 500-affected recurrence reversal p95   |  212.777 ms | ≤1,000 ms |
| Reminder lease + 20 claims p95         |    3.464 ms |    ≤50 ms |

The same-head frozen Phase 1 rerun is retained as [`phase-3-phase1-memory-rerun.json`](phase-3-phase1-memory-rerun.json): 8.4453 MiB median / 15.1953 MiB maximum warm and 15.8477 MiB maximum peak, within the frozen variance rule and 24/32 MiB ceilings. Two high-I/O temporal attempts that exceeded only the Calendar latency budget are retained as [`phase-3-temporal-bench-final-noisy-rerun.json`](phase-3-temporal-bench-final-noisy-rerun.json) and [`phase-3-temporal-bench-final-noisy-rerun-2.json`](phase-3-temporal-bench-final-noisy-rerun-2.json); the required repeat passed every budget.

The measured cgroup contained one optimized `junban-server` process. Node, Vite, browser, benchmark driver, and seeder remained outside it. Every sample cleaned up successfully, and the dormant/due scheduler observations passed.

## Phase boundary

Phase 3 is complete. Phase 4 may build settings, import/export, complete backup/restore, hosted controls, token rotation, diagnostics, and multi-client maintenance barriers on this same four-crate authority.
