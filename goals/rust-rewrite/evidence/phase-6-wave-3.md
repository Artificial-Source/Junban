# Phase 6 Wave 3 — application, lifecycle, and operator configuration evidence

- **Date:** 2026-08-02
- **Base:** Wave 3g implementation `070e357` from clean base `4e31903` (earlier Wave 3a–3f bases retained below)
- **Scope:** implemented Wave 3a–3g behavior
- **Claim boundary:** durable AI resources, lazy runtime lifecycle, provider configuration, chat/tool/approval orchestration, exact dispatch recovery, daily briefing, and typed edit/retry/regenerate HTTP/SSE actions. This document does not claim a briefing scheduler, schedule apply, React, voice delivery, or Phase 6 memory/visual closure.
- **Review status:** the integrated security-dominant backend/API gate approved exact head `4602447` with no material finding after all prior chat, tool-run, approval, daily/rewrite, database, and Rust-quality corrections.

## Wave 3a — application and storage service boundary

- The existing `Repository`/`JunbanService` path owns durable AI session, message, memory, approval, run-state, and credential mutations. Resource IDs are service-generated and exact retries return the original committed identity.
- Private credential metadata and transient material resolution now traverse the dedicated SQLite worker and its private `AiSecretStore`; the server never reads the profile secret file directly.
- Secret reads emit no event. Missing or stale credential IDs fail closed. Raw material remains validated, non-serializable, and redacted under `Debug`.

## Wave 3b — lazy runtime lifecycle

- `AiRuntimeSupervisor` remains uninitialized until an admitted operation reaches provider work. Registry and confirmed-config reads do not create a runtime or HTTP client.
- Provider work is available only through a non-cloneable admitted guard. The guard borrows runtime and cancellation authority for the whole operation; raw runtime/client/cancellation handles do not escape.
- Shutdown, restore, and reconfiguration share one synchronized lifecycle authority. Temporary reconfiguration uses an exact epoch, while restore/shutdown invalidates that epoch and enters non-resumable permanent drain. Admission closes before cancellation; a bounded drain must finish before runtime drop.

## Wave 3c — operator HTTP surface

Added the following authenticated operator-only routes:

- `GET /api/v1/ai/providers`
- `GET|PUT|DELETE /api/v1/ai/config`
- `PUT|DELETE /api/v1/ai/credentials/{target}` for exact targets `ai_provider`, `voice_stt`, and `voice_tts`
- `GET /api/v1/ai/providers/{provider}/models`

The provider response is the approved static registry: canonical snake-case IDs, DeepSeek included, xAI absent, frozen origin/auth/capability metadata, and no network/runtime/credential access. Configuration uses a strict full replacement for typed non-secret `AiSettings` and `VoiceSettings`; credential bindings are represented only by presence metadata. `DELETE` canonicalizes AI to disabled while preserving voice and unrelated settings and leaving credential deletion explicit.

AI config/credential bodies have a dedicated 32 KiB transport ceiling. Credential PUT is write-only `{kind, secret}` and returns only binding metadata. Exact retries use the existing idempotent bind receipt path and cannot multiply secrets. Every AI mutation validates request material before draining, serializes against model-discovery admission, closes admission, cancels active guards, waits at most five seconds, drops the prior runtime, and then commits. The validated sequence runs in an owned task holding the same serialization permit, so HTTP cancellation cannot cancel an enqueued storage commit or strand temporary lifecycle state. Timeout returns stable 503 while retaining fail-closed draining state and leaves settings/secret state untouched. After completed drop, the exact still-current epoch resumes admission after either commit success or failure; normal reconfiguration does not enter global maintenance or request restart.

Model discovery requires an exact configured provider, the confirmed base URL, and only that binding's confirmed credential. Endpoint construction applies fixed-cloud, loopback, or explicit custom URL policy. Discovery runs through one guard-owned ephemeral operation and returns bounded normalized provider-reported models. Unsupported discovery fails unavailable before HTTP-client construction; redirects, ambient proxy credentials, and vendor body propagation remain disabled.

## Wave 3d — durable session/message/memory HTTP resources

Added the following authenticated operator-only routes over existing `JunbanService` methods only:

- `GET|POST /api/v1/ai/sessions` — recent-first paged list (max 100) and create with title-only body; service-generated session ID
- `GET|PATCH|DELETE /api/v1/ai/sessions/{session_id}` — PATCH is title-only and strict
- `GET /api/v1/ai/sessions/{session_id}/messages` — ascending `after_sequence` paging (max 100); unknown sessions 404
- `POST /api/v1/ai/sessions/{session_id}/clear`
- `GET|POST /api/v1/ai/memories` — recent-first paged list (max 100) and create with content-only body; service-generated memory ID
- `GET|PATCH|DELETE /api/v1/ai/memories/{memory_id}` — PATCH is content-only and strict

No arbitrary message upsert route is exposed; run orchestration owns message creation later. No manual memory-link route is exposed. Mutation routes require the standard `Idempotency-Key` header. Create/rename/clear/update responses return the canonical typed resource plus the committed event; delete returns the committed mutation only. Exact retries return the original generated ID and event without a second publish.

Opaque URL-safe AI session and memory cursors are kind-bound in `cursor.rs`, so a memory cursor cannot page sessions and vice versa. Malformed, unknown-field, cross-kind, and oversized cursors fail 422 before query. Message paging uses bounded numeric `after_sequence` only.

Session delete/clear and every memory mutation reuse the epoch-owned `reconfigure_owned` helper: validate IDs/body first, close admission, cancel/drain guards, drop runtime, commit, then resume. Session create/rename and all read-only routes do not drain. Request cancellation cannot strand or outlive storage commits; the full temporary epoch remains the safe bounded invalidation path (no untracked per-session cancellation yet). GET list/resource handlers take the same AI reconfigure serialize permit used by config mutations so they cannot observe mid-drain state; they do not hold that permit across provider I/O. Global event payloads remain summary/resource only — no message or memory bodies.

Request bodies reuse the existing 32 KiB AI transport ceiling. All new operation IDs are excluded from the Phase 5 CLI/MCP catalog, preserving the frozen 87-tool surface. `openapi/junban-v1.json` and `src/ui/api/generated.ts` are regenerated artifacts.

## Wave 3e — basic streaming chat vertical

Added two authenticated operator-only routes:

- `POST /api/v1/ai/sessions/{session_id}/responses` with strict `{message, focused_task_id?}`, a 32 KiB transport ceiling, required `Idempotency-Key`, and version-1 local SSE envelopes;
- `POST /api/v1/ai/runs/{run_id}/cancel`, returning stable `cancel_requested`, `already_terminal`, or not-found behavior.

The response route derives turn, run, user/assistant message, and four internal mutation-operation UUIDs (user start, assistant start, running run, and atomic finish) from the caller operation identity with domain-separated SHA-256 labels. RFC variant/version bits are normalized. Stable-vector, label-collision, and cross-operation regressions ensure request/model bodies cannot supply these identities. The optional focused task is captured in canonical durable user-message content, so a retry that changes either text or focus fails the existing receipt identity check.

Preflight holds the shared `ai_reconfigure` serialization permit through active-session and confirmed settings/model/base/credential validation, deterministic prompt assembly, canonical completed-user persistence, deterministic empty streaming-assistant reservation, running-state persistence, and exact generation admission. Reserving the assistant row enforces message-count quota before provider admission. It then releases the permit before provider I/O. Context includes confirmed custom instructions, linked-first selected memories, an optional focused task, terminal durable user/assistant text, and the current user text. Frozen limits are 50 memories, 500 loaded conversation rows, 512 KiB assembled UTF-8, and approximately 8,000 tokens. Current input and any confirmed instructions are non-truncatable; optional context truncates deterministically from oldest/lower-priority material. Empty and over-budget input reject before mutation.

`AiRuntimeSupervisor` now owns each generation's `Running → CancelRequested|Terminal` linearization under its existing short mutex. Cancellation and completion race through that one authority; a barrier regression proves exactly one wins. The non-cloneable guard still owns the provider future for its whole lifetime. Each provider callback first awaits bounded channel capacity in a cancellation-aware select, then synchronously mutates the accumulator and consumes the reserved permit only while the same supervisor lock still authorizes the exact live `Running` generation. Thus cancellation either follows an already committed output or prevents that output from reaching SSE and persistence.

The public stream is a bounded, backpressured 64-message channel of version-1 envelopes with monotonic sequence and only `run_started`, `text_delta`, `reasoning_status`, `usage`, and one of `run_completed|run_cancelled|run_failed`. Vendor frames, bodies, identifiers, tool metadata, provider failure strings, credentials, and hidden reasoning never cross the route. Any unexpected tool event fails the no-tool run. A rolling credential-reflection scanner spans provider string fragments and rejects the completing fragment before SSE emission or assistant persistence. All terminal failures use static marker-free payloads.

Disconnect drops the response-stream permit and requests supervisor cancellation. Explicit cancel, disconnect, restore/reconfiguration cancellation, and normal completion converge on one terminal outcome. One `finish_ai_response` repository/application mutation validates the exact reserved assistant and exact nonterminal run generation, then updates both to matching terminal states in one SQLite transaction, event, and receipt whose canonical request includes all terminal material. Content-quota failure falls back through the same operation identity to an empty failed assistant plus failed run. The run guard is dropped after terminal persistence succeeds or fails and before terminal SSE capacity is awaited, so a stalled receiver cannot retain runtime/drain authority.

Completed/cancelled/failed retries first verify the canonical user receipt, then replay the deterministic assistant plus exactly one matching terminal without settings, credential, runtime, client, or provider access. A nonterminal derived run with no exact active generation is atomically reconciled to cancelled before replay; partial preflight receipts are deterministically completed and reconciled without provider admission. Startup/restore expiration leaves streaming-placeholder response runs for this receipt-backed reconciliation while still expiring other ephemeral AI authority. Post-start admission failure atomically finalizes failed and returns replayable failure SSE. Active exact generations return stable 409. Restart replay is byte-identical to in-process replay.

The generated OpenAPI/TypeScript artifacts include both routes and focused-task message metadata. Both operation IDs remain excluded from the frozen Phase 5 CLI/MCP catalog; its 87 tools are unchanged.

## Wave 3 security review closures

- **P6-SEC-007:** Bound credentials can no longer cross provider authority. AI provider/base-URL and speech-provider changes require explicit credential deletion first; credential PUT is accepted only for the currently confirmed authority and its exact auth-kind matrix. Credential-free providers and browser speech reject material, Inworld STT remains unavailable, and `AuthScheme::None` plus endpoint resolution fail closed on any supplied credential.
- **P6-SEC-008:** Model discovery scans every returned provider-derived model identifier/name/display-name field for the active credential before normalization returns success. Any reflection rejects the complete list with a stable body-free error; neither provider error rendering nor the server response contains reflected material.
- **P6-SEC-009:** Temporary reconfiguration now has exact epoch authority distinct from permanent restore/shutdown drain. Owned workers retain the serialize permit through drain/drop/commit/finish after HTTP cancellation; restore waits for that permit and holds it through permanent AI drain and cutover, while synchronous shutdown invalidates any temporary epoch so it can never reopen admission. Timed-out epochs remain fail-closed.

## Wave 3 API review closures

- **P6-API-001:** `create_ai_session` and `patch_ai_session` acquire the existing `ai_reconfigure` serialize permit before mutation and retain it through canonical response fetch (no runtime drain). Deterministic barrier tests prove concurrent delete cannot interleave into a false 404 after a committed create/rename; idempotent retry identity is preserved.
- **P6-API-002:** AI list query DTOs use `deny_unknown_fields`. Handlers accept `Result<Query<T>, QueryRejection>` and map extractor failures through reusable `extract_query` to the documented stable 422 `ErrorEnvelope`/request id for malformed numeric, negative, unknown, duplicate, and invalid cursor forms. OpenAPI remains 422-only for these query failures.
- **P6-API-003:** `extract_json_with_limit` reports the effective route ceiling. Every AI JSON handler passes exact `MAX_AI_CONFIG_BODY_BYTES` (32768) so 413 code/message match the 32 KiB transport limit. Ordinary routes keep the default 512 KiB helper. 40 KiB regressions cover config/session/memory/credential routes; auth denial still happens first and never echoes bodies.

## Focused regression evidence

Coverage proves:

- provider/config GET creates no runtime or client;
- operator registry, config, exact credential retry/clear, and loopback Ollama discovery happy paths;
- one discovery request constructs exactly one client and returns normalized bounded models;
- unsupported discovery constructs zero clients;
- automation credentials are denied before body parsing for every AI route, including session/memory methods and malformed/oversized credential payloads;
- secret markers are absent from API responses and debug forms while existing persistence tests cover SQLite/event/receipt redaction;
- cloud-to-loopback, cloud-to-custom, cloud-to-cloud, custom-base-URL, STT-provider, and TTS-provider changes with bound credentials fail field validation before drain/client/network activity and leave confirmed settings unchanged;
- the credential authority/auth-kind matrix rejects unselected, credential-free, browser, incompatible, and unavailable targets before drain or secret publication; `AuthScheme::None` and endpoint resolution reject supplied material;
- reflected credentials in OpenAI-compatible data/root arrays, Anthropic, and Gemini model-list identifier/name/display-name fields fail the whole discovery response and remain absent from provider Display/Debug and server bodies;
- held runs are cancelled and drained before commit, timeout leaves DB/private-file state unchanged and remains fail-closed, and post-drop commit failure resumes old confirmed authority;
- deterministic cancellation, restore overlap, and shutdown overlap tests prove the owned worker completes after handler abort, restore waits for the serialized commit before permanent drain, and invalidated epochs never reopen admission;
- operator session/memory CRUD, clear, exact-retry identity, kind-bound cursors, 404/422/bounds, no event payload bodies, lifecycle timeout leaving durable session/memory state unchanged, and cancelled memory mutation worker completion;
- create/rename serialize-through-fetch barrier against concurrent delete (P6-API-001);
- AI list query extractor 422 coverage for malformed/unknown/duplicate/invalid forms on sessions, messages, and memories (P6-API-002);
- exact 32 KiB AI JSON 413 message/code on representative config/session/memory/credential routes with auth-first denial (P6-API-003);
- route/classification/OpenAPI parity and unchanged 87-tool CLI catalog;
- deterministic SHA-256-derived identity vectors/collision checks and changed-message/focused-task receipt conflicts;
- fragmented loopback SSE forwarding, monotonic local envelopes, one durable assistant-before-run terminal, active-duplicate 409, explicit cancel, and disconnect cancellation;
- cancel/completion barrier linearization plus a full 64-slot channel regression proving cancellation-aware reservation, no blocked delta in SSE/SQLite, reconfiguration drain/resume before receiver progress, and guard release before terminal delivery capacity;
- atomic/replayable assistant-placeholder plus run finalization, quota rollback-to-empty-failed fallback, exact-state conflict, partial-preflight recovery, post-start admission failure SSE, and reopen reconciliation without provider egress;
- paused-time comment-only 15-second chat keepalive with continued stream authority;
- empty/unknown/over-budget response input rejection before message mutation and before provider-client construction;
- fragmented credential reflection rejection before the completing delta reaches SSE or SQLite, with static failed terminal and marker-free diagnostics;
- exact terminal replay before and after profile reopen with no second provider round and no restarted runtime/client construction.

## Validation

```text
cargo fmt --all -- --check
cargo test --locked -p junban-domain -p junban-app -p junban-storage -p junban-ai -p junban-server -p junban-cli --all-targets --all-features
cargo clippy --locked -p junban-domain -p junban-app -p junban-storage -p junban-ai -p junban-server -p junban-cli --all-targets --all-features -- -D warnings
cargo check --locked --workspace --all-targets --all-features
node scripts/contract.mjs check
pnpm typecheck
node scripts/check-docs.mjs
cargo audit
cargo deny check
pnpm exec prettier --check goals/rust-rewrite/evidence/phase-6-wave-3.md docs/README.md openapi/junban-v1.json src/ui/api/generated.ts
git diff --check
```

The commands above completed successfully for the Wave 3d delta and are re-run for Wave 3e. Wave 3e additionally runs focused `ai_chat`, `ai_context`, `ai_identity`, runtime-authority, fragmented-loopback response/cancel/disconnect/reflection/restart, body-policy, contract, and 87-tool catalog regressions.

## Wave 3f.1 — authoritative AI tool registry and direct executor

- **Date:** 2026-08-02
- **Base:** clean Wave 3e HEAD `1f6de1a`
- **Scope:** Rust-owned AI tool registry, strict validation/classification, bounded structured result model, and direct `JunbanService` executor only.
- **Modules:** `crates/junban-server/src/ai_tool_registry.rs`, `crates/junban-server/src/ai_tool_executor.rs`

### Inventory and classification

- Exactly **48** unique legacy-parity tool names, each ≤64 bytes, in deterministic registry order from `create_task` through `timeblocking_replan_day`.
- Registry returns existing `junban_ai::ToolSpec` values with closed JSON object schemas (`additionalProperties: false`), hard item/string/range bounds, and descriptions that tell providers only one call is accepted per round.
- Default effect snapshot: **24 read** / **24 approval-required** registrations. `extract_tasks_from_text` is dynamic: `dry_run` default `true` is read; `dry_run: false` is approval-required.
- `auto_schedule_day` and `reschedule_day` are always preview reads in this subwave. Results set `preview_only: true` and `apply_supported: false`. No model-authored apply/hash authority is accepted.

### Validation and result model

- Model calls parse into a private exhaustive `ValidatedToolAction` enum. Argument DTOs use `serde(deny_unknown_fields)`.
- Rejected before execution: unknown names/fields, duplicate JSON keys, malformed/non-object JSON, forbidden fields (operation/approval IDs, URLs, paths, credentials, revisions, preview/apply authorities, tokens), disallowed control characters, and arguments over the existing 128 KiB bound after canonicalization.
- `validate_tool_call` runs exhaustive semantic validation immediately after deserialize (domain parsers, min/max/item/string limits, nonempty composites, date/time/range ordering, recurrence, enums). Invalid calls never become `ValidatedToolAction`.
- Tag array ceilings use `MAX_TAGS_PER_TASK` (100), not 500. Query/result limits reject `0` rather than silently clamping. Advertised JSON schemas use the same constants.
- `ToolResultEnvelope` is structured/trusted: tool name, outcome, data, truncated flag; optional `operation_id`/`revision` only for approved executor mutations. No receipts, request headers, access tokens, provider/vendor IDs, raw errors, Debug payloads, or arbitrary HTML.
- Canonical result JSON is bounded to 256 KiB with one recursive aggregate 500-array-element budget over every JSON array in the payload (including nested arrays, ID arrays, `task_jar`/`dopamine_menu`, blocks/slots), preserving object/scalar fields and marking truncation, then a deterministic binary-search byte-budget pass. Scalar oversize returns a stable `result_too_large` error.

### Executor

- Executes only through current `JunbanService` methods. No direct SQLite/file/network/provider/plugin/recovery/settings/backup/export/import/secret authority.
- One sampled server-local date/time/zone per `ToolExecContext`.
- Mutations require a caller-supplied server-owned root `OperationId` at the executor boundary and fail closed without it.
- Composite actions (`bulk_create_tasks`, `break_down_task`, extract apply) pre-validate every element before the first effect, derive deterministic child operation IDs from the approved root (`junban.ai.tool.child.v1`), and on unavoidable later concurrent failure return a bounded partial outcome (committed child resource IDs, child operation IDs, revision/event type, failed index, static error code) rather than a plain error that hides effects.
- Tag add/remove resolves bounded names first via `resolve_tags_by_names`, then applies `BulkAction::Tag` for a one-task vector (transactional CAS; no stale read-modify-write).
- Catalog AI tools use bounded/exact repository reads (`list_projects_bounded`, `list_tags_bounded`, `get_project`, `get_projects_by_ids`, `get_project_by_name`, `resolve_tags_by_names`) with indexed/LIMIT SQL; they do not call unbounded `list_catalog`. Full `list_catalog` remains for non-AI catalog surfaces.
- `bulk_update_tasks` semantic validation rejects empty `task_ids`, missing update groups, and conflicting groups before returning `ValidatedToolAction`; provider schema advertises `minItems: 1` and mutually exclusive group descriptions matching executor reality.
- AI `weekly_review` uses `weekly_review_bounded`: bounded analysis task snapshot plus exact `get_projects_by_ids` for referenced projects only (max 500 unique IDs, deterministic truncate + `projects_truncated`). Ordinary HTTP `weekly_review` still uses full `list_catalog`.
- Analysis tools are conservative/local over existing planning/stats/catalog APIs (no nested LLM). Memory is content-only. Extraction is deterministic line/bullet parsing. Tags/projects are never silently created by name.
- Scheduling preview and availability share one confirmed `settings.planning.work_hours` snapshot (documented 09:00–17:00 fallback when unset), merge clamped block **and** slot occupied intervals, and place a task only in a gap large enough for its full duration.
- Generic mutation results include committed `event.primary` `{kind,id}`. Initial execution and direct receipt recovery share the same pure formatter, so exact replay preserves the complete result, including `save_memory` identity.

### Focused tests

- Registry snapshot/count/names/effects and closed schemas without operation/approval IDs.
- Strict argument rejection, bounds, duplicate keys, forbidden-name fuzz corpus, schema/parser agreement, invalid mutation table, bulk_update_tasks table-driven group validation, recursive aggregate array budget (blocks+slots, nested/energy keys), and large-description byte-budget performance.
- Mutation-without-root failure, deterministic child IDs/replay, composite pre-validation + partial failure/retry identity, tag CAS interleaving survival, schedule gap/slot/merge/boundary/insufficient-gap, work-hours settings snapshot, mutation primary + save_memory exact replay, bounded catalog reads, weekly_review_bounded no-`list_catalog` spy + referenced-project bound, extract dry-run vs apply classification, schedule preview non-mutation, and one in-memory pass covering all 48 tools against declared service capabilities or stable error/unavailable outcomes.
- Storage: bounded project/tag pages, exact project lookup, multi-id project lookup bound/index checks, multi-tag-name resolve, unchanged full `list_catalog`, and EXPLAIN QUERY PLAN index/LIMIT checks.
- Phase 5 CLI/MCP catalog remains intentionally unchanged at **87** tools.

### Independent Wave 3f.1 review

The direct tool-boundary gate approved after focused correction and exact-delta re-review of `P6-3F1-001`–`P6-3F1-007`. The review ledger records each fixed finding and its regression authority.

### Non-claims for Wave 3f.1

- Not wired to provider orchestration, tool-call streaming, multi-round loops, or chat SSE tool envelopes.
- No approval propose/consume routes, startup recovery of dispatching approvals, daily briefing, edit/regenerate, or React AI/tool UI.
- No schedule apply mutation and no model-supplied preview/apply hash authority.
- No CLI/MCP AI tools and no Phase 6 release/memory/visual acceptance claim.

## Wave 3f.2a — durable cancellation/dispatch recovery primitives

- `CancelAiResponseRequest` now drives one receipt-backed transaction that exact-matches the reserved streaming assistant and run generation. Running cancellation or a pending/approved awaiting-approval cancellation atomically terminalizes assistant/run, expires bound authority, preserves exact quota counters, and rejects a dispatching or terminal winner without changes. Cancelled partial assistant text is included in canonical receipt identity.
- `finish_ai_response` accepts an optional dispatch operation identity. Ordinary running completion/failure requires it absent. A dispatching run completes/fails only when its exact bound approval is consumed and stores that same canonical operation identity. Cancellation no longer uses the finish path.
- Schema v6 binds every run to one non-null, unique `assistant_message_id`. Fresh creation, canonical upsert receipt identity, every run CAS, proposal/cancel/finish, startup reconciliation, normal open, and restore preflight validate the exact session/turn/assistant/run/generation/message edge. Startup terminalizes only each run's bound streaming assistant; unrelated assistants and distinct same-turn runs are not conflated.
- Normal open and restore-candidate sanitization fully validate every durable approval and approval/run edge before recovery, including typed/canonical IDs and statuses, UTF-8 and byte counts, canonical object arguments, canonical tool names, timestamps/expiry, dispatch operation IDs, assistant bindings, and recomputed action hashes. Approval action hashes use `junban.ai.approval.action.v1\0` plus length-framed canonical tool name and arguments; storage remains semantic-tool-agnostic while the server registry owns the allowlist and argument semantics.
- Valid consumed/dispatching authority is preserved. The indexed recovery read returns every pair only when the total is at most 500; it never truncates. The 501st consume, normal open with 501 forged pairs, and restore preflight with 501 pairs fail atomically and closed.
- `AiRuntimeSupervisor` owns approval wait, non-cloneable decision authorization, queued cancellation, permit-drop failure, and one exact dispatch notification under the existing short mutex. A dispatched payload carries the exact dispatch operation, completed/failed terminal outcome, and canonical provider-neutral `ToolResultEnvelope` JSON bounded to 32 KiB. Composite results retain exact child receipt metadata while omitting misleading top-level child metadata, so the payload separately retains the approved root dispatch identity. Waiters use stored state plus `Notify` without polling; queued cancellation stops further provider work but cannot overwrite a durably finished dispatch outcome, and lifecycle drain retains the permit and run guard through completion.
- Focused storage/application tests cover cancellation replay/mismatch, both cancellation/consume race orders, dispatch completion/failure and operation mismatch, exact assistant cross-binding and same-turn multi-run startup behavior, restart/restore survival, corrupt-pair fail-closed open, exact 500/501 consume/open/restore boundaries, stale consumed-argument hashes, malformed approval field classes, and quota/event/receipt atomicity. Paused/barrier and service-backed runtime tests cover both authorization/cancel orders, queued failure, permit drop, durable approval reload plus server-registry validation and service execution, one exact persisted/emitted bounded result, terminal phase ownership, and drain through durable finish, permit completion, and guard drop.

### Authority-hardening validation

The P6-AUTH-001–004 correction pass completed focused regressions followed by:

```text
cargo test --locked -p junban-domain -p junban-app -p junban-storage -p junban-server --all-targets --all-features
cargo clippy --locked -p junban-domain -p junban-app -p junban-storage -p junban-server --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
node scripts/contract.mjs check
node scripts/check-docs.mjs
git diff --check
```

The independent authority gate approved after correction and exact-delta re-review of `P6-AUTH-001`–`P6-AUTH-004`.

### Non-claims for Wave 3f.2a

- No provider tool loop, detached dispatch/recovery worker, public approval routes, OpenAPI changes, tool SSE envelopes, or UI wiring is included. The 3f.2a runtime/storage contract and service-backed ordering regression do not claim that 3f.2b worker delivery; those remained Wave 3f.2b.
- No new provider, credential, network, plugin, CLI, or MCP authority is added.

## Wave 3f.2b — provider tool loop, public decisions, and exact recovery

- Provider orchestration supports at most eight bounded rounds and at most one validated tool proposal per round. Read tools execute immediately through `JunbanService`; mutations stop at durable approval. Provider call IDs remain internal only, and provider frames, raw bodies, credentials, internal dispatch roots, and hidden reasoning never enter local SSE, durable transcripts, model continuation messages, logs, or public approval DTOs.
- Version-1 local SSE adds `tool_proposed`, `tool_approved`, `tool_rejected`, and `tool_result`. `AiMessageContent` retains one canonical, bounded, provider-neutral tool-event transcript with assistant UTF-8 offsets. Exact retries interleave durable text and every retained tool card before the terminal event without provider egress.
- Authenticated operator-only `GET /api/v1/ai/approvals/{id}`, `POST .../approve`, and `POST .../reject` enforce Host/Origin, body, idempotency, exact action-hash, generation, expiry, and state authority. The generated OpenAPI/TypeScript contract includes these routes while the Phase 5 CLI/MCP catalog remains exactly 87 tools.
- A private non-HTTP approval-dispatch module owns detached decision authorization, approve/reject workers, random server-only UUID-v4 dispatch roots, tool execution, startup recovery, transcript checkpoints, terminal persistence, and runtime completion. HTTP routes own transport/DTO/error mapping only. A separate private transcript module owns the 30 KiB chat-result boundary, complete-composite fail-closed policy, event append validation, and stable rejection result.
- Approval consumption atomically persists `Consumed` + `Dispatching`, the private dispatch root, and exactly one `tool_approved` checkpoint. Rejection atomically persists authority plus `tool_rejected`/`tool_result`. Terminal finish atomically appends the bounded result and terminalizes the bound assistant/run. Handler drop, cancellation, expiry, lifecycle drain, and backpressure cannot authorize a second effect or overwrite a committed dispatch winner.
- AI composite creation is capped at 100 children while the product-wide mutation ceiling remains 500. Every committed child retains resource, one-way child-operation, revision, and event identity; partial results retain `failed_index` and static failure context. Oversized authoritative manifests fail closed rather than truncating committed effects.
- Startup recovery runs before listener admission and never constructs a provider, credential, or runtime. It validates every consumed/dispatching pair, reuses the private dispatch root, protects exact receipts from age cleanup while recovery is pending, and either reproduces the exact bounded result once or leaves the run `Dispatching` and fails startup. Unrelated or mismatched receipts cannot become successful tool results.
- Normal open and restore preflight enforce event-specific transcript payload schemas, unknown/private-key rejection, canonical IDs/timestamps/hashes, approval/card/tool/arguments/expiry cross-binding, and private dispatch-root non-exposure.

## Wave 3g — durable daily briefing and typed response actions

- Operator-only SSE routes add assistant-only daily briefing and typed edit/retry/regenerate actions without changing the 87-tool CLI/MCP catalog. Transport DTOs remain strict and generated OpenAPI/TypeScript artifacts cover all four routes.
- Daily reservation reuses ordinary schema-v6 response history. One partial unique expression index enforces one streaming/completed assistant briefing per profile-local date; failed/cancelled attempts remain visible and may be retried. Provider context adds exactly one ephemeral server-owned user instruction with the exact date, read-only `plan_my_day`-first/no-apply language, and confirmed default energy as `N/5` when configured. Custom instructions remain system messages; only the assistant briefing is durable, and no internal identifier or secret enters the prompt.
- Basic chat and edit/retry/regenerate now share one confirmed active-session/provider/model/base/context/focused-task/memory/credential/endpoint/request preflight under the existing reconfiguration admission mutex. The typed-action suffix transaction verifies receipt/invalidation authority first, retains the exact prefix, rejects active durable suffix runs, stores 30-day run tombstones, removes approvals/runs/messages safely, appends one deterministic replacement turn, and recomputes exact session/profile/pending-approval quotas.
- Exact terminal retries verify the typed canonical request and replay durable SSE without provider setup, even after settings change. Removed generic or typed runs fail against tombstones before obsolete receipts or provider work. Invalidation session IDs remain historical metadata after session deletion and expire only with their exact receipt horizon.
- Complete-restore preflight authenticates the framed manifest, payload hash, and SQLite integrity before applying only the known atomic/idempotent current-v6 response-authority correction to a writable v6 candidate. Canonical schema and semantic validation still reject conflicting objects or malformed data.
- An owned setup task retains the SSE permit, sender, mutex, prepared request, state, and runtime admission across commit. Receiver-drop barriers before commit, after commit, and after admission prove durable terminalization and unrelated-run isolation while a deterministic fixture records zero accepted provider connections.

### Wave 3g validation

The initial Wave 3g complete locked workspace suite passed, including 191 storage tests, 236 server library tests, six server process-lifecycle tests, CLI/MCP catalog and process suites, and the domain/application/provider suites. Its denied-warning workspace Clippy, Rust formatting, diff checks, contract generation/drift, TypeScript typecheck, 373 frontend tests, production frontend build, documentation/runtime/local-voice boundary checks, Rust advisory/license/source policy, and production/full npm audits also passed.

The material-review correction recheck covers authenticated current-v6 backup repair and conflicting-object rejection; no-FK historical tombstones across session deletion, stale-run rejection, backup/restore/reopen, and horizon cleanup; shared basic/action preflight equivalence; `AiSse` ownership; ephemeral daily user/default-energy provider context with assistant-only durability; and zero accepted provider connections across all three receiver-drop barriers. Its final executed checks are recorded in the Phase 6 review ledger. Loopback fixtures supplied provider traffic; no live vendor egress, UI visual run, global runtime reconfiguration, or memory-closure claim was made.

### Prior tool-run, recovery, and quality validation

The final correction pass ran the complete domain, application, storage, and server package suites; focused 100-child success/partial authority, exact receipt recovery, save-memory result equivalence, stop-after-consume, detached decision, cancellation ordering, startup recovery, live-versus-replay transcript, UTF-8 offset, and malformed normal-open/restore regressions; denied-warning workspace Clippy; Rust and repository formatting; contract generation/drift; documentation; and diff checks. The final server recheck passed 232 library tests and six process-lifecycle tests; the restore/reconfigure timing regression additionally passed 20 focused repetitions. The security gate approved `P6-TOOLRUN-001`–`P6-TOOLRUN-003`, and the Rust architecture/DX gate approved `P6-QUALITY-001` after the non-HTTP dispatch/transcript ownership extraction.

## Non-claims

- No background daily briefing scheduler, schedule-apply mutation, or model-supplied preview/apply authority.
- No arbitrary message upsert HTTP route; message creation remains owned by response orchestration.
- No manual memory-link HTTP route.
- No voice audio/STT/TTS HTTP routes, browser media path, cloud speech adapter, or local inference.
- No React AI/voice/settings UI.
- No live vendor egress, vendor model-catalog snapshot, OAuth/subscription-login emulation, or complete model catalog.
- No CLI/MCP AI tools; the Phase 5 catalog remains intentionally unchanged at 87 tools.
- No Phase 6 release, production-memory acceptance, visual acceptance, or Wave 4/5 completion claim.
