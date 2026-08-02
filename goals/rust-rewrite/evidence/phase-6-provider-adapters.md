# Phase 6 Wave 2 — Provider Adapters Evidence

- **Date:** 2026-08-03
- **Scope:** `crates/junban-ai` provider registry, four wire adapters, model discovery, retry/cancel/redaction
- **Claim boundary:** provider-runtime unit/fixture coverage only. No end-to-end server, settings, secrets store, orchestration, React, or voice acceptance is claimed.

## Official sources consulted

Verified against current official documentation (retrieved 2026-08-03):

| Family / preset | Source |
| --- | --- |
| OpenAI Responses streaming | https://developers.openai.com/api/docs/guides/streaming-responses |
| OpenAI Responses event types | https://developers.openai.com/api/reference/resources/responses/streaming-events/ |
| Anthropic Messages streaming | https://platform.claude.com/docs/en/build-with-claude/streaming |
| Anthropic Messages + tools | https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview |
| Gemini generateContent / stream | https://ai.google.dev/api/generate-content |
| Gemini models list | https://ai.google.dev/api/models |
| Gemini API key header | https://ai.google.dev/gemini-api/docs/api-key |
| OpenRouter OpenAI-compatible | https://openrouter.ai/docs/api_reference/overview |
| Groq OpenAI compatibility | https://console.groq.com/docs/openai |
| Mistral chat API | https://docs.mistral.ai/api/endpoint/chat |
| Kimi / Moonshot API overview | https://platform.kimi.ai/docs/api/overview |
| DashScope OpenAI compatibility | https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope |
| Z.AI quick start | https://docs.z.ai/guides/overview/quick-start |
| Ollama OpenAI compatibility | https://docs.ollama.com/api/openai-compatibility |
| LM Studio OpenAI compatibility | https://lmstudio.ai/docs/developer/openai-compat |
| xAI OpenAI-compatible base | https://api.x.ai/v1 (OpenAI Chat Completions surface) |

## Frozen built-in presets

| ID | Wire family | Auth | Default base URL | Notes |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI Responses | Bearer | `https://api.openai.com/v1` | `POST /responses`, `GET /models` |
| `anthropic` | Anthropic Messages | `x-api-key` + `anthropic-version: 2023-06-01` | `https://api.anthropic.com` | `POST /v1/messages`, `GET /v1/models` |
| `gemini` | Gemini generateContent | `x-goog-api-key` header | `https://generativelanguage.googleapis.com/v1beta` | stream via `...:streamGenerateContent?alt=sse` (fixed non-credential query) |
| `groq` | OpenAI Chat Completions | Bearer | `https://api.groq.com/openai/v1` | |
| `xai` | OpenAI Chat Completions | Bearer | `https://api.x.ai/v1` | |
| `mistral` | OpenAI Chat Completions | Bearer | `https://api.mistral.ai/v1` | |
| `openrouter` | OpenAI Chat Completions | Bearer | `https://openrouter.ai/api/v1` | |
| `kimi` | OpenAI Chat Completions | Bearer | `https://api.moonshot.ai/v1` | aliases: `moonshot` |
| `zai` | OpenAI Chat Completions | Bearer | `https://api.z.ai/api/paas/v4` | aliases: `glm` |
| `dashscope` | OpenAI Chat Completions | Bearer | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | **No `StreamingTools`** — tools force non-stream JSON round |
| `ollama` | OpenAI Chat Completions | None (optional bearer) | `http://127.0.0.1:11434/v1` | loopback only |
| `lmstudio` | OpenAI Chat Completions | None (optional bearer) | `http://127.0.0.1:1234/v1` | loopback only |
| `custom` | OpenAI Chat Completions | Bearer | operator-required | HTTPS or loopback HTTP; no userinfo/fragment/query |

## Wire behavior summary

1. **OpenAI Responses** — SSE semantic events; text from `response.output_text.delta`; reasoning deltas become `reasoning_status` only; function calls from output item / arguments events; `response.completed` terminal.
2. **OpenAI Chat Completions** — SSE chunks + `[DONE]`; `delta.content` text; `delta.tool_calls` accumulated; `reasoning_content` → status only.
3. **Anthropic Messages** — named SSE events; `text_delta` text; `thinking_delta` → status only; `tool_use` + `input_json_delta` → `tool_proposed` on `content_block_stop`; `message_stop` terminal.
4. **Gemini** — `streamGenerateContent?alt=sse`; candidate part text; `thought: true` → status only; `functionCall` → `tool_proposed`; EOF completes when no explicit terminal.

## Safety posture

- Redirects disabled; ambient proxy disabled; connect 10s / total 60s / idle pool 30s.
- Max three attempts; retry only pre-body connect/408/429/5xx with capped Retry-After + deterministic jitter.
- Never retry 401/403, after body acceptance, tool/result effect, or mid-stream failure.
- Base URLs reject userinfo, fragments, query strings, non-loopback HTTP, and cloud origin overrides.
- Credentials use `SecretString` (redacted Debug, no Serialize) and sensitive header values.
- Public `ProviderError` / `AiError` never embeds arbitrary vendor bodies. HTTP failures expose status, optional short vendor code, and retry timing only.
- Error-body inspection is cancellation-aware and hard-capped at 64 KiB (`read_error_body_bounded`); the connection is dropped at the cap.
- Active request credentials are scrubbed from any retained diagnostic message fields before error construction/return.
- Generation fence checked at frame and effect boundaries; cancel yields `Cancelled` without applying late effects.

## Wave 0 security findings closed in this wave

| ID | Fix |
| --- | --- |
| `P6-W0-SEC-001` | Replaced `Response::bytes()` error-body reads with cancel-aware incremental reads capped at 64 KiB; drop immediately at the cap. Regression: `p6_w0_sec_001_error_body_read_is_bounded_and_cancel_aware`. |
| `P6-W0-SEC-002` | Public HTTP errors no longer carry vendor body text; only status/optional short code/retry-after. Active credential scrubbing on retained diagnostics. Regression: `p6_w0_sec_002_active_credential_reflection_never_enters_public_error`. |

## Validation performed (Wave 2)

```bash
cargo fmt --all -- --check
cargo clippy --locked -p junban-ai --all-targets --all-features -- -D warnings
cargo test --locked -p junban-ai --all-features
cargo test --locked --workspace --all-features
cargo deny check
cargo audit
git diff --check
```

All of the above passed on the Wave 2 commit tree (no end-to-end/server acceptance claimed).

## Limitations / non-claims

- No live provider network tests in CI.
- No hard-coded complete vendor model catalogs; discovery maps provider-reported IDs and inherits provider-level capabilities without guessing per-model tool/vision support.
- No OAuth / subscription-login emulation.
- No server route composition, secret store, tool orchestration, React, or voice work in this wave.
- DeepSeek is not a built-in preset in this freeze; operators may use `custom`.
