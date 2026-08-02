# Phase 6 review ledger

- **Date:** 2026-08-03
- **Current gate:** Wave 3d sessions/messages/memories HTTP contract
- **Reviewed base:** Wave 1 at `059b671`, Wave 3a from `ddafbe5`, Wave 3b from `542ef17`, Wave 3c from `f471009`, then the Wave 3d delta from `c543b7f`
- **Gate result:** persistence approved after `P6-DB-001`–`P6-DB-009`; lifecycle approved after `P6-ARCH-001`–`P6-ARCH-003`; configuration/provider security approved after `P6-SEC-007`–`P6-SEC-009`; resource API approved after `P6-API-001`–`P6-API-003`

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

## Wave 3a database gate

| ID          | Severity | Status | Resolution and focused regression                                                                                                                                                                                                                                                                                           |
| ----------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-DB-008` | High     | fixed  | Session and memory create requests contain only caller input. `JunbanService` generates primary IDs, and canonical receipt requests exclude them. Reopen regressions prove exact retries return the original committed resource ID with one row and no second event; changed title/content returns an idempotency mismatch. |
| `P6-DB-009` | Medium   | fixed  | The public unchecked secret constructor was removed. Secret file parse, retrieval, and publication all re-admit material through the bounded, control-free validator with static non-material-bearing errors. Invalid and corrupted private material fails closed without entering durable state or diagnostics.            |

The exact-delta recheck approved both findings and found no regression in `P6-DB-001`–`P6-DB-007`.

## Wave 3b architecture gate

| ID            | Severity | Status | Resolution and focused regression                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P6-ARCH-001` | High     | fixed  | Provider work is reachable only through a non-cloneable admitted guard whose chat/model-discovery futures borrow it for their full lifetime. Raw runtime, client, cancellation token, and `RunCancel` authority cannot escape. Drop removes runtime authority before unregistering, so restore/reconfiguration drain observes all work. Compile-fail and loopback cancellation regressions pass. |
| `P6-ARCH-002` | High     | fixed  | Hosted and in-process owner shutdown synchronously close AI admission and cancel runs before general shutdown/Axum drain. Explicit and Drop cleanup retain `ProfileOwner` until guards and reminders drain; cancelled/no-runtime cleanup deliberately retains lock-owning values fail-closed. Lock-retention and process SIGINT/SIGTERM regressions pass.                                        |
| `P6-ARCH-003` | Medium   | fixed  | One synchronized `Accepting → Draining → Drained` lifecycle owns admission and reconfiguration. A timeout remains `Draining`; resume is impossible until active guards leave and the prior runtime is explicitly dropped. Timeout/drop/resume regressions pass.                                                                                                                                  |

The exact-delta recheck approved all three architecture findings. Recovery mode still owns no AI runtime, startup constructs no client/runtime, and restore drains AI before stream/request/reminder cutover.

## Wave 3c security gate

| ID           | Severity | Status | Resolution and focused regression                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-SEC-007` | High     | fixed  | A bound credential blocks AI provider/base-origin and speech-provider changes until explicit credential deletion. Credential bind validates the selected authority and exact kind before drain. Credential-free local/browser authorities reject credentials, and `AuthScheme::None` cannot accept or send one. Cloud→loopback/custom/cloud and speech transition regressions pass. |
| `P6-SEC-008` | Medium   | fixed  | Every accepted model-list shape rejects the entire successful response when any provider-derived ID/name/display name contains the active credential. The check runs before public DTO construction and returns a static body-free error. AI-crate shape fixtures and a server loopback response regression remain marker-free.                                                     |
| `P6-SEC-009` | Medium   | fixed  | Temporary reconfiguration uses an exact epoch and an owned task/serialization permit through drain, runtime drop, durable worker result, and finish. Restore waits that permit through cutover; restore/shutdown permanent drain invalidates any epoch and can never resume admission. HTTP cancellation and timeout remain fail-closed, with deterministic overlap regressions.    |

The exact-delta security recheck approved all three findings and confirmed `P6-SEC-001`–`P6-SEC-006` remain closed.

## Wave 3d API-contract gate

| ID           | Severity | Status | Resolution and focused regression                                                                                                                                                                                                                                           |
| ------------ | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-API-001` | High     | fixed  | Session create and rename hold the shared AI serialization permit from mutation through canonical resource fetch. A deterministic concurrent-delete barrier proves a committed mutation cannot return a false 404, and exact retry retains the original generated identity. |
| `P6-API-002` | Medium   | fixed  | Session/message/memory list queries reject unknown fields and route every malformed, negative, duplicate, or invalid cursor form through a stable documented 422 envelope with the matching request ID. All three list contracts and OpenAPI regressions pass.              |
| `P6-API-003` | Medium   | fixed  | AI JSON rejection mapping receives the route's exact 32 KiB ceiling instead of reporting the ordinary 512 KiB limit. Config, credential, session, and memory oversized-body regressions report 32768 bytes while authentication denial still precedes body parsing.         |

The exact-delta API recheck approved all three findings and found no regression in the closed persistence, lifecycle, or security findings.

## Validation used by the gates

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

The final Wave 1 focused index recheck also ran the exact query-plan regression and fresh/v5→v6 migration tests. The Wave 3a gate additionally ran `cargo test --locked -p junban-app -p junban-storage --all-targets` (23 app and 168 storage tests), both crates' all-target/all-feature clippy with denied warnings, and downstream server/CLI/MCP checks. The Wave 3b gate ran all `junban-ai` and `junban-server` targets/features, compile-fail doctests, focused owner lock-retention and restore/shutdown tests, workspace clippy/check, audit, and deny. The Wave 3c gate ran 61 AI tests, 155 server library tests, focused secret/authority/overlap checks, generated-contract and frontend type checks, workspace validation, audit, and deny. The Wave 3d gate ran 163 server library tests plus process lifecycle, focused concurrency/query/body-limit checks, generated-contract/type checks, clippy, and workspace validation. No material reviewed persistence, secret, lifecycle, provider-configuration security, or resource API finding remains.
