# Phase 7 Wave 1 Slice B — normalized plugin persistence

Status: accepted — focused database recheck closed `P7-DB-006`–`011` and approved Wave 1 persistence

## Integrated authority

- `junban-app` owns typed plugin package, lifecycle, trust, grant, setting, KV, cursor, invocation, health, graph and application-effect planning contracts.
- Operator-visible plugin mutations use the ordinary mutation authority: one global revision, event and exact operation receipt. Counter-only runtime bookkeeping, KV, cursor and in-flight invocation state remain plugin-local and revision-neutral.
- Package generations allocate monotonically profile-wide; grants bind exact generation + permission hash; dependency locks are exact SDK-validated installed authority.
- App-owned plans select first-party task/project/tag operations through a transaction-capable unit of work. Child mutation receipt, effect, optional KV/cursor, invocation deletion and terminal operator receipt commit or roll back together.
- Surface actions persist a domain-separated exact surface/action identity. Operator invocation terminal receipts bind the canonical request hash and provide exact replay/changed conflict through the existing 30-day receipt horizon. Only unresolved HTTP ambiguity survives recovery.
- One active invocation per plugin is enforced inside immediate reservation/transition transactions and by strict open/restore validation.
- Material transitions into degraded/failed/suspended use one global plugin mutation; same-state counters, heartbeat and retry bookkeeping do not publish recursively.
- Private package admission carries cleanup-owning staged-file authority through a bounded worker queue. JBP1/package/component/hash/signature/import verification and content-addressed publication use capped seekable readers and streaming copy, private same-filesystem temporaries, fsync and atomic no-replace publication.
- Startup package reconciliation remains lazy for plugin-free profiles and never constructs a runtime. Missing/corrupt/mismatched package authority is disabled and fenced without changing its claimed digest.

## Database review closure

The first Slice B gate opened six material findings. Focused fixes and recheck established:

- `P7-DB-006`: shared exact surface/action reservation and validation authority;
- `P7-DB-007`: atomic request-bound terminal invocation receipts and replay;
- `P7-DB-008`: AppService-owned first-party effect selection with one transaction;
- `P7-DB-009`: eventful material health transitions and revision-neutral counters;
- `P7-DB-010`: immediate one-active-invocation/plugin fencing;
- `P7-DB-011`: staged streaming package admission over a bounded metadata queue.

The recheck marked all six IDs fixed and explicitly approved Wave 1 persistence.

## Focused validation

Commands run on integrated HEAD:

```text
cargo test --locked -p junban-storage --all-features
# 260 passed

cargo test --locked --workspace --all-targets
# passed across the workspace

cargo clippy --locked -p junban-plugin-sdk -p junban-app -p junban-storage --all-targets -- -D warnings
# passed

git diff --check
# passed
```

The fix worker also ran affected-crate Windows GNU clippy and an optimized concurrent maximum-package probe. The probe measured 15,684 KiB baseline, 81,308 KiB peak and 65,624 KiB delta while exercising concurrent maximum staged packages; the queue retains bounded path/metadata authority rather than package-sized messages. This is targeted admission evidence, not the later Wave 5 integrated performance acceptance.

## Scope boundary

Wave 1 adds no plugin child runtime, Wasmtime engine, operator HTTP/OpenAPI routes, registry UI, React contribution rendering or reference plugins. Those remain Waves 2–5.
