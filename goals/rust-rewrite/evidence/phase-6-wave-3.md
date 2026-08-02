# Phase 6 Wave 3 — application, lifecycle, and operator configuration evidence

- **Date:** 2026-08-02
- **Base:** `c543b7f`
- **Scope:** implemented Wave 3a–3d behavior only
- **Claim boundary:** durable application wiring, guard-owned lazy runtime lifecycle, operator-only provider/configuration/credential/model-discovery HTTP APIs, and operator-only durable session/message/memory HTTP resources. This document does not claim chat orchestration, run SSE, approvals/tools, or UI/voice delivery.

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
- route/classification/OpenAPI parity and unchanged 87-tool CLI catalog.

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

The commands above completed successfully for this Wave 3d delta. Focused lifecycle, route, secret-worker, provider-runtime, session/memory, and catalog tests were also run individually while implementing the change.

## Non-claims

- No chat/run SSE routes, conversation orchestration, prompt assembly, tool dispatch, approval UI, or memory retrieval policy beyond durable CRUD/list.
- No arbitrary message upsert HTTP route; message creation remains owned by later run orchestration.
- No manual memory-link HTTP route.
- No voice audio/STT/TTS HTTP routes, browser media path, cloud speech adapter, or local inference.
- No React AI/voice/settings UI.
- No live vendor egress, vendor model-catalog snapshot, OAuth/subscription-login emulation, or complete model catalog.
- No CLI/MCP AI tools; the Phase 5 catalog remains intentionally unchanged at 87 tools.
- No Phase 6 release, production-memory acceptance, visual acceptance, or Wave 4/5 completion claim.
