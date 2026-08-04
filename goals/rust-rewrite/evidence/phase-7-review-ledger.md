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
