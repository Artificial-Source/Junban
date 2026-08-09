# Phase 6 Wave 4c — Bounded Cloud Speech Runtime Evidence

- **Date:** 2026-08-03
- **Scope:** lazy Rust cloud STT/TTS adapters, independent speech lifecycle admission/drain authority, authenticated operator-only voice routes, exact CSP/OpenAPI/generated-contract updates, and focused deterministic regressions
- **Claim boundary:** OpenAI, Groq, and Inworld cloud speech only. Browser and local model execution remain frontend-owned. Tests use loopback fixtures and do not contact live providers.

## Official authorities consulted

| Provider      | Authority used                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI speech | <https://platform.openai.com/docs/guides/speech-to-text>, <https://platform.openai.com/docs/guides/text-to-speech>, <https://platform.openai.com/docs/api-reference/audio/createSpeech> |
| Groq speech   | <https://console.groq.com/docs/speech-to-text>, <https://console.groq.com/docs/text-to-speech>                                                                                          |
| Inworld TTS   | <https://docs.inworld.ai/docs/tts/tts>, <https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech>                                                                   |

## Fixed provider authority

| Provider    | Fixed endpoint                                        | Auth                                                            | Request / response                                                   |
| ----------- | ----------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| OpenAI STT  | `https://api.openai.com/v1/audio/transcriptions`      | Bearer API key                                                  | one multipart request (`model`, one `file`); bounded JSON transcript |
| OpenAI TTS  | `https://api.openai.com/v1/audio/speech`              | Bearer API key                                                  | JSON; MP3 or WAV binary response                                     |
| Groq STT    | `https://api.groq.com/openai/v1/audio/transcriptions` | Bearer API key                                                  | one multipart request (`model`, one `file`); bounded JSON transcript |
| Groq TTS    | `https://api.groq.com/openai/v1/audio/speech`         | Bearer API key                                                  | JSON; WAV binary response                                            |
| Inworld TTS | `https://api.inworld.ai/tts/v1/voice`                 | HTTP Basic (portal/CLI-provided Base64 signature) or JWT Bearer | JSON; bounded base64 WAV in `audioContent`                           |

Callers cannot supply or override an endpoint. Redirect following and ambient proxies are disabled by the shared lazy provider HTTP client. Validation of provider, operation support, model, voice, format, Unicode scalar limit, audio size, and credential form completes before client construction and egress. OpenAI TTS admits at most 4096 Unicode scalar values; Groq TTS at most 200; Inworld TTS at most 2000. Groq TTS is WAV-only. STT formats are provider-restricted and provider input ceilings are checked before egress.

Credential bytes remain in private in-memory wrappers, use sensitive authorization headers, implement redacted `Debug`, and have no serialization implementation. Provider error bodies, decoded provider payloads, transcript input/output, synthesis input, and audio bytes do not enter logs, public errors, SQLite, events, receipts, diagnostics, OpenAPI examples, or generated source.

## Bounds and memory posture

- Public STT accepts exactly one multipart `audio` part, no unknown fields or part headers, and at most 25 MiB of audio plus 16 KiB of framing.
- Public TTS accepts strict JSON through the existing 32 KiB request-body ceiling and rejects unknown fields.
- Provider JSON bodies are capped at 22 MiB, raw audio at 25 MiB, transcript text at 32 KiB, and decoded Inworld audio at 16 MiB.
- Content length is rejected before allocation when present; fragmented/chunked bodies are accumulated only to the applicable hard cap.
- Multipart request bodies stream a small prefix, the shared immutable audio bytes, and suffix with a fixed content length; the 25 MiB audio payload is not duplicated to construct provider multipart bodies.
- The HTTP client and TLS pool remain unconstructed until an admitted, fully validated configured operation is ready for egress.

## Independent lifecycle authority

`SpeechActivitySupervisor` (`crates/junban-server/src/speech_runtime.rs`) is separate from `AiRuntimeSupervisor`. A speech guard owns one provider future and its cancellation fence. The route publishes a result only after the guard authorizes the exact generation; dropping the route/provider future cancels the guard and suppresses late publication.

AI/voice configuration and credential mutations, restore cutover, recovery entry, and graceful shutdown close both admissions under one server transition lock, cancel active AI and speech work, wait for both drain conditions, and reopen only after a completed non-permanent transition. A timeout or partial drain is fail-closed. Speech admission cannot reopen between the AI and speech transition steps.

Focused supervisor tests cover cancellation, stale-generation result suppression, timeout fail-closed behavior, permanent shutdown, and a barrier-controlled concurrent admission/reconfiguration race.

## Public operator contract

- `POST /api/v1/voice/transcriptions` — strict multipart request; `200` strict JSON transcript.
- `POST /api/v1/voice/speech` — strict JSON request; `200` canonical binary `audio/mpeg` or `audio/wav`.
- Authentication/host/authorization middleware runs before body extraction and parsing.
- Routes resolve only confirmed enabled settings and private credential bindings, and serialize admission with reconfiguration.
- Stable errors contain only Junban error codes/messages. Provider bodies and credentials are never reflected.
- Voice operations are present in OpenAPI and `src/ui/api/generated.ts`, with multipart request and binary-response schemas, but are intentionally absent from the frozen 87-operation CLI/MCP catalog.

## CSP

The exact policy remains:

```text
default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'
```

No cloud provider API origin is granted browser CSP authority.

## Deterministic regression coverage

`crates/junban-ai/src/speech_http/` tests cover:

- zero-egress lazy startup and validation-before-client-construction;
- credential/provider matrix validation and redacted debug/error behavior;
- one-request streamed multipart STT with fragmented loopback response;
- fragmented raw and base64 TTS, including 1 MiB raw/base64 fixtures;
- provider Unicode limits, provider format/input ceilings, malformed JSON/base64/content type, decoded oversize, redirects, cancellation, and timeout;
- exact official origin constants and disabled ambient proxy/redirect client policy inherited from `ProviderHttpFactory`.

`crates/junban-server/src/routes_voice/` and `crates/junban-server/src/tests_api/tests_voice_api.rs` cover strict multipart parsing, auth-before-parse, disabled/missing configuration, validation before credential lookup/client construction, canonical audio response, exact CSP, synchronized OpenAPI/generated paths and binary schema, and exclusion from the 87-operation automation catalog.

## Validation

The committed implementation is validated with:

```bash
cargo fmt --all -- --check
cargo clippy --locked -p junban-ai --all-targets --all-features -- -D warnings
cargo clippy --locked -p junban-server --all-targets --all-features -- -D warnings
cargo clippy --locked -p junban-cli --all-targets --all-features -- -D warnings
cargo test --locked -p junban-ai --all-features
cargo test --locked -p junban-server
cargo test --locked -p junban-cli
cargo test --locked -p junban-mcp
pnpm contract:check
pnpm exec prettier --check goals/rust-rewrite/evidence/phase-6-wave-4c.md openapi/junban-v1.json src/ui/api/generated.ts
cargo deny check
cargo audit
git diff --check
```

No live-provider or browser egress is part of validation. Optimized hosted idle-memory evidence is not rerun for this bounded adapter delta: startup constructs neither the speech HTTP client nor TLS state, and no cloud speech task exists while idle.
