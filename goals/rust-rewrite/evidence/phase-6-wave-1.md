# Phase 6 Wave 1 — schema-v6 typed AI/voice persistence and private secret authority

- **Date:** 2026-08-03
- **Base:** `c111a3f` (Phase 6 Wave 0 evidence)
- **Branch:** `pi-agent-phase6-wave1`
- **Scope:** Wave 1 only — domain settings/entities, SQLite v6, storage primitives, private `ai-secrets.json`. No provider HTTP adapters, run orchestration, UI, routes, or voice inference.

## Delivered

### Typed settings

- `AppSettings` gained strict `AiSettings` and `VoiceSettings` sections with `deny_unknown_fields`.
- Server-confirmed defaults leave cloud AI and cloud speech disabled; existing appearance/temporal/notification/feature behavior is unchanged.
- Base URL validation enforces official HTTPS presets, loopback HTTP for Ollama/LM Studio, and custom HTTPS-or-loopback rules with no userinfo, fragment, or query secret.
- Credential bindings store only random `AiCredentialId` values; raw secret bytes are never a settings type.

### Schema v6

Atomic, idempotent v5→v6 migration adds:

- `ai_sessions`, `ai_messages`, `ai_memories`, `ai_session_memories`
- `ai_tool_approvals`, `ai_run_state`, `ai_quota`
- FK/cascade/indexes and row CHECKs for frozen aggregate quotas and content bounds
- an indexed approval/run binding used by bounded restore validation
- Settings expansion that preserves v5 preferences and clears any hostile pre-v6 credential bindings

Fresh profiles reach schema 6. Retry after a completed migrate is a no-op. Failed mid-migrate transactions roll back with the prior version marker.

### Storage primitives

- Session create/rename/delete/clear, message upsert, memory CRUD/link, approval propose/status, and run-state upsert use the existing single-worker/transaction/event/receipt path.
- Approval proposal, approval/run state transitions, cancellation, generation replacement, operation-ID assignment, and quota updates commit as one crash-valid transaction; normal open expires stale runtime authority before admission.
- AI chat/memory/approval mutations set `undo: None` and never enter `operation_undo`.
- Events are `ai.session.changed|deleted`, `ai.memory.changed|deleted`, and `ai.approval.changed` with ID/status material only (no transcript/secret bodies).
- Session/profile/memory/approval quotas are transactionally maintained from actual UTF-8 lengths and recomputed on open, migration, restore, and focused corruption paths.

### Private secret authority

- Versioned `ai-secrets.json` beside other profile security artifacts.
- At most 32 credentials; 8 KiB per secret; random stable IDs; kind/update time/`present` metadata only on reads.
- A random profile-private HMAC key permits exact receipt matching without storing an offline secret verifier in SQLite or complete backups.
- Reuses Phase 5 `atomic_replace_private_file` (Unix `0600`, Windows owner-only DACL, durable replace).
- Rejects unknown versions/fields/kinds, duplicates, oversize, and durability failure closed.
- Receipt-first binding: publish unreferenced secret → commit settings binding/event under the operation ID → remove superseded unreferenced secret.
- Delete clears the DB binding before deleting bytes.
- Startup reconciliation removes unreferenced IDs; cleanup failure is diagnostic-only.

### Backup / restore

- Complete backup is framed SQLite only and never includes `ai-secrets.json` bytes.
- Candidate restore validation checks canonical AI rows, actual byte counts and quotas, and both directions of every approval/run binding before loading or cutover; the exact historical approval lookup is indexed.
- Candidate sanitization clears every credential-binding ID, forces AI/cloud speech disabled, expires pending approvals/runs, and preserves non-secret preferences/chat/memory/instructions.
- Failed restore never touches the secret file; post-cutover open reconciliation removes now-unreferenced secrets.

## Validation commands and results

```text
cargo fmt --all -- --check
# exit 0

cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
# exit 0

cargo test --locked --workspace --all-features
# 559 passed; 0 failed

cargo audit
# exit 0 (0 vulnerabilities)

cargo deny check
# advisories ok, bans ok, licenses ok, sources ok

git diff --check
# exit 0

node scripts/contract.mjs generate
# regenerated openapi/junban-v1.json and src/ui/api/generated.ts for ResourceTypeDto AI variants
```

Focused coverage includes:

- domain URL/settings/defaults/privacy tests (`junban-domain`)
- secret load/reject/publish/delete/reconcile/failure-injection (`ai_secrets`)
- v5→v6 migrate preservation/idempotency (`migration`)
- non-undoability, quotas, cascades, receipt replay (`ai_wave1_tests`)
- receipt-first binding ordering and failed publication (`ai_wave1_tests`)
- backup excludes secret material; restore clears bindings; failed restore leaves secrets untouched (`ai_wave1_tests`)

## Failure-injection protocol used

1. **Secret publish durability:** replace `ai-secrets.json` path with a directory so atomic replace fails; assert settings binding unchanged and prior in-memory authority retained.
2. **Secret delete durability:** inject persist failure on delete; assert memory and durable file still contain the credential.
3. **Restore envelope truncation:** truncate a framed backup mid-file; assert `prepare_restore` fails and `ai-secrets.json` byte-identical before/after.
4. **Hostile pre-v6 settings:** roll schema marker back to v5 with enabled AI + credential binding in JSON; migrate to v6 and assert binding cleared while non-secret preferences survive.
5. **Quota ceiling:** create `AI_SESSIONS_PER_PROFILE_MAX` sessions then assert the next create is a stable non-retryable validation error.

## Out of scope (deferred)

- Provider HTTP adapters and model discovery (Wave 2)
- Chat run orchestration, tools, authenticated AI routes/OpenAPI surface beyond ResourceType exhaustiveness (Wave 3)
- React AI/voice UI and browser inference (Wave 4)
- Release memory/dogfood closure (Wave 5)

## Review outcome and remaining integration work

The Wave 1 database-dominant gate approved after `P6-DB-001`–`P6-DB-007` were fixed with focused regressions. The stable finding record is [`phase-6-review-ledger.md`](phase-6-review-ledger.md). No separate security gate was required: the credential-verifier concern was resolved inside the persistence boundary, and no distinct material security finding remains.

- AI repository methods are storage-level primitives in this wave; full `Repository` trait/service wiring for every AI operation remains Wave 3 work.
- HTTP settings patch still omits AI/voice sections by design for this wave; confirmed snapshots already deserialize AI/voice defaults when present in storage.
