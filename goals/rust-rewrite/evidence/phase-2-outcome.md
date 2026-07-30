# Phase 2 outcome — complete Rust task management

Date: 2026-07-30

Status: implemented, dogfooded and validated; final review/delivery metadata is recorded in the live ExecPlan.

## Delivered

Phase 2 extends the Phase 1 hosted slice without adding crates, runtime owners or a second database:

- the Rust domain models complete tasks, projects, sections, tags, templates, comments, directed relations, saved filters and recurrence-rule storage;
- one SQLite schema-v2 migration preserves v1 data and adds transactional organization, activity, bounded durable events, exact receipts and conflict-safe undo;
- one app service and one authenticated Axum API expose view-scoped pagination, catalog resources, task detail, hierarchy, bulk/reorder/move, parsers, undo and SSE convergence;
- the React interface provides Today, Inbox, Upcoming, Someday, Completed, Cancelled, project list/board, task detail, Filters & Labels, search, palette, Quick Add, templates, multi-select and keyboard operations;
- recurrence occurrence generation, reminders and planning controls remain absent until Phase 3.

Node remains frontend build/test tooling only. The optimized hosted runtime is one Rust process over one SQLite authority.

## Correctness and review evidence

- Domain and parser invariants cover UUID-v7 identities, civil dates, bounded text, status transitions, hierarchy cycles, complete reorder permutations, quick-entry metadata and saved-filter clauses.
- Storage tests cover v1→v2 migration/rollback, constraints/cascades, exact replay, single-transaction effect/receipt/activity/event, bounded catch-up/retention, 500-task ceilings, closure restore, move ordering, cursor validation and local-day Inbox semantics.
- API tests cover Host/auth/Origin/body/error protections, generated-ID replay, view truth tables, bulk validation, cursor binding, catalog/detail/undo/parser routes and SSE lifecycle/catch-up.
- Frontend tests cover transport retry/outcome ambiguity, revision-monotonic convergence, routing, dirty drafts, catalog name resolution, filters, multi-select, templates, hierarchy, board keyboard moves, shortcuts and accessible dialogs.
- Material findings are tracked in `phase-2-review-ledger.md`; every fixed finding has focused regression coverage.
- Browser dogfood found six issues across outage recovery, quick-entry priority, template variables, activity freshness, platform shortcuts and hidden later-phase controls. All six were fixed and retested in `../../../dogfood-output/phase-2/report.md`.

## Visual and accessibility evidence

Twelve deterministic Phase 2 scenes cover representative desktop/mobile, light/dark/Nord, organization, project, detail, filter, palette, drawer and template states. The immutable images and protocol are under `phase-2-visual-baseline/`. The current suite passes all 12 comparisons at threshold `0.2` and maximum 1% differing pixels.

Playwright also passes 11 accessibility paths: desktop/mobile axe serious/critical checks, the 320×240 representative check, skip navigation, task entry, full-shell task-dialog and mobile-drawer isolation/focus restoration, labelled palette semantics, and Add Project Escape dismissal. Functional browser coverage includes authenticated persistence/restart, SSE convergence, board keyboard operation and template creation. Component regressions additionally cover list reordering, bulk range selection, modal shortcut suppression, complete bulk-menu keyboard behavior, fail-safe shell isolation, toast Undo availability over blocking layers, and cancelled-history chronology.

## Performance evidence

### Frozen hosted workload

`phase-2-hosted-memory.json` is an authoritative five-sample `junban-phase1-hosted-server-v1` release-binary rerun:

- warm cgroup memory: 6.96 MiB median / 7.13 MiB maximum;
- maximum cgroup peak: 7.63 MiB;
- maximum warm RSS: 10.79 MiB;
- one Rust process, no Node marker, all cleanup checks passed;
- 24 MiB warm / 32 MiB peak budget passed.

### Ten-thousand-task workload

`phase-2-scale-bench.json` is an authoritative three-sample `junban-phase2-scale-v1` run over fresh deterministic 10,000-task profiles:

- warm cgroup memory: 14.87–15.18 MiB; maximum peak 15.35 MiB;
- list/view p95: 3.89 ms (budget 75 ms);
- search/filter p95: 4.25 ms (budget 100 ms);
- single-mutation p95: 3.90 ms (budget 75 ms);
- 25-task bulk/reorder p95: 8.69 ms (budget 150 ms);
- near-cap completion/delete and full undo paths completed successfully;
- one Rust process, no Node marker, all latency and memory budgets passed.

A 250-page WAL auto-checkpoint bound removed periodic multi-hundred-millisecond bulk/reorder outliers without adding a pool or weakening durability.

## Final validation commands

The phase closure ran the following against the integrated branch (exact final delivery SHA and CI are recorded in `../execplan.md`):

```text
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
pnpm check
pnpm test
pnpm test:e2e
pnpm build
pnpm audit --audit-level=high
cargo audit
cargo deny check advisories bans licenses sources
python3 scripts/bench-hosted-server.py --self-check
python3 scripts/bench-hosted-server.py --mode phase1 --output goals/rust-rewrite/evidence/phase-2-hosted-memory.json
python3 scripts/bench-hosted-server.py --mode scale --output goals/rust-rewrite/evidence/phase-2-scale-bench.json
```

Optimized release artifacts—not development servers—produced the recorded memory and scale results.
