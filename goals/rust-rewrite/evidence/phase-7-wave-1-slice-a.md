# Phase 7 Wave 1 persistence Slice A

Date: 2026-08-04
Status: implementation and local validation complete; Slice B and the independent database review remain
Authority: [`phase-7-schema-contract.md`](phase-7-schema-contract.md)

## Delivered boundary

- Advanced the live and complete-backup schema from v6 to v7 with the ten normalized plugin authority tables, bounded lookup indexes, allocator seed `(1, 1)`, and restricted policy seed `(1, false)`.
- Added storage's direct `junban-plugin-sdk` dependency and reused its canonical manifest, permission/scope hashes, grant subset, semver, dependency graph, and dependency-lock validators.
- Generalized the online SQLite migration snapshot path so an exact canonical v6 profile receives a private verified `pre-v7` snapshot before mutation. Fresh v1→v7 migration does not create one.
- Kept `apply_v7`, migration history, canonical schema, plugin semantics, foreign keys, and integrity checks in one immediate transaction. Commit is the last reported fallible migration operation; later v7 housekeeping is bounded best effort.
- Added strict no-repair plugin authority validation to normal v7 open and complete-backup/restore preflight.
- Sanitized validated restore candidates without package or runtime construction: plugins become disabled and `reverify_required`, activation epochs advance with overflow rejection, runtime failure/backoff is cleared, invocation rows are deleted, and cursors bind the restored epoch/head with resync required. Package generations, allocator, metadata, grants, policy, settings, KV, dependency locks, and publisher trust remain intact.

## Focused evidence

Coverage includes fresh v7 schema/seeds, v6→v7 snapshot verification, future-version rejection, precommit rollback and exact retry, ignored postcommit diagnostic failure, canonical-schema equality, malformed normal-open authority without truncation, malformed restore candidates without live mutation, restore reverify/epoch/cursor sanitization, activation-epoch overflow, and no runtime construction.

Commands passed:

```text
cargo fmt --all -- --check
cargo clippy --locked -p junban-storage --all-targets --all-features -- -D warnings
cargo test --locked -p junban-storage --all-features
cargo test --locked --workspace --all-features
```

The storage suite passed 211 tests. The first workspace run exposed one recovery-process fixture that hardcoded schema version 6; the fixture now derives the candidate's actual migration version, its focused regression passed, and the complete workspace rerun passed.

## Explicitly remaining

This slice does not implement domain/application plugin mutation APIs, global transaction/event/receipt integration, allocator lifecycle mutations, package staging/publication/reconciliation, runtime/child processes, routes, registry, UI, or reference plugins. Wave 1 is not accepted until Slice B and the required independent database review are complete.
