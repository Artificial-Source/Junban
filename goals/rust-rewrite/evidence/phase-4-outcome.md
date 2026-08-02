# Phase 4 outcome — data portability, settings, recovery and hosted operations

**Date:** 2026-08-02

**Base:** Phase 3 merge `b68afbc`

**Phase commit:** this evidence is included in the required single `feat: add Rust backup and hosted operations` commit

## Outcome

Phase 4 is accepted. Junban now provides typed server-confirmed Settings, JSON/CSV/Markdown transfer, supported text/Todoist-style import preview and apply, complete backup, validated fail-closed restore and recovery, hosted hostname/token controls, diagnostics, and epoch-aware multi-client convergence over the existing four Rust crates and one SQLite authority.

The approved interface is preserved through the legacy Settings modal: desktop tab rail, mobile category/detail flow, and the exact Essentials, Appearance, Features, Keyboard, Templates, Data, Hosted, and Diagnostics tabs. Templates are owned only by Settings. Appearance, date/time, task defaults, feature visibility, notifications, planning, delete confirmation, startup view, and canonical persisted shortcuts are consumed by their owning runtime surfaces only after server confirmation.

## Safety and authority

- Private bounded disk staging replaces transfer-sized request/response aggregation; one server-wide permit serializes backup, restore, and export artifacts.
- Restore validates framing, hashes, SQLite integrity, foreign keys, canonical tables/indexes/triggers, typed domain rows, settings, inventory, and event epoch before maintenance.
- Restore cutover is fail-closed. SSE and reminder work drain before apply; a private rollback remains available; durable catastrophic and cutover markers reconcile under the retained profile lock before ordinary startup.
- Recovery mode uses a separate lock-retaining owner and minimal authenticated restore-only router without constructing the normal repository.
- Event catch-up requires the current epoch; the React client performs authoritative resync before reconnecting after reset.
- Import inverse material owns newly created projects/tags and rejects later ownership conflicts atomically.
- Token rotation is durable and receipt-first; retries return the exact issued token and startup reconciles pending receipts before traffic. Persisted hostname replacement is atomic and preserves CLI hosts.
- Diagnostics redact bearer tokens, credentials, URL userinfo, and sensitive query material.

## Performance evidence

Protocol: `phase-4-data-benchmark-protocol.md`

Accepted raw report: `phase-4-data-bench.json`

Retained preceding failure: `phase-4-data-bench-failed.json`

Three authoritative 10,000-task release samples passed every frozen gate:

- post-restore warm cgroup memory: **6.6562 MiB median**, **6.8516 MiB maximum** (24 MiB ceiling);
- maximum operation cgroup peak: **25.2617 MiB** (32 MiB ceiling);
- JSON export: **506.478 ms p50 / 510.127 ms p95**;
- backup: **199.166 ms p50 / 223.878 ms p95**;
- restore: **1,136.447 ms p50 / 1,146.486 ms p95**;
- exact restored counts, table hashes, integrity, foreign keys, artifact bounds, staging cleanup, and restart-boundary checks all passed.

The first authoritative run failed at **32.8086 MiB** peak because restore retained candidate, rollback, and live SQLite file-cache pages simultaneously. After the rollback was made durable, Linux now advises away only its cached pages before cutover; rollback bytes remain intact and reload on failure. Narrow database re-review approved the platform-gated correction. The accepted rerun is 7.55 MiB below the ceiling.

## Validation

Passed on the final working tree:

- `cargo fmt --all -- --check`;
- `cargo test --workspace --locked --all-features` — **389 passed**;
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`;
- `cargo build --profile release --locked --bin junban-server`;
- `cargo audit`;
- `cargo deny check` — advisories, bans, licenses, and sources passed (duplicate-version warnings only);
- `pnpm check` — format, lint, typecheck, **345 Vitest tests**, production build, OpenAPI/generated TypeScript drift, docs links, and runtime boundary passed;
- `./node_modules/.bin/playwright test` — **91 passed**, including 10 immutable Phase 4 visual scenes and Settings accessibility/focus checks;
- `python3 -m py_compile scripts/bench-hosted-server.py`;
- `python3 scripts/bench-hosted-server.py --self-check`;
- `python3 scripts/bench-hosted-server.py --protocol phase4 --samples 3 --output goals/rust-rewrite/evidence/phase-4-data-bench.json`.

The production build retains the existing informational frontend chunk-size warning and existing Oxlint Fast Refresh warnings; neither is a failed gate or a Phase 4 correctness regression.

## Dogfood and review

The optimized Rust server and production React build completed a real browser workflow covering fragment-token connection, all Settings tabs, appearance persistence, feature gating, task creation, JSON export, complete backup, post-backup mutation, restore confirmation, fail-closed cutover, required process restart, and restored-state integrity. Dogfood finding `P4-UI-DOG-001` (a contradictory SSE retry banner after successful intentional shutdown) was fixed and rechecked. Evidence: `phase-4-dogfood/report.md`.

The Phase 4 ledger closes:

- `P4-DB-001`–`P4-DB-010` and `P4-DB-R1`;
- `P4-SEC-001`–`P4-SEC-003`;
- `P4-UI-001`–`P4-UI-006`, `P4-UI-R1`, and `P4-UI-DOG-001`.

Database, security, and UI specialist gates approved the exact reviewed deltas with no remaining material finding. Ledger: `phase-4-review-ledger.md`.

## Follow-up

Phase 5 adds native CLI and MCP surfaces over the same application/storage authority. It must not introduce direct competing SQLite ownership, machine-output diagnostics on stdout, or a second contract catalog.
