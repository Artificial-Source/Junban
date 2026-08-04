# Phase 7 review ledger

Date: 2026-08-04
Status: in progress — Wave 0 is authorized; later waves remain gated by the approved context map
Scope: portable Wasm Component Model plugins, package trust, schema v7, optional host, capabilities, registry, operator API, declarative UI, SDK/examples, hostile/cross-platform/performance evidence

## Finding policy

Each material finding has one stable ID and one status:

- `open`: blocks the owning gate;
- `fixed`: correction and focused evidence are recorded;
- `rejected`: evidence shows the claim is outside the agreed threat model, speculative, or incorrect;
- `deferred`: an explicit user/ExecPlan decision accepts it outside this phase.

Closed findings reopen only with new evidence. Each gate uses one risk-matched reviewer; reviewers are not stacked.

## Planning gate

| ID            | Severity | Status | Finding                                                                                                                                                       | Resolution and evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P7-PLAN-001` | high     | fixed  | The bundled-registry plan lacked an implementable private-key custodian, artifact-finalization ceremony, CI boundary, and future rotation/recovery authority. | [`phase-7-context-map.md`](phase-7-context-map.md) now makes the root release-scoped, names external maintainer custody, requires repository-refusing owner-only key input, freezes build→package→index→verify→commit order, gives CI public verification only, and handles compromise/loss/rotation through a later trusted Junban release. Focused planning recheck approved the correction. |
| `P7-PLAN-002` | high     | fixed  | The draft mixed synchronous HTTP imports with deferred HTTP intents and did not prevent dependency services from creating nested effects.                     | The approved WIT authority now has one synchronous at-least-once HTTP import, no HTTP intents, a stable delivery id, no claimed SQLite atomicity, mutual exclusion with returned SQLite effects, exact event-cursor ordering, and read-only dependency service mode without HTTP/effects. Focused planning recheck approved the correction.                                                    |
| `P7-PLAN-003` | high     | fixed  | A single unspecified runtime “generation” left grant survival, restore/restart, IPC results, and stale browser actions ambiguous.                             | The approved authority separates persisted monotonic `package_generation`, persisted monotonic `activation_epoch`, and process-local `host_session_id`; it freezes every transition, drain/CAS order, uninstall tombstone, restore cursor epoch/resync, IPC outcome check, and browser action fence. Focused planning recheck approved the correction.                                         |

Planning verdict: **approved**. Wave 0 implementation is authorized. Wave 1 is blocked on the measured host-placement architecture gate.

## Schema-v7 authority plan checkpoint

| ID              | Severity | Status | Finding                                                                                                                                            | Resolution and evidence                                                                                                                                                                                                                                                                               |
| --------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P7-DBPLAN-001` | high     | fixed  | Per-plugin generation counters could be pruned and reuse generation 1, allowing an old action to collide with different code after receipt expiry. | [`phase-7-schema-contract.md`](phase-7-schema-contract.md) now uses one permanent profile-global monotonic next-generation allocator. Every install/update/reinstall consumes a globally unique generation; uninstall/pruning never rewinds it.                                                       |
| `P7-DBPLAN-002` | high     | fixed  | Thirty-day invocation rows at the 100/minute event limit permitted millions of rows and unbounded backup/disk growth.                              | `plugin_invocations` is now in-flight/ambiguous-only: terminalization transfers authority to the ordinary receipt/cursor and deletes the row. Hard limits are 64 rows/1 MiB per plugin and 256 rows/4 MiB per profile; saturation suspends before insert and protected ambiguous rows are not pruned. |
| `P7-DBPLAN-003` | high     | fixed  | Existing migration finalization could report failure after v7 was already committed, contradicting rollback guarantees.                            | The v7 contract reuses backup helpers but not the old finalizer: all canonical/semantic/FK/integrity checks precede commit, commit is the last reported migration operation, and later retention cleanup is non-fatal. Crash leaves atomic v6 or prevalidated v7 with the snapshot retained.          |
| `P7-DBPLAN-004` | medium   | fixed  | Blocking only enabled dependents could leave disabled dependents with missing/stale locks and make normal open fail closed.                        | Disable blocks enabled dependents; uninstall blocks every installed dependent. Compatible dependency update atomically rewrites all installed dependent locks after draining enabled dependents; incompatible update blocks with the full closure. No unresolved lock state is accepted.              |
| `P7-DBPLAN-005` | medium   | fixed  | Resync had no snapshot revision or atomic cursor handoff, allowing concurrent events to be skipped.                                                | Resync now closes admission, reads snapshot + event epoch/head revision in one serialized transaction, forbids guest HTTP/effects, CASes the cursor to that exact head, catches up only later revisions, then opens live admission; epoch/retention races retry or suspend.                           |

The focused database-plan recheck approved all five corrections. Wave 1 persistence is authorized from the database-plan perspective, but Wave 1 overall remains blocked on the independent measured host-placement architecture gate.

## Package-contract security checkpoint

| ID               | Severity | Status | Finding                                                                                         | Resolution and evidence                                                                                                                                                                                         |
| ---------------- | -------- | ------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P7-PKGPLAN-001` | high     | fixed  | Exact-origin HTTP did not freeze DNS pinning, proxy suppression or the non-global IP predicate. | The dedicated client now validates every DNS answer, pins a global address while retaining hostname TLS/SNI/Host, rejects special/mapped/translation forms, and disables proxies/redirects/retries/credentials. |
| `P7-PKGPLAN-002` | high     | fixed  | Import validation alone did not bind declarations and returned effects to grants.               | The exact declaration/import/outcome matrix now checks current generation/epoch grants before exposure, every import, and final resource-specific commit.                                                       |
| `P7-PKGPLAN-003` | medium   | fixed  | Capability scope and permission-set hash preimages were ambiguous.                              | Domain-separated u32-length-framed SDK preimages and golden ambiguity vectors are exact authority in package and schema contracts.                                                                              |
| `P7-PKGPLAN-004` | medium   | fixed  | JRI1 did not freeze exact length/canonical/strict-root verification.                            | JRI1 now requires exact `76 + I`, total cap/trailing rejection, typed reserialization equality, compiled root fingerprint equality and strict Ed25519 verification.                                             |

Initial package-plan verdict: `REVISE`. Focused security recheck: `APPROVE`; all four corrections are fixed and JBP1/JRI1, permission-authority and plugin HTTP implementation are authorized from this security-plan perspective after the separate host-placement architecture gate.

## Required implementation gates

| Gate                            | Dominant reviewer      | Status  | Acceptance                                                                                                                                                       |
| ------------------------------- | ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave 0 host-placement ADR       | architecture           | pending | Measured lazy-in-process versus on-demand result; one retained boundary; default/no-engine and trap/cleanup proof; numeric active Rust/TypeScript budgets frozen |
| Wave 1 package/schema authority | database               | pending | JBP1/signature/graph/grants/settings/KV/cursor schema v7, migration/open/restore/staging/receipt evidence                                                        |
| Wave 2 hostile runtime          | security               | pending | Selective linker, limits, IPC, one-effect authority, crash containment, denied capabilities, hostile cross-platform matrix                                       |
| Wave 3 operator contract        | API contract           | pending | Auth/body/idempotency/staging/lifecycle/registry/contribution/event contracts; automation catalog remains 87                                                     |
| Wave 4 Extensions UI            | frontend/accessibility | pending | Immutable legacy presentation, permission clarity, safe declarative renderer, stale/revoke/failure, visual/keyboard/axe                                          |
| Wave 5 integrated acceptance    | security               | pending | Final signed packages, SDK/examples, dogfood, default/Rust/TypeScript performance, full validation and docs                                                      |

## Current open findings

None. Pending gates are acceptance work, not findings.
