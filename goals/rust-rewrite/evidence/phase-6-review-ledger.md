# Phase 6 review ledger

- **Date:** 2026-08-03
- **Current gate:** Wave 1 persistence and private-secret authority
- **Reviewed base:** `059b671` plus the focused correction delta recorded here
- **Gate result:** approved after `P6-DB-001`–`P6-DB-007` were fixed

## Wave 1 database gate

| ID          | Severity | Status | Resolution and focused regression                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-DB-001` | High     | fixed  | Restore preflight now validates bounded canonical schema-v6 AI rows and independently verifies actual UTF-8 byte lengths, row identities, per-session/profile aggregates, and counters before cutover. SQLite rejects a cell above the conservative domain-owned serialized `AiMessageContent` bound before Rust loads it. Correctly reframed forged-counter, malformed-content/ID, aggregate-overflow, and oversized-row backups are rejected.                                                      |
| `P6-DB-002` | High     | fixed  | Approval proposal atomically inserts and binds the exact running generation. Approve/reject/expire/consume transitions CAS the exact run and leave one crash-valid pair; cancel/fail and generation replacement expire old authority and release quota. Normal open expires stale runtime authority fail-closed. Restore validates both approval→run and run→approval edges before sanitizing. Restart, forced-CAS, direct-terminal, generation, and all legal backup/restore pair regressions pass. |
| `P6-DB-003` | High     | fixed  | Run identity is immutable across session and turn, generations are monotonic, terminal and dispatching authority cannot be reopened or superseded, and attached approvals must match run/session/turn/generation. Stale generation, terminal reopening, cross-session/turn reuse, foreign approval, and replacement regressions pass.                                                                                                                                                                |
| `P6-DB-004` | Medium   | fixed  | Message upsert rejects an existing message ID from another session before mutation and requires one identity-bound row update. The two-session regression proves no row, quota, revision, event, or receipt changes.                                                                                                                                                                                                                                                                                 |
| `P6-DB-005` | Medium   | fixed  | Credential receipt replay occurs before random secret publication. Exact request matching uses a domain-separated HMAC-SHA256 verifier keyed by a durable random profile-private key in `ai-secrets.json`; raw secrets and the key remain outside SQLite and complete backups. Restart replay and mismatched-retry regressions prove no extra revision or file entry and no pre-rejection publication.                                                                                               |
| `P6-DB-006` | Medium   | fixed  | Tests that use global restore fault instrumentation share one lock. Default-parallel, explicit multi-thread, and isolated fault-path runs pass without cross-test state consumption.                                                                                                                                                                                                                                                                                                                 |
| `P6-DB-007` | Medium   | fixed  | Schema v6 now includes the in-place partial `idx_ai_run_state_approval` index. The exact terminal-approval restore query plan must `SEARCH` this index rather than scan every run for every historical approval. Fresh and v5→v6 migration regressions pass; no schema v7 or compatibility path was added.                                                                                                                                                                                           |

## Validation used by the gate

```text
cargo fmt --all -- --check
cargo test --locked -p junban-domain
cargo test --locked -p junban-storage
cargo test --locked -p junban-storage -- --test-threads=16
cargo clippy --locked -p junban-storage --all-targets --all-features -- -D warnings
cargo test --locked --workspace
cargo audit
cargo deny check
git diff --check
```

The final focused index recheck also ran the exact query-plan regression and fresh/v5→v6 migration tests. The accepted storage suite contains 160 passing tests. No material Wave 1 persistence or secret-boundary finding remains.
