# Phase 6 Wave 2 / 3e — Provider Adapters Evidence

- **Date:** 2026-08-03 (Wave 2); Wave 3e incremental sink delta on the same evidence file
- **Scope:** `crates/junban-ai` provider registry, four wire adapters, model discovery, retry/cancel/redaction, provider-neutral speech data contracts, and Wave 3e incremental normalized event delivery
- **Claim boundary:** provider-runtime unit/fixture coverage and speech data-contract coverage only. This evidence file does not claim end-to-end server, settings, secrets store, orchestration, React, voice acceptance, cloud STT/TTS HTTP adapters, voice routes, or local voice inference. Its Wave 3e section claims only the `junban-ai` incremental callback contract; server POST-SSE composition is evidenced separately in `phase-6-wave-3.md`.
- **Authority note:** chat preset identity and official base URLs are owned by `junban_domain::AiProviderPreset`. Speech preset identity is owned by `junban_domain::SpeechProviderPreset`. `junban-ai` depends narrowly on `junban-domain` and re-exports both; the duplicate runtime chat-provider enum is deleted.

## Official sources consulted

Verified against current official documentation (retrieved 2026-08-03; base-URL authority reconfirmed on reconciliation):

| Family / preset                              | Source                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenAI Responses streaming                   | https://developers.openai.com/api/docs/guides/streaming-responses                        |
| OpenAI Responses event types                 | https://developers.openai.com/api/reference/resources/responses/streaming-events/        |
| Anthropic Messages streaming                 | https://platform.claude.com/docs/en/build-with-claude/streaming                          |
| Anthropic Messages + tools                   | https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview                   |
| Gemini generateContent / stream              | https://ai.google.dev/api/generate-content                                               |
| Gemini models list                           | https://ai.google.dev/api/models                                                         |
| Gemini API key header                        | https://ai.google.dev/gemini-api/docs/api-key                                            |
| Gemini REST base (`v1beta`)                  | https://generativelanguage.googleapis.com/v1beta                                         |
| DeepSeek OpenAI-compatible API               | https://api-docs.deepseek.com/                                                           |
| OpenRouter OpenAI-compatible                 | https://openrouter.ai/docs/api_reference/overview                                        |
| Groq OpenAI compatibility                    | https://console.groq.com/docs/openai                                                     |
| Mistral chat API                             | https://docs.mistral.ai/api/endpoint/chat                                                |
| Kimi / Moonshot API overview                 | https://platform.kimi.ai/docs/api/overview                                               |
| DashScope OpenAI compatibility               | https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope |
| DashScope international compatible-mode base | https://dashscope-intl.aliyuncs.com/compatible-mode/v1                                   |
| Z.AI quick start                             | https://docs.z.ai/guides/overview/quick-start                                            |
| Ollama OpenAI compatibility                  | https://docs.ollama.com/api/openai-compatibility                                         |
| LM Studio OpenAI compatibility               | https://lmstudio.ai/docs/developer/openai-compat                                         |

## Frozen built-in presets

Canonical persisted/wire IDs are domain snake_case (`lm_studio`, `z_ai`). Parsing may accept safe aliases (`lmstudio`, `lm-studio`, `zai`, `glm`, `moonshot`); serialization and descriptor IDs always emit the canonical value. xAI is not a built-in preset.

| ID           | Wire family             | Auth                                          | Default base URL                                         | Notes                                                                                                                                                                                    |
| ------------ | ----------------------- | --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`     | OpenAI Responses        | Bearer                                        | `https://api.openai.com/v1`                              | `POST /responses`, `GET /models`                                                                                                                                                         |
| `anthropic`  | Anthropic Messages      | `x-api-key` + `anthropic-version: 2023-06-01` | `https://api.anthropic.com`                              | `POST /v1/messages`, `GET /v1/models`                                                                                                                                                    |
| `openrouter` | OpenAI Chat Completions | Bearer                                        | `https://openrouter.ai/api/v1`                           |                                                                                                                                                                                          |
| `ollama`     | OpenAI Chat Completions | None (optional bearer)                        | `http://127.0.0.1:11434/v1`                              | loopback only                                                                                                                                                                            |
| `lm_studio`  | OpenAI Chat Completions | None (optional bearer)                        | `http://127.0.0.1:1234/v1`                               | loopback only; aliases: `lmstudio`, `lm-studio`                                                                                                                                          |
| `deepseek`   | OpenAI Chat Completions | Bearer                                        | `https://api.deepseek.com`                               | `POST /chat/completions`, `GET /models`                                                                                                                                                  |
| `gemini`     | Gemini generateContent  | `x-goog-api-key` header                       | `https://generativelanguage.googleapis.com/v1beta`       | official v1beta REST base; stream via `...:streamGenerateContent?alt=sse` (fixed non-credential query)                                                                                   |
| `mistral`    | OpenAI Chat Completions | Bearer                                        | `https://api.mistral.ai/v1`                              |                                                                                                                                                                                          |
| `kimi`       | OpenAI Chat Completions | Bearer                                        | `https://api.moonshot.ai/v1`                             | aliases: `moonshot`                                                                                                                                                                      |
| `dashscope`  | OpenAI Chat Completions | Bearer                                        | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | built-in international compatible-mode origin remains functional; workspace-specific regional domains use explicit `custom`; **No `StreamingTools`** — tools force non-stream JSON round |
| `groq`       | OpenAI Chat Completions | Bearer                                        | `https://api.groq.com/openai/v1`                         |                                                                                                                                                                                          |
| `z_ai`       | OpenAI Chat Completions | Bearer                                        | `https://api.z.ai/api/paas/v4`                           | aliases: `zai`, `glm`                                                                                                                                                                    |
| `custom`     | OpenAI Chat Completions | Bearer                                        | operator-required                                        | HTTPS or loopback HTTP; no userinfo/fragment/query                                                                                                                                       |

## Wire behavior summary

1. **OpenAI Responses** — SSE semantic events; text from `response.output_text.delta`; reasoning deltas become `reasoning_status` only; function calls from output item / arguments events; `response.completed` terminal.
2. **OpenAI Chat Completions** — SSE chunks + `[DONE]`; `delta.content` text; `delta.tool_calls` accumulated; `reasoning_content` → status only.
3. **Anthropic Messages** — named SSE events; `text_delta` text; `thinking_delta` → status only; `tool_use` + `input_json_delta` → `tool_proposed` on `content_block_stop`; `message_stop` terminal.
4. **Gemini** — `streamGenerateContent?alt=sse`; candidate part text; `thought: true` → status only; `functionCall` → `tool_proposed`; EOF completes when no explicit terminal.

## Provider-neutral speech contracts

Wave 2 freezes the data shapes Wave 4 cloud STT/TTS adapters will consume. No async speech trait, HTTP speech client, server route, browser media path, or local inference is implemented in this wave.

| Item               | Frozen contract                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider identity  | `junban_domain::SpeechProviderPreset` (`browser`, `openai`, `groq`, `inworld`) — no duplicate enum                                                                   |
| Ownership          | Browser → frontend-only; OpenAI/Groq/Inworld → future Rust network adapters                                                                                          |
| Capabilities       | OpenAI/Groq STT+TTS; Inworld TTS-only; Browser STT+TTS (frontend). Unsupported work returns `ProviderError::Unavailable`                                             |
| Audio bound        | 25 MiB request/response, enforced at `SpeechAudio` construction                                                                                                      |
| Transcription text | nonempty, ≤ frozen user-input bound (`AI_USER_INPUT_BYTES_MAX` / 32 KiB)                                                                                             |
| Synthesis input    | nonempty, ≤ frozen assistant-text bound (`AI_ASSISTANT_TEXT_BYTES_MAX` / 512 KiB)                                                                                    |
| Format / tokens    | allowlisted audio content types; optional model/voice tokens under existing model-id bounds; no headers, URLs, credentials, paths, or query material in the contract |
| Redaction          | `SpeechAudio`, `TranscriptionText`, and `SynthesisText` Debug never dump payload bytes/content                                                                       |
| Errors             | reuse `ProviderError` `Invalid` / `BoundExceeded` / `Unavailable` mapping                                                                                            |

Focused regressions live in `crates/junban-ai/src/speech.rs` tests (bounds, format/token rejection, capability matrix, rust-adapter ownership, redacted Debug).

## Wave 3e — incremental normalized event delivery

Provider-core half only (`crates/junban-ai`). A server POST-SSE orchestrator can forward deltas before the provider response ends by consuming the async sink APIs; this evidence does not claim that server composition.

| Item             | Frozen contract                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime API      | `ProviderRuntime::chat_stream(endpoint, request, run, on_event)` delivers each `NormalizedStreamEvent` to an async `FnMut(event) -> Future<Result<(), ProviderError>>` sink                                               |
| Transport API    | `stream_provider_sse` / `stream_provider_json` are the incremental primitives; `consume_provider_sse` / `consume_provider_json` / `chat()` collect through them and remain source-compatible                              |
| Delivery timing  | SSE: each event is delivered as soon as its frame normalizes, before further body bytes are read. Non-stream JSON: bounded body completes, then events emit in order                                                      |
| Backpressure     | Sink is awaited; no unbounded event queue in this crate. A slow sink stalls further `response.chunk()` reads                                                                                                              |
| Fence            | `RunCancel::check_live` runs before and after every sink callback; cancellation/revocation forbids all later callbacks                                                                                                    |
| Retry            | Retry only before any sink event is accepted. After the first effect (including status/tool/usage), transport or sink failure is terminal — no second vendor request. Existing no-retry-after-body / 401/403 rules remain |
| Sink failure     | Close/backpressure maps to stable `Cancelled` or `stream_failed` without body/secret material; Connect/Stream sink errors collapse to `stream_failed`                                                                     |
| Gemini terminal  | Synthesized `Completed` at EOF only when no explicit terminal was delivered; exactly once; same order as collect APIs                                                                                                     |
| Bounds / secrecy | Existing SSE frame/line/event/response and non-stream JSON caps; active-secret success/error reflection protections; no callback Debug/logging of payloads                                                                |
| Families         | All four wire families (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini generateContent)                                                                                                            |

Focused regressions in `crates/junban-ai/tests/provider_runtime.rs`:

- `incremental_first_delta_before_terminal` — first text delta observed before mock writes terminal/EOF
- `incremental_fragmented_sse_all_four_families` — fragmented UTF-8/event order via sink
- `incremental_slow_sink_backpressure` — second text-delta callback waits; no hidden queue
- `incremental_cancel_while_sink_blocked` — cancel during blocked sink yields `Cancelled`, no late event
- `incremental_sink_failure_after_effect_no_retry` — one request after first effect
- `incremental_pre_body_retry_still_works` — pre-body 503 retry path unchanged
- `chat_collected_equals_chat_stream_collection` — `chat()` exact-equals streamed collection; consume equals stream collect
- `incremental_gemini_eof_terminal_once` — Gemini EOF terminal synthesized once

## Safety posture

- Redirects disabled; ambient proxy disabled; connect 10s / total 60s / idle pool 30s.
- Max three attempts; retry only pre-body connect/408/429/5xx with capped Retry-After + deterministic jitter.
- Never retry 401/403, after body acceptance, tool/result effect, sink effect delivery, or mid-stream failure.
- Base URLs reject userinfo, fragments, query strings, non-loopback HTTP, and cloud origin overrides.
- Domain `ProviderBaseUrl::for_provider` and runtime `ProviderEndpoint::resolve` accept/reject the same exact preset official origin for every built-in non-custom preset.
- Credentials use `SecretString` (redacted Debug, no Serialize) and sensitive header values.
- Public `ProviderError` / `AiError` never embeds arbitrary vendor bodies. HTTP failures expose status, optional short vendor code, and retry timing only.
- Error-body inspection is cancellation-aware and hard-capped at 64 KiB (`read_error_body_bounded`); the connection is dropped at the cap.
- Active request credentials are scrubbed from any retained diagnostic message fields before error construction/return.
- Generation fence checked at frame, sink-delivery, and effect boundaries; cancel yields `Cancelled` without applying late effects or late sink callbacks.
- Speech contracts carry no credentials/URLs/headers and never log audio bytes or raw transcript/synthesis text via Debug.
- Incremental sinks never Debug/log event payloads; sink close maps to stable cancelled/stream failure without body/secret material.

## Wave 0 security findings closed in this wave

| ID              | Fix                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P6-W0-SEC-001` | Replaced `Response::bytes()` error-body reads with cancel-aware incremental reads capped at 64 KiB; drop immediately at the cap. Regression: `p6_w0_sec_001_error_body_read_is_bounded_and_cancel_aware`.                                  |
| `P6-W0-SEC-002` | Public HTTP errors no longer carry vendor body text; only status/optional short code/retry-after. Active credential scrubbing on retained diagnostics. Regression: `p6_w0_sec_002_active_credential_reflection_never_enters_public_error`. |

## Validation performed (Wave 2 + preset-authority reconciliation + speech contracts + Wave 3e incremental sink)

```bash
cargo fmt --all -- --check
cargo clippy --locked -p junban-domain --all-targets --all-features -- -D warnings
cargo clippy --locked -p junban-ai --all-targets --all-features -- -D warnings
cargo test --locked -p junban-domain
cargo test --locked -p junban-ai --all-features
cargo deny check
cargo audit
pnpm exec prettier --check goals/rust-rewrite/evidence/phase-6-provider-adapters.md
git diff --check
```

Cross-layer contract tests in `crates/junban-ai/tests/provider_authority.rs` prove every `AiProviderPreset::ALL` entry has exactly one descriptor, canonical descriptor ID equals `as_str`, descriptor default URL equals `official_base_url` (except Custom), no extra registry entry exists, and DeepSeek is present while xAI is absent.

Wave 3e validation additionally runs the incremental sink regressions listed above (deterministic loopback/barriers only; no live egress).

## Limitations / non-claims

- No live provider network tests in CI.
- No hard-coded complete vendor model catalogs; discovery maps provider-reported IDs and inherits provider-level capabilities without guessing per-model tool/vision support.
- No OAuth / subscription-login emulation.
- No server route composition, secret store, tool orchestration, or React work in this wave.
- This provider-adapter evidence section does not claim server POST-SSE orchestration or authenticated routes; those Wave 3e claims and regressions are recorded in `phase-6-wave-3.md`.
- No cloud STT/TTS HTTP adapters, voice routes, browser speech/media/VAD runtime, or local voice model inference in this wave — only provider-neutral speech data contracts and capability metadata.
- xAI is not a built-in chat preset; operators may use `custom` for non-inventory OpenAI-compatible origins.
- Browser speech remains frontend-owned; declaring it on the speech capability matrix does not imply a Rust network adapter.
