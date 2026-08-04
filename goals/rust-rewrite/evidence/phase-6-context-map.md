# Phase 6 Context Map and Contract Plan

- **Date:** 2026-08-02
- **Base:** `351c842` (`feat: add native CLI and MCP automation`)
- **Working branch:** `phase-6-ai-voice`
- **Scope:** approved ExecPlan Phase 6 — optional Rust AI/provider orchestration, durable chat and memory, bounded context and shared tools, preserved AI/voice interface, lazy browser voice, security, accessibility, and release evidence.

## Purpose and observable outcome

Junban's approved AI chat and voice experience works again without reintroducing the retired Node backend or a second application authority. Users can configure a supported provider, discover models, stream a conversation, manage sessions and memories, approve tool actions, request planning and auto-scheduling, dictate by push-to-talk or hands-free voice, and hear responses. All provider and cloud-speech network work runs through optional Rust services. Browser-native speech, microphone capture, VAD, playback, and deliberately lazy local browser models remain frontend responsibilities.

The completion bar is observable end to end:

1. ordinary server, CLI, MCP, recovery, and web startup does not construct an AI HTTP client, inspect secrets, load a model, request microphone access, create an `AudioContext`, start a worker, or make a provider request;
2. schema-v6 sessions, messages, memories, approvals, typed non-secret preferences, backup, restore, multi-client refresh, and deletion semantics use the existing application/storage authority;
3. OpenAI, Anthropic, Gemini, nine named OpenAI-compatible/local presets, and a reviewed custom endpoint normalize to one bounded stream/tool/error contract;
4. model output can invoke only Rust-owned AI tools, every mutation passes normal `JunbanService` validation and transaction/event/receipt semantics, and no model can invoke security, recovery, data-export, file, network, credential, or plugin authority;
5. Stop or End Call invalidates the run/call generation before late transcript, token, tool, persistence, or audio effects can apply;
6. the legacy chat panel/view, history, Settings AI/Voice tabs, tool cards, push-to-talk, VAD, and call overlay are preserved across desktop and mobile, with accessible focus, status, permission, and error behavior;
7. mock-provider contracts, hostile-output security tests, immutable Phase 6 screenshots, real browser dogfood, and separate disabled/enabled release measurements pass;
8. the phase ends as one clean commit: `feat: add optional Rust AI and voice`.

## Baseline and evidence

- Phase 5 is accepted at `351c842`: 518 Rust tests, 345 frontend tests, exact HTTP/remote CLI/local CLI/MCP conformance, and accepted release automation evidence.
- The active workspace has `junban-domain → junban-app → junban-storage → junban-server` plus Phase 5 CLI/MCP consumers. One lock-retaining SQLite worker remains the sole profile owner.
- No AI/voice runtime, schema, route, or provider dependency exists. `Sidebar.tsx` exposes a disabled AI placeholder, `BottomNavBar.tsx` omits the center AI control, `SettingsDialog.tsx` deliberately hides AI/Voice, and `Timeblocking.tsx` has no AI scheduler.
- The live schema is v5. `AppSettings` is a strict typed aggregate with `deny_unknown_fields`; raw provider secrets are not a setting type.
- The archived implementation at `/home/xn3/Projects/Personal/ASF/Junban-legacy` is the behavioral and visual authority. Its active UI is `AIChat → AIChatPanel`, `components/chat/**`, `ChatHistory`, `VoiceCallOverlay`, `AITab`, `VoiceTab`, `AIContext`, `VoiceContext`, `useVoiceCall`, and `useVAD`. Its Node provider/storage architecture and browser-stored cloud keys are not authority.
- The legacy provider list is OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, DeepSeek, Gemini, Mistral, Kimi, DashScope, Groq, and Z.AI, plus custom configuration. The active legacy OAuth-looking path is manual token paste, not a standards-based third-party browser flow.
- Current official API research on 2026-08-02 supports four chat wire families: OpenAI Responses, OpenAI Chat Completions compatibility, Anthropic Messages, and Gemini `generateContent`. No shipped provider documents a third-party OAuth flow that lets Junban bill a consumer web subscription.
- Phase 1's frozen hosted ceiling remains 24 MiB maximum warm cgroup memory and 32 MiB peak. Disabled AI/voice must also remain within the larger of 15% or 1 MiB matched median variance against the Phase 5 base.

## In scope

- Provider registry, capability metadata, model discovery, normalized streaming, bounded retries/timeouts, and graceful errors.
- OpenAI Responses, Anthropic Messages, Gemini `generateContent`, and one OpenAI Chat-compatible adapter with presets for OpenRouter, Ollama, LM Studio, DeepSeek, Mistral, Kimi, DashScope, Groq, and Z.AI.
- One operator-configured custom OpenAI-compatible endpoint under the egress policy below.
- File-backed owner-private provider/speech secrets with write-only HTTP updates and presence-only reads.
- Typed AI/voice preferences; durable chat sessions/messages, memories, tool proposals/approvals, and daily briefing state.
- Bounded task/project/schedule context, custom instructions, explicit memory tools, local analysis, and the approved task/project/tag/reminder/planning/timeblocking/scheduling tool reach.
- Streaming chat, session/history/message actions, focused-task context, daily briefing, tool cards and approvals, retry/edit/regenerate, and clear/delete behavior.
- Browser speech recognition/synthesis, microphone selection, push-to-talk, browser VAD, and playback; Groq/OpenAI-compatible STT, OpenAI/Groq/Inworld-style TTS; lazy local browser Whisper and local browser TTS where dependency review approves maintained packages.
- Half-duplex voice-call UX: listen → transcribe → reason/tool → speak → listen, with the approved overlay and privacy controls.
- AI auto-schedule preview/application through existing Phase 3 timeblocking use cases.

## Out of scope

- Copying legacy Node routes, database code, provider SDK layout, plugin provider registry, or plugin-contributed tools.
- OpenAI Realtime WebSocket, Inworld bidirectional WebSocket, or a general WebSocket framework; request/stream STT/chat/TTS satisfies the approved user flow.
- Unsupported subscription-login scraping, Codex/Claude consumer OAuth reuse, invented generic OAuth, or browser-held cloud API keys.
- A bundled server-side local model runtime, model downloads in the Rust server, arbitrary executables, or eager browser model downloads.
- Provider live-network tests in CI, hard-coded complete vendor model catalogs, or claims that every routed model supports every tool/audio feature.
- Desktop-native microphone/tray/global-capture integration (Phase 8), plugin AI capabilities (Phase 7), and semantic vector search without a demonstrated requirement.
- Arbitrary model-controlled HTTP, filesystem, command execution, backup/restore, export/import, credentials, host policy, diagnostics, reminder delivery control plane, or plugin administration.

## Architecture and ownership boundaries

### Dependency direction

Add the planned `crates/junban-ai` boundary. It owns protocol adapters, provider normalization, orchestration state, context bounds, retry policy, speech adapter contracts, and test mocks. It may depend on `junban-domain` and the narrow application contracts it needs; it never depends on storage, server routes, CLI, MCP, Tauri, or a vendor SDK. `junban-server` composes it lazily with `JunbanService`, authenticated routes, SSE, maintenance, and the secret store. `junban-storage` remains the only SQLite implementation.

`junban-domain` remains free of HTTP, SQLite, and vendors. `junban-app` owns durable AI use cases and existing task/planning semantics. Provider token deltas are ephemeral and do not consume global revisions. Durable session/message/memory/approval changes each use the existing one-transaction/one-event/one-summary/one-receipt mutation boundary. Tool-caused product changes use their existing event types and receipts rather than an `ai.tool` shadow mutation.

Recovery mode never constructs AI state. Maintenance admission closes first, accepted AI and speech work is cancelled and drained, then the existing SSE/reminder/SQLite restore boundary proceeds. A failed drain is fail-closed and cannot reopen ordinary admission.

### Lazy composition and disabled state

The default and every migrated profile starts with no configured AI provider. Server startup may hold only static provider metadata; it must not create `reqwest::Client`, TLS pools, refresh tasks, model caches, secret values, cancellation workers, or local engines. The first authorized configured operation constructs a bounded runtime through `OnceLock`/mutex-protected lazy state. Disabling or replacing a provider cancels active work, drains it, drops clients/caches, and only then confirms the setting transition.

React AI routes and contexts are dynamic imports. The ordinary workspace does not fetch AI configuration. Microphone/media, speech recognition, `AudioContext`, VAD analysis, and local voice workers are created only from a user gesture in an opened AI/Voice surface and are stopped on close, disable, Stop, End Call, permission failure, or unmount.

### Schema v6 and durable limits

Schema v6 adds bounded first-party data, with foreign keys and row-value validation through domain constructors:

- `ai_sessions`: ID, title, lifecycle status, created/updated/last-message instants;
- `ai_messages`: ID, session/turn IDs, monotonic session sequence, role, lifecycle status, bounded structured content, and timestamps;
- `ai_memories`: ID, bounded user-approved content, created/updated instants;
- `ai_tool_approvals`: ID, session/turn/run generation, tool, canonical arguments, action hash, expiry, one-time status, and timestamps;
- daily briefing generation is represented by an ordinary assistant message plus its local date; no second scheduler store is added.

Frozen bounds:

| Item                                                     |                  Bound |
| -------------------------------------------------------- | ---------------------: |
| Sessions returned per page                               |                    100 |
| Messages returned per page                               |                    100 |
| Sessions per profile                                     |                    500 |
| Messages / durable content per session                   |           500 / 32 MiB |
| Total durable AI content per profile                     |                128 MiB |
| Memories per profile / total memory content              |            500 / 5 MiB |
| Pending approvals per profile / total approval content   |            128 / 1 MiB |
| Session title                                            |        200 UTF-8 bytes |
| User/custom-instruction input                            |        32 KiB / 16 KiB |
| Assistant text per completed turn                        |                512 KiB |
| Canonical tool arguments / one tool result               |      128 KiB / 256 KiB |
| Provider stream frame / complete response                |         64 KiB / 1 MiB |
| Memories considered per run                              |                     50 |
| One memory                                               |     10,000 UTF-8 bytes |
| Advertised tools / tool rounds per run                   |                 64 / 8 |
| Concurrent runs per profile                              |                      4 |
| Context tasks/projects/schedule rows                     |              500 total |
| Serialized assembled context before instructions/history |                512 KiB |
| Discovered models retained/returned                      |                  1,000 |
| Model/provider/base-URL identifiers                      | 256 / 64 / 2,048 bytes |
| Provider error body inspected                            |                 64 KiB |
| Cloud audio request / response                           |        25 MiB / 25 MiB |
| Approval lifetime                                        |              5 minutes |

Session and profile byte counters are transactionally maintained from canonical UTF-8/JSON lengths and recomputed during migration, startup validation, candidate restore validation, and focused corruption tests. The quota leaves at least 384 MiB of the existing 512 MiB complete-backup payload ceiling to ordinary profile data; reaching a quota is a stable non-retryable validation error. A session deletion first revokes its generation and approvals, waits for accepted work to stop, then deletes at most 500 messages / 32 MiB in one bounded transaction. Restore expires all pending approvals/runs. Complete SQLite backup includes every v6 table but explicitly excludes `ai-secrets.json`; JSON/CSV/Markdown exports exclude both AI conversations and secrets.

Mutation authority is frozen rather than left to implementation judgment:

| Mutation                                                          | Global event / resync payload                                                         | Idempotency and receipt                                                                          | User undo                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Session create/rename/delete/clear                                | `ai.session.changed                                                                   | deleted` with session ID, status, sequence and bounded counts only                               | Required operation ID and bounded summary receipt         | Not advertised; deleted message bodies never enter a receipt |
| User message create/edit and assistant complete/fail/cancel       | `ai.session.changed` with session/message IDs and terminal status; no text/token body | Run/turn ID is the idempotency key; bounded terminal summary                                     | Not advertised                                            |
| Memory create/update/delete                                       | `ai.memory.changed                                                                    | deleted` with memory ID only                                                                     | Required operation ID and bounded summary receipt         | Not advertised                                               |
| Approval propose/approve/reject/expire/consume                    | `ai.approval.changed` with approval/session/turn IDs and status only                  | Approval ID + generation + one-time state; dispatch receipt stores operation ID/result reference | Not advertised                                            |
| AI/voice non-secret settings and credential binding               | Existing `settings.updated` snapshot/event and receipt semantics                      | Existing settings operation ID/receipt                                                           | Existing settings policy; no secret bytes in inverse data |
| Tool-caused task/project/tag/reminder/planning/timeblock mutation | Existing resource event and receipt                                                   | Existing application operation ID generated at dispatch                                          | Existing tool target's undo contract, unchanged           |

AI chat/memory/approval operations do not appear in generic operation-undo discovery. This matches the legacy product and prevents large or secret-bearing inverse material.

### Typed settings and secret authority

`AppSettings` gains strict `AiSettings` and `VoiceSettings` sections. Non-secret authority includes selected provider/model/base URL, an optional random credential-binding ID, custom instructions, daily briefing, default energy, STT/TTS provider/model/voice, voice mode, TTS enablement, auto-send, smart endpoint, and 500–3,000 ms grace period. Confirmed server snapshots alone drive provider/model and server speech behavior. Microphone device ID remains per-browser local state because it is browser-origin-specific.

Raw API keys, bearer credentials, and Inworld credentials live in a strict versioned `ai-secrets.json` beside current private security artifacts. Reuse the owner-private atomic create/replace primitives and Windows DACL behavior established in Phase 5. The file holds at most 32 randomly identified credentials and 8 KiB per secret. Reads expose only stable credential IDs, kind, update time, and `present`; delete is idempotent. Unknown versions, fields, kinds, oversized values, duplicates, and permission/ACL failures fail closed.

Secret publication is receipt-first and fail-closed: atomically publish a new unreferenced secret ID, then commit the settings credential binding and event under one operation ID, then atomically remove the superseded unreferenced entry. A failed file publication leaves settings unchanged; a failed database binding leaves only an unreachable orphan; a failed old-entry cleanup leaves both bytes private but only the new ID reachable. Startup reconciliation removes IDs not referenced by confirmed settings and never invents a binding. Delete clears the database binding before deleting bytes, so any deletion failure leaves only an unreachable orphan. In-memory authority follows the confirmed binding, never mere file presence.

Complete backup remains safe for existing `data`-scoped automation because it never contains provider or speech secrets. Candidate restore validation clears every credential-binding ID and forces AI/cloud speech disabled before cutover while preserving non-secret provider preferences, chat, memories, and custom instructions. A failed restore never touches `ai-secrets.json`. After successful cutover the normal startup reconciler removes now-unreferenced old entries; failure to clean them is diagnostic-only because no restored setting can address them. No encryption format, passphrase, or coordinated secret/database rollback is claimed in Phase 6.

Secrets never enter SQLite, settings SSE, OpenAPI examples, generated TypeScript fixtures, argv, URLs, query strings, diagnostics, tracing fields, errors, model prompts, tool schemas/results, browser storage, evidence, or test output. Provider request headers are sensitive, redirects and ambient proxies are disabled, and bounded vendor error text is structurally redacted before mapping to Junban errors.

### Egress and authentication policy

Built-in cloud presets use fixed official HTTPS origins. Ollama and LM Studio default to loopback HTTP only. A custom URL is operator-authored, contains no userinfo/fragment/query secret, and is either HTTPS or loopback HTTP. Redirects are disabled. Provider/model data and model output cannot modify the URL. Custom private-network HTTPS is allowed only as an explicit operator configuration because Tailnet/LAN local models are an intended product capability; that trust decision is displayed before saving. Model discovery and inference use the same reviewed authority.

AI configuration, secret administration, LM Studio load/unload, chat runs, approvals, and cloud speech are operator-only HTTP routes. Routine Phase 5 automation credentials do not gain provider-secret or model-execution authority in Phase 6. Read-only chat/session routes are not added to routine MCP resources. This can be reopened later only through an explicit scoped-automation design.

No current named provider exposes an official consumer third-party OAuth flow suitable for Junban. Phase 6 therefore preserves provider authentication capability with documented API keys or externally issued bearer credentials and explicitly removes the misleading legacy `OAuth Token` mode. No provider subscription-login flow is emulated.

### Provider-neutral stream contract

The browser sends one authenticated bounded `POST /api/v1/ai/runs` request and consumes `text/event-stream` from the fetch response. Each event contains strict `version`, `run_id`, `generation`, monotonic `sequence`, `type`, and one bounded typed payload. Event types are:

- `run_started`, `text_delta`, `reasoning_status` (no hidden chain-of-thought content),
- `tool_proposed`, `tool_approved`, `tool_rejected`, `tool_result`,
- `usage`, `run_completed`, `run_cancelled`, and `run_failed`.

Provider frames normalize inside `junban-ai`; raw frames and vendor request IDs are not forwarded by default. The server never emits hidden reasoning text. SSE keepalive comments carry no data. The response closes after exactly one terminal event. A client disconnect cancels the run. `POST /api/v1/ai/runs/{id}/cancel` is idempotent and handles a still-connected stream. Network reconnect does not replay a provider stream; the client reloads durable session state and starts a new generation only on explicit retry.

OpenAI uses the current Responses API; providers that officially expose Chat Completions use the shared compatibility adapter. Anthropic Messages and Gemini `streamGenerateContent?alt=sse` have native parsers. DashScope's documented stream-plus-tools incompatibility is represented as a capability and uses a non-streaming provider round when tools are advertised. Model capabilities are discovered/probed and displayed; unsupported actions fail as unavailable instead of being guessed.

Retry only occurs for connect failure, 408, 429, or 5xx before any response body or provider tool/result effect is accepted. `Retry-After` is bounded, 401/403 never retries, attempts are capped at three with jitter, and a mid-stream failure is terminal. Dropping/cancelling the provider future is the cancellation mechanism; provider-side cancellation is best effort, while Junban's local generation fence is authoritative.

### Context, memory, daily briefing, and tools

Context assembly is deterministic and records truncation metadata. It uses the active conversation tail, compacted summary, up to fifty explicit memories, custom instructions, focused task, and bounded task/project/timeblock/calendar snapshots from application queries. Secrets, diagnostics, access tokens, hidden task data outside the profile, raw database rows, and previous provider error bodies are excluded. Provider token estimation is conservative and a local 8,000-estimated-token prompt budget is the default.

The model sees a maximum of 64 Rust-owned tool schemas. Read/analysis tools may execute automatically. Every task/project/tag/reminder/memory mutation, bulk operation, and planning/timeblock/schedule apply produces a turn-bound proposal and waits for explicit user approval. Auto-schedule always emits a preview before an approved apply. Approval binds canonical tool name/arguments, session, turn, generation, action hash, expiry, and one-time nonce. The server generates the operation ID only after consuming a valid approval.

Allowed capability groups are task/project/tag/reminder reads and ordinary mutations; extraction, breakdown, duration, duplicate/similarity, workload/pattern/statistics/energy analysis; plan/day/weekly-review; timeblock preview/apply/reschedule; explicit save/recall/forget memory. Existing application limits, exact IDs, civil-time rules, affected-task ceilings, and receipt semantics remain authoritative. The AI layer does not import the Phase 5 CLI catalog because that would create the wrong dependency direction; contract tests prove equivalent actions reach the same `JunbanService` methods and receipts.

Model output, tool arguments, context text, and provider errors are untrusted. Tool names are allowlisted; arguments deserialize with unknown fields rejected; model-supplied operation IDs, URLs, paths, credentials, and approval tokens are ignored/rejected. React renders assistant Markdown without raw HTML, sanitizes link schemes, and renders tool results through trusted structured components.

### Cancellation and committed-effect boundary

Every run and call has an unguessable ID plus monotonically replaced generation. Stop, End Call, session switch/delete, provider disable/change, restore maintenance, client disconnect, or component unmount revokes the generation and approvals. Provider, context, speech, stream, persistence, and UI boundaries check the current generation immediately before accepting an effect.

Tool dispatch has one synchronized linearization point shared with cancellation. A per-run state machine (`running → awaiting_approval → dispatching → terminal`) is protected by one run-state guard. Approval handling holds that guard while it verifies the current generation/action hash/expiry, durably consumes the one-time approval, assigns and records the operation ID, and transitions to `dispatching`. Only then may it release the guard and call `JunbanService`. Cancellation holds the same guard: if it linearizes before `dispatching`, it records `cancelled`, revokes approvals, and dispatch is forbidden; if it observes `dispatching`, it records cancellation requested but cannot retract the already-authorized application operation. Persistence failure before the transition leaves the proposal awaiting approval and no operation ID is usable. Startup treats a durable `dispatching` approval through its exact operation receipt: replay returns the committed result or marks a never-dispatched run failed; it never invents a second operation.

Once a normal `JunbanService` mutation commits, its event/receipt is authoritative and cancellation cannot pretend it did not happen; the terminal event and reloaded state report the committed result. This is the only accepted post-cancel boundary. Deterministic barrier tests force cancellation-before-linearization, cancellation-after-linearization-before-transaction, inside-transaction, and after-commit orderings.

A transcript is applied only if its call generation is current. Audio bytes are played only if both call and response generations remain current. End Call stops recorder/tracks, recognition, VAD, fetch, decoder/source nodes, and queued speech before clearing UI state.

### Voice architecture

Browser-native STT/TTS are the defaults and carry an explicit warning that browser speech recognition may use a browser vendor's cloud service. Push-to-talk uses `MediaRecorder`/SpeechRecognition after a user gesture. VAD uses exact-pinned `@ricky0123/vad-web` with local Web Audio/AudioWorklet and Silero v5 analysis, configurable silence grace, and no automatic microphone start. Browser speech synthesis listens for `voiceschanged` and is best effort when unavailable or suspended.

Server speech adapters are thin Rust HTTP clients: OpenAI/Groq multipart transcription, OpenAI/Groq binary speech where officially supported, and Inworld JSON/streaming TTS with Basic/JWT credentials. Cloud audio is bounded and never logged or persisted by default. The voice-call pipeline is half-duplex HTTP/SSE, not a hidden realtime socket.

Local browser Whisper and Piper/Kokoro support remains lazy and optional. Wave 0 freezes `@huggingface/transformers@3.8.1`, `@ricky0123/vad-web@0.0.30`, `kokoro-js@1.2.1`, and—because Piper was a shipped legacy choice—`@mintplex-labs/piper-tts-web@1.0.4`; no loose direct `onnxruntime-web` pin is added across their incompatible runtime lines. All worklet, ONNX Runtime, phonemizer, WASM, and module assets are served from the Junban origin rather than package CDN defaults. No model is fetched until the user selects Load, sees source/license/size, and confirms an allowlisted revision-and-SHA-256 manifest. Downloaded Whisper, Kokoro, and Piper weights stay in browser Cache API/OPFS and are hash-verified before use; they are not SQLite or complete-backup data. A load failure leaves browser speech usable and cannot widen CSP or silently try a fallback origin.

## Public route shape

Exact DTOs are Rust-owned and OpenAPI-generated. The planned operator-only surface is:

| Group             | Route shape                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Registry/config   | `GET /api/v1/ai/providers`, `GET/PUT/DELETE /api/v1/ai/config`, `GET/PUT/DELETE /api/v1/ai/secrets/{id}`         |
| Models            | `GET /api/v1/ai/providers/{id}/models`, optional loopback LM Studio `POST .../models/{id}/load                   | unload` |
| Sessions/messages | list/create/get/patch/delete sessions; paged messages; retry/edit/regenerate/clear through typed turn operations |
| Runs              | `POST /api/v1/ai/runs` (SSE), `POST /api/v1/ai/runs/{id}/cancel`, approve/reject one proposal                    |
| Memories          | paged list/create/patch/delete                                                                                   |
| Voice             | provider/voice discovery, bounded `POST /api/v1/voice/transcriptions`, `POST /api/v1/voice/speech`               |

No new route is public until it appears in `api_route_table`, central authorization classification, Utoipa/OpenAPI, generated TypeScript, body-limit admission, and an exhaustive operator/automation denial test. AI streams remain excluded from Phase 5's ordinary tool catalog because they are interactive control-plane sessions, not one-shot automation operations.

## Approved interface authority and Phase 6 scenes

Port the archived classes, density, hierarchy, wording, and responsive behavior into current tokens/components rather than redesigning. Framer Motion is not required; current CSS/reduced-motion patterns may render the same layout. Phase 4 Settings fixture isolation remains unchanged.

Before any rewrite UI edit, Wave 0 renders the archived React components from clean detached legacy commit `5e2b2b5adc865f401843c5030285293c5fabccc5` through an ephemeral fixture harness and stores the resulting PNGs plus a manifest under `goals/rust-rewrite/evidence/phase-6-legacy-visual-baseline/`. The manifest freezes legacy commit, harness/source hashes, UTC clock, Noto font packages, light/dark theme, data, viewport, device scale, animation/reduced-motion policy, screenshot clip, PNG SHA-256, and scene-to-component/test authority. The authority scenes are:

1. AI chat not configured panel;
2. full AI chat welcome/daily briefing desktop;
3. populated streamed conversation with tool proposal/result cards;
4. open chat history and session controls;
5. AI chat mobile view and bottom navigation;
6. Settings AI unconfigured and configured-with-secret-present;
7. Settings Voice browser defaults and cloud provider selection;
8. push-to-talk listening/transcribing/error states;
9. VAD grace-period state;
10. voice-call listening/processing/speaking/recognition-error overlay;
11. focused-task chat launch;
12. onboarding AI choice if the current onboarding flow is present in the accepted application shell.

All scenes use local fixtures and masked fake metadata, never real prompts, keys, hostnames, microphones, model downloads, or network providers. Voice/media states are driven through the legacy component props/state machine in the detached fixture harness, not by rewrite-created mocks. If a scene genuinely cannot be rendered, the manifest must name the nearest legacy component and focused legacy behavior test before implementation; a rewrite screenshot can never become its own authority.

`tests/e2e/visual-phase-6.spec.ts` compares the rewrite against these independent legacy PNGs with `maxDiffPixelRatio: 0.01` for every scene. Baselines and manifests are immutable after the first reviewed capture; failures are fixed in narrowly scoped production or explicit fixture behavior and are never accepted by regenerating from the rewrite. Phase 1–4 screenshots remain immutable.

## Browser-local dependency checkpoint

The 2026-08-02 official repository/npm audit is frozen as follows:

| Capability    | Exact package                        | Decision and boundary                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Whisper | `@huggingface/transformers@3.8.1`    | Retain in a worker. It remains the maintained browser Whisper path and satisfies Kokoro's v3 peer range. `4.2.0` is deferred until Kokoro supports v4.                                                                                                                                         |
| VAD           | `@ricky0123/vad-web@0.0.30`          | Retain MicVAD/Silero v5. It is 0.x and single-maintainer, but no simpler maintained browser VAD preserves the legacy behavior.                                                                                                                                                                 |
| Kokoro        | `kokoro-js@1.2.1`                    | Retain exact. Apache-2.0 package/weights; q8 model is roughly 92 MiB and loads only after explicit consent.                                                                                                                                                                                    |
| Piper         | `@mintplex-labs/piper-tts-web@1.0.4` | Retain exact solely because Piper voices are shipped legacy capability. Its stale fork and archived upstream are accepted as a scoped risk; do not call its hard-coded `download()` path. A committed narrow wrapper or pnpm patch routes every model/support fetch through Junban's verifier. |
| ONNX Runtime  | transitive resolved versions only    | Do not add a loose app-wide pin. Copy only the required `.wasm`/`.mjs` variants for each isolated worker and prohibit training/Node runtime artifacts.                                                                                                                                         |

Package licenses are Apache-2.0, ISC, or MIT; model-card and voice licenses are retained beside manifests. Before Wave 4 depends on them, a focused spike proves a manifest-mediated wrapper or committed minimal patch for Whisper, Kokoro, and Piper. The checked manifest records every exact file URL, immutable upstream revision, expected byte size, SHA-256, license, cache key, and engine version. A fixture server proves wrong host/revision/size/hash rejection and cache re-verification; a built-asset scan rejects Piper's `resolve/main`, jsDelivr/CDNJS defaults, mutable model URLs, and cross-origin worker fallbacks.

Release checks prove these imports are dynamic, ordinary first paint fetches none of their chunks/assets, default startup makes no model-origin connection, and Node-only `onnxruntime-node`/`sharp` code is absent from shipped runtime chunks. Model downloads use only the checked manifest with explicit user consent; no mutable `latest`, cross-origin worker, blob fallback, or provider secret is permitted. Closure evidence performs at least one real hash-verified load and inference for Whisper, Kokoro, and Piper on a supported browser, recording source revision, model hash/size, nonempty transcript/audio, cleanup, and no default-load regression; discovery or mocks alone cannot accept local voice.

Primary current references retained for implementation verification:

- OpenAI: <https://developers.openai.com/api/docs/guides/streaming-responses>, <https://developers.openai.com/api/docs/guides/speech-to-text>, <https://developers.openai.com/api/docs/guides/text-to-speech>
- Anthropic: <https://platform.claude.com/docs/en/build-with-claude/working-with-messages>, <https://platform.claude.com/docs/en/build-with-claude/streaming>, <https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview>
- Gemini: <https://ai.google.dev/api/generate-content>, <https://ai.google.dev/api/models>, <https://ai.google.dev/gemini-api/docs/api-key>
- OpenAI-compatible presets: <https://openrouter.ai/docs/api_reference/overview>, <https://api-docs.deepseek.com/>, <https://docs.mistral.ai/api/endpoint/chat>, <https://platform.kimi.ai/docs/api/overview>, <https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope>, <https://console.groq.com/docs/openai>, <https://docs.z.ai/guides/overview/quick-start>, <https://docs.ollama.com/api/openai-compatibility>, <https://lmstudio.ai/docs/developer/openai-compat>
- Speech: <https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech>, <https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API>, <https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API>
- Local browser stack: <https://huggingface.co/docs/transformers.js/v3.8.1/en/index>, <https://docs.vad.ricky0123.com/user-guide/browser/>, <https://github.com/hexgrad/kokoro>, <https://github.com/Mintplex-Labs/piper-tts-web>, <https://onnxruntime.ai/docs/tutorials/web/deploy.html>

## Implementation phase graph

### Wave 0 — frozen plan, dependency/contract spike, and authorities

- Complete official provider and local-browser dependency research with retained URLs and dates. **Done:** four provider wire families and the exact lazy browser pins/asset boundaries above are frozen.
- Freeze provider presets, secret/egress/tool-approval/cancellation policy, schema bounds, HTTP/SSE DTO shapes, review gates, and benchmark protocol. **Done and planning-approved after `P6-PLAN-001`–`P6-PLAN-005` were fixed.**
- Prove a lazy `reqwest` adapter plus fragmented SSE parser against a local mock without changing ordinary server startup.
- Prove the manifest-mediated/patch path for each local engine, reject all package CDN/mutable paths in built assets, and retain exact manifest/license/hash evidence before the UI wave depends on those packages.
- Capture the legacy reference scenes under the pinned authority protocol below before any rewrite UI edit.
- Pass one high-risk planning review covering authority, secrets, provider egress, persistence, cancellation, UI preservation, and measurable completion.

### Wave 1 — typed domain, schema v6, persistence, and secrets

- Add strict IDs/entities/settings and v5→v6 migration.
- Add bounded repository/application operations and the frozen mutation/event/receipt/no-undo matrix above, plus complete-backup validation and startup reconciliation.
- Add the private versioned secret store and operator-only presence/update/delete API.
- Run focused migration, database-integrity, backup/restore, secret-durability, permission, and redaction tests.
- Pass the scoped database/security boundary gate before provider work depends on it.

### Wave 2 — provider core, adapters, and model discovery

- Add lazy `junban-ai`, normalized stream/tool/error/speech contracts, context bounds, retry/cancel, and mock providers.
- Implement OpenAI Responses, OpenAI-compatible presets, Anthropic, Gemini, model discovery, and explicit unavailable capabilities.
- Add fixed/custom URL validation, no redirects/proxy, sensitive headers, bounded parsers/errors, and provider fixture tests.
- Prove disabled startup allocates no provider resources and creates no outbound requests.

### Wave 3 — chat orchestration, tools, and authenticated API

- Compose lazy runtime in normal owner only; integrate maintenance drain.
- Add session/memory/config/model/run/approval routes, OpenAPI/types, and chat SSE.
- Add bounded context/compaction/daily briefing and AI tool registry over `JunbanService`.
- Add approval, operation-ID, disconnect, retry, session-switch/delete, restore, and pre-dispatch/post-commit race tests.
- Pass the scoped security/API contract gate on the integrated backend.

### Wave 4 — preserved React AI and voice

- Port the approved AI view/panel, messages/cards/history/input, Settings AI/Voice, navigation, focused-task launch, and onboarding hook without changing unrelated UI.
- Add lazy browser speech/media/VAD and approved lazy local models; add Rust cloud STT/TTS and call-generation fencing.
- Add Vitest, Playwright functional, immutable visual, mobile, permission/error, Stop/End Call, and axe coverage.
- Pass the frontend/accessibility design-preservation gate.

### Wave 5 — evidence, dogfood, exact-head review, and closure

- Freeze and run matched disabled parent/head release evidence plus enabled local-mock chat/tool/STT/TTS evidence.
- Rerun schema-v6 Phase 5 cross-surface conformance and existing hosted memory/supply-chain/runtime boundaries.
- Dogfood provider configure/disable, chat/history/memory, approval/reject, cancellation, focused context, auto-schedule preview/apply, PTT/VAD/TTS/call end, backup/restore/restart, and CLI/MCP non-regression. Local voice acceptance includes real hash-verified Whisper transcription plus Kokoro and Piper synthesis/cleanup, not discovery alone.
- Close every material ledger finding with focused regression; update docs, live plan, generated contracts, protocol/results, dogfood, and outcome.
- Squash the complete phase to one clean commit.

## Validation and frozen performance protocol

Nearest checks run after each wave. Final broad checks include Rust format/Clippy/workspace tests/release builds; cargo audit/deny; frontend format/lint/typecheck/unit/build; OpenAPI generation/check; runtime-boundary/privacy/docs checks; Playwright functional/axe/Phase 6 visual plus immutable earlier visuals; diff check; no secret material.

### Disabled matched release evidence

Build optimized parent-base and exact-head `junban-server` binaries. Run five interleaved fresh-profile samples of the exact Phase 1 health/UI/idle workload in isolated cgroup-v2 units on one idle host. Record commits, hashes, sizes, toolchain, host, cgroup current/peak, RSS/PSS/process tree, startup, profile size, and Node-process rejection.

Acceptance requires:

- exact-head maximum warm ≤24 MiB and peak ≤32 MiB;
- exact-head median warm growth versus parent ≤ the larger of 15% or 1 MiB;
- zero provider/local-model outbound connections and zero constructed AI HTTP clients, model caches, media devices, audio contexts, workers, or background tasks;
- ordinary release UI initial-load requests do not fetch AI/voice/local-model chunks until an AI surface is opened.

### Enabled local-mock evidence

Run the exact-head release server against a separate deterministic loopback provider/speech fixture, excluded from the server cgroup. Use three fresh profiles and, per profile: model discovery; 30 streamed turns with fragmented UTF-8/SSE; one read tool; one rejected mutation; one approved mutation; one retry-before-body; one timeout; one midstream failure; one cancel race; 1 MiB STT; 1 MiB TTS; idle/drain/cleanup.

Freeze these budgets before measurement:

| Metric                                       |           Budget |
| -------------------------------------------- | ---------------: |
| Mock first stream event p95                  |           250 ms |
| Mock completed short turn p95                |           750 ms |
| Cancellation to terminal/quiesced p95        |           500 ms |
| Mock 1 MiB STT / TTS p95                     | 1,000 / 1,000 ms |
| Enabled post-session warm / operation peak   |      32 / 48 MiB |
| Post-drain warm growth over pre-session      |           ≤4 MiB |
| Active Rust server processes / resident Node |    exactly 1 / 0 |

Any stale transcript/token/tool/audio effect, duplicate mutation/event, secret leak, unbounded frame/body, uncleared worker/listener/temp artifact, or failed lock/maintenance cleanup blocks acceptance regardless of latency.

## Recovery and rollback

- Every wave remains squashable to `351c842`; rejected adapters/packages are deleted rather than retained behind dormant flags.
- v6 migration follows the existing pre-migration backup and rollback protocol. Existing v5 profiles remain valid inputs; no downgrade writer is added.
- Secret replacement preserves the prior file and in-memory authority on failure. Orphan secret material is unreachable and reconciled/deleted on startup; SQLite never points at an unpublished secret version.
- Provider/config disable cancels and drains before confirmation. Restore cancels all runs/calls and expires approvals before cutover. Candidate validation clears credential bindings; failed restore leaves the secret artifact untouched, successful restore makes old entries unreachable, and post-cutover reconciliation removes them. Database rollback never claims to roll back or restore secret bytes.
- Browser call cleanup always stops media tracks, worker messages, speech queues, and audio nodes. A failed local model load leaves browser defaults usable.
- Reverting the final phase is one commit, but a migrated v6 profile requires the existing complete backup/recovery path rather than an unsupported schema downgrade.

## Review checkpoints

1. **Planning gate:** one high-risk planning reviewer approves this context map before implementation.
2. **Persistence/security gate:** after Wave 1, one database-dominant review covers schema, invariants, backup/restore, secret publication/reconciliation, and failure injection; a distinct security review is used only for verified secret/permission findings that the database gate cannot own.
3. **Backend security/API gate:** after Wave 3, one security-dominant review covers egress, auth, redaction, prompt/tool trust, approval, retry, cancel, and maintenance; resume the same reviewer after material fixes. Public contract findings are included when inseparable, otherwise one API-contract gate replaces—not stacks with—the general review.
4. **Frontend gate:** after Wave 4, one frontend/accessibility review covers exact legacy preservation, lazy loading, focus/live regions, media permission/privacy, mobile, and immutable screenshots.
5. **Exact-head closure:** review only the integrated exact head needed by the dominant unresolved risk; do not stack redundant general reviewers. Performance and docs protocols fail closed through executable checks and retained evidence.

## Risk assessment

- [x] Schema v6, row-value validation, backup/restore, deletion and startup reconciliation
- [x] Raw provider/speech secrets and cross-platform private persistence
- [x] Custom network authority, TLS, redirects, proxy and error-body leakage
- [x] Untrusted model/prompt/tool output and model-driven product mutations
- [x] Streaming, retry, timeout, disconnect, cancellation and post-commit races
- [x] Visible React design, accessibility, microphone/privacy and audio lifecycle
- [x] Optional dependency, initial bundle, server idle memory and enabled peak cost
- [x] Additive HTTP/OpenAPI/SSE contracts and Phase 5 CLI/MCP regression
- [x] Provider drift and local browser dependency maintenance/supply chain
- [ ] Plugin host/runtime (Phase 7)
- [ ] Desktop-native lifecycle (Phase 8)

## Decisions and rejected alternatives

- **Chosen:** one planned `junban-ai` crate plus existing app/storage/server boundaries. **Rejected:** provider code in the server, a provider SDK per vendor, or a second database owner.
- **Chosen:** four current wire families and provider presets/capabilities. **Rejected:** twelve copied bespoke adapters and hard-coded full model catalogs.
- **Chosen:** owner-private raw secret artifact with write-only API and presence-only reads, excluded from complete backups; restore clears bindings. **Rejected:** plaintext typed settings/browser storage, exposing secrets to `data`-scoped backup callers, reversible encryption whose key sits beside ciphertext, and headless-incompatible mandatory OS keyrings.
- **Chosen:** OpenAI Responses for OpenAI, native Anthropic/Gemini, OpenAI Chat compatibility elsewhere. **Rejected:** legacy Completions, guessed vendor extensions, and one parser pretending every compatible service is identical.
- **Chosen:** API keys/official bearer credentials only. **Rejected:** legacy manual-token UI mislabeled as OAuth and unsupported consumer subscription login reuse.
- **Chosen:** explicit approval for every model-proposed mutation and schedule apply. **Rejected:** trusting prompt wording or model confidence as authorization.
- **Chosen:** fetch-response SSE and half-duplex HTTP voice. **Rejected:** EventSource without authenticated POST, WebSocket/realtime complexity without a demonstrated need, and stream replay after reconnect.
- **Chosen:** browser speech defaults plus exact-pinned lazy Whisper, Silero VAD, Kokoro, and Piper workers with same-origin runtime assets and consented hash-pinned model downloads. **Rejected:** eager ONNX/model bundles, mutable/CDN worker defaults, server-side executable engines, dropping a shipped local voice solely because its wrapper is stale, and cloud keys in browser storage.
- **Chosen:** bounded context plus deterministic truncation. **Rejected:** dumping the entire profile or diagnostics into prompts.
- **Chosen:** global events only for durable committed changes. **Rejected:** publishing token deltas into the retained revision stream.
- **Chosen:** 32 MiB/session and 128 MiB/profile aggregate AI quotas, bounded deletion, small resync events/receipts, and no generic AI chat/memory undo. **Rejected:** per-row-only limits that can break the 512 MiB backup envelope or receipts containing deleted conversations.
- **Chosen:** one guarded approval-to-`dispatching` linearization point shared with cancellation, with the operation ID durably assigned there. **Rejected:** a generation check followed by an unguarded application dispatch.
- **Chosen:** legacy-rendered authorities from pinned commit `5e2b2b5a` with a 1% blocking threshold. **Rejected:** rewrite-generated self-authorizing baselines.

## Planning-review ledger

| ID            | Status             | Resolution                                                                                                                                                                                                                   |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-PLAN-001` | fixed and approved | Complete backup explicitly excludes AI/speech secrets; candidate restore clears bindings and disables cloud use, failed restore leaves secrets untouched, and successful restore makes old bytes unreachable before cleanup. |
| `P6-PLAN-002` | fixed and approved | Approval consumption, operation-ID assignment, and transition to `dispatching` share one durable guarded linearization point with cancellation; all orderings have deterministic barrier tests.                              |
| `P6-PLAN-003` | fixed and approved | Aggregate session/profile/memory/approval quotas, bounded deletion, byte counters, and an explicit event/receipt/idempotency/no-undo matrix are frozen.                                                                      |
| `P6-PLAN-004` | fixed and approved | Local engines require manifest-mediated wrappers/patches, immutable URL/size/hash/license records, built-asset CDN rejection, cache verification, and real Whisper/Kokoro/Piper inference evidence.                          |
| `P6-PLAN-005` | fixed and approved | Independent legacy-rendered authorities are pinned to clean archived commit `5e2b2b5a`, fully manifested, and compared at `maxDiffPixelRatio: 0.01`; rewrite baselines cannot replace them.                                  |

The focused recheck found no remaining blocker and approved implementation against this frozen plan.
