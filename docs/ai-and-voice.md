# AI and voice

Optional cloud AI chat and browser-local or cloud speech for the hosted Junban server. Both subsystems are **off by default**, load lazily, and never require Node at runtime. Desktop packaging and plugins are out of scope here.

Related: [`architecture.md`](architecture.md) (crate and runtime boundaries), [`security.md`](security.md) (profile secrets and HTTP posture), [`cli.md`](cli.md) / [`mcp.md`](mcp.md) (automation catalog — AI chat routes are operator browser/API surfaces, not catalog tools).

## What you get

| Surface                                      | Where                                    | Default                                             |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| AI chat, tools, approvals, history, memories | Browser **AI** route + Settings → **AI** | Disabled until a provider is configured and enabled |
| Cloud speech (STT/TTS)                       | Settings → **Voice**, chat mic controls  | Cloud speech disabled; Browser speech selected      |
| Local Whisper / Kokoro / Piper               | Settings → **Voice** → local models      | Not downloaded; preference is Browser               |
| Daily briefing                               | AI chat when enabled in AI settings      | Off                                                 |

Feature flags under Settings → **Features** control other product surfaces only. They do not enable AI, delete AI data, or authorize providers.

## Configure cloud AI

1. Open **Settings → AI**.
2. Choose a provider, model, and (when required) paste an API key. Keys are submitted once to the server and never shown again.
3. Optionally set custom instructions, default planning energy (1–5), daily briefing, and auto-send after voice transcription.
4. Save. The UI applies only **server-confirmed** settings — drafts are not used for chat or speech.

### Supported chat providers

Canonical wire IDs (snake_case):

| ID           | Label           | Default base URL                                         | Auth                                |
| ------------ | --------------- | -------------------------------------------------------- | ----------------------------------- |
| `openai`     | OpenAI          | `https://api.openai.com/v1`                              | API key (Bearer)                    |
| `anthropic`  | Anthropic       | `https://api.anthropic.com`                              | API key                             |
| `openrouter` | OpenRouter      | `https://openrouter.ai/api/v1`                           | API key                             |
| `ollama`     | Ollama          | `http://127.0.0.1:11434/v1`                              | None                                |
| `lm_studio`  | LM Studio       | `http://127.0.0.1:1234/v1`                               | None                                |
| `deepseek`   | DeepSeek        | `https://api.deepseek.com`                               | API key                             |
| `gemini`     | Gemini          | `https://generativelanguage.googleapis.com/v1beta`       | API key                             |
| `mistral`    | Mistral         | `https://api.mistral.ai/v1`                              | API key                             |
| `kimi`       | Kimi / Moonshot | `https://api.moonshot.ai/v1`                             | API key                             |
| `dashscope`  | DashScope       | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | API key                             |
| `groq`       | Groq            | `https://api.groq.com/openai/v1`                         | API key                             |
| `z_ai`       | Z.AI / GLM      | `https://api.z.ai/api/paas/v4`                           | API key                             |
| `custom`     | Custom          | **Required** operator URL                                | API key when the endpoint needs one |

Built-in cloud presets accept **only** their official HTTPS origin. Ollama and LM Studio accept **loopback** hosts only (any loopback port). Custom endpoints allow:

- HTTPS to any host (including private/Tailnet hosts you explicitly choose);
- HTTP **only** to loopback.

All provider base URLs reject URL userinfo, query strings, and fragments. Model lists come from `GET /api/v1/ai/providers/{provider}/models` after the provider is configured; you may also type a model id manually.

### Credentials and privacy

- Raw provider and speech secrets live only in the profile-private file `ai-secrets.json` (owner-only on Unix). Settings store a random **credential id**, never the secret.
- Config and chat APIs return presence metadata only (`present: true/false`). Secrets are never logged, returned in errors, written into SQLite events/receipts, or included in complete backups.
- Restore clears AI enablement and credential bindings from settings and does not read or write `ai-secrets.json`. Re-enter keys after restore if you still need cloud AI or cloud speech.
- At most 32 private AI secrets per profile; each value is capped at 8 KiB.
- Cloud providers send prompts and assembled task context to that provider’s endpoint. Loopback providers keep traffic on the machine when the endpoint is local. Custom HTTPS is operator-authored — review the URL before saving.

## Use AI chat

Open the **AI** navigation route. When AI is not configured, the shell offers **Configure AI** / **Set up voice** (same wording as onboarding).

Once configured:

- Create and switch sessions; list, rename, clear, or delete them.
- Send messages; the server streams a versioned local SSE transcript (`run_started`, `text_delta`, `reasoning_status`, `usage`, terminal `run_completed` / `run_cancelled` / `run_failed`). Keepalives are comment-only. Vendor frames, raw provider bodies, credentials, and hidden chain-of-thought do not cross the API boundary.
- **Stop** cancels the active run (`POST /api/v1/ai/runs/{run_id}/cancel`).
- Edit a user message and resend, retry a failed turn, or regenerate the last assistant reply. These are operator-only suffix rewrites with durable receipts.
- Optional **daily briefing** reserves one streaming/completed briefing per server-local civil date and asks the model to start with read-only planning (`plan_my_day`) without applying a schedule.
- Explicit **memories** are managed in Settings → AI (and via tools). Bounds: 500 memories/profile, 10 000 bytes each content field, 100 per settings page; at most 50 memories enter one provider context pack.

Chat, configuration, credentials, sessions, memories, approvals, and response actions are **operator-only** HTTP/SSE routes. They are intentionally absent from the frozen CLI/MCP automation catalog.

### Tools and approvals

The server advertises a fixed registry of task/planning tools (create/update/complete tasks, projects, tags, reminders, planning summaries, memories, timeblocking, and related reads). Exactly one tool call is accepted per model round.

| Effect                | Behavior                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**              | Runs immediately. Returns a bounded trusted result envelope (no receipts, tokens, or raw provider/transport errors).                                                                  |
| **Approval required** | Streams a proposal bound to `approval_id` + `action_hash`. The hash covers the canonical tool name and canonical JSON arguments. Nothing mutates until you **Approve** or **Reject**. |

Approvals:

- Bind the exact tool action to the run/session/generation identity.
- Expire after a short durable lifetime (five minutes).
- On approve, dispatch goes through the same `AppService` mutation path as the rest of the product (one transaction, event, and receipt per commit where applicable).
- On reject, a stable rejection result is recorded on the turn; no mutation runs.
- Startup recovers a bounded set of interrupted dispatching approvals without re-running arbitrary provider work.

UI cards use **Approve** / **Reject** with the tool name and the complete exact structured arguments. The argument area scrolls instead of truncating, so inspect every field and item before approving; do not approve actions you do not understand.

### Scheduling tools

- `auto_schedule_day` returns a **deterministic day-schedule preview** from current plan data and work hours. It does not mutate the calendar by itself.
- `apply_auto_schedule_day` applies **only the exact preview blocks** carried in the approved action. Free-form or drifted block lists are rejected; approval is required before any write.
- `reschedule_day` is likewise a deterministic preview for overdue/focus work. Individual timeblocking create/update/delete/schedule/replan tools remain separate approval-gated mutations.

### Cancellation and limits (operator expectations)

- Concurrent provider runs are capped per process; excess work fails closed rather than queueing unboundedly.
- Context assembly is bounded (conversation rows, memories, UTF-8 size, and token estimate). Oversized tool results are truncated or rejected with structured errors.
- Disabling AI or changing provider/credentials drains in-flight AI activity before the settings commit when possible; a timed-out drain stays fail-closed.

## Configure voice

Open **Settings → Voice**.

### Modes and providers

| Control             | Options                        | Notes                                              |
| ------------------- | ------------------------------ | -------------------------------------------------- |
| Speech-to-text      | Browser, OpenAI, Groq          | Inworld is not offered for STT                     |
| Text-to-speech      | Browser, OpenAI, Groq, Inworld | Inworld is TTS-only                                |
| Cloud speech master | On/Off                         | Required for cloud STT/TTS routes                  |
| Speak responses     | On/Off (`tts_enabled`)         | Independent of STT                                 |
| Voice mode          | Push-to-Talk, VAD (Hands-free) | Hands-free uses browser VAD + grace period         |
| Grace period        | 500–3000 ms (default 1000)     | Silence window before hands-free ends an utterance |
| Microphone          | Browser device picker          | Stored only as a local device id preference        |

Cloud speech help text in the UI: credentials stay server-side and audio for cloud providers is sent through the Junban server (`POST /api/v1/voice/transcriptions`, `POST /api/v1/voice/speech`). Browser speech may use a browser-vendor cloud service and the system default microphone unless you grant permission and pick a device.

Switching away from a cloud provider that still has a stored credential prompts confirmation and removes that binding before the new provider is saved.

### Local speech models (browser)

When STT/TTS is **Browser**, you may optionally download and select pinned local packages. Preferences live in browser storage only (`junban.voice.local.v1`) and never hold secrets.

| Package id                    | Role      | Engine pin                           | License (package)                         |
| ----------------------------- | --------- | ------------------------------------ | ----------------------------------------- |
| `whisper-tiny.en-q4`          | Local STT | `@huggingface/transformers@3.8.1`    | OpenAI-Whisper-MIT                        |
| `kokoro-82m-v1-q8`            | Local TTS | `kokoro-js@1.2.1`                    | Apache-2.0                                |
| `piper-en_US-ljspeech-medium` | Local TTS | `@mintplex-labs/piper-tts-web@1.0.4` | MIT (LJ Speech source data public domain) |

Rules:

- Every weight is pinned by Hugging Face repo, **immutable revision**, path, byte length, and SHA-256. Mutable roots such as `resolve/main` are rejected.
- First use requires an explicit consent checkbox, then a single-flight verified download into Origin Private File System (OPFS). Bytes are admitted only after size + hash checks.
- Workers, ONNX Runtime glue/WASM, VAD worklet, and Piper support assets are **same-origin** hashed URLs loaded through dynamic imports. Ordinary app startup does not fetch or initialize them.
- Engines read only the verified cache. Unverified network fallback is not used at inference time.
- Selecting a local package does **not** silently fall back to Browser speech on failure — fix or remove the package, or choose Browser explicitly.
- Local model weights and runtime stay in the browser. They do **not** count against the hosted server cgroup memory budget.

### Microphone and VAD lifecycle

- Microphone access is requested from a user gesture. Tracks are stopped when capture ends or the controller unmounts.
- Push-to-talk holds the mic only while armed/listening.
- Hands-free opens a call session with VAD; the configured grace period governs end-of-utterance. Ending the call releases mic, AudioContext, and workers for that generation.
- `AudioContext` may be unavailable or suspended (browser autoplay policy). Playback is best-effort; failures surface as voice errors without crashing chat.
- Permission denial shows a recoverable error; use **retry** after allowing the mic in browser site settings.

## Runtime boundaries

```text
Browser UI ──HTTP/SSE──► junban-server ──► junban-app ──► junban-storage (SQLite)
                │              │
                │              ├── junban-ai (lazy provider + cloud speech clients)
                │              └── private ai-secrets.json (raw keys only here)
                │
                └── local voice workers / OPFS (Whisper, Kokoro, Piper, VAD)
```

- `junban-ai` is constructed on demand when confirmed AI or cloud speech needs it. Idle default startup does not open provider HTTP clients or load local engines.
- Tool mutations always go through application use cases; the model never writes SQLite directly.
- Node/pnpm build the frontend only. Production serves static assets from the Rust server.

## Troubleshooting

| Symptom                             | What to check                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| AI route stays on “not configured”  | Settings → AI: enabled, provider, model; credential present for cloud providers; save succeeded                            |
| Model list empty                    | Provider reachable; for Ollama/LM Studio, loopback service up; credential valid for cloud                                  |
| Custom provider rejected            | HTTPS or loopback HTTP only; no userinfo/query/fragment; URL required for `custom`                                         |
| Tool did nothing                    | Mutation tools need **Approve**; expired approvals must be re-proposed by a new turn                                       |
| Cancel appears ignored              | Wait for terminal SSE (`run_cancelled` / completed); refresh session history if the tab dropped the stream                 |
| Cloud STT/TTS 409/503               | Cloud speech disabled, missing model/credential, speech capacity, or runtime draining for reconfigure                      |
| Mic permission error                | Site settings → allow microphone; retry from the voice control; confirm non-empty device list after grant                  |
| Local model “error” / hash failure  | Remove the package card cache entry, confirm disk/OPFS quota, reload, consent and download again (pinned revision only)    |
| Local model selected but silent     | Package must show **ready**; `tts_enabled` on; AudioContext not blocked; try Push-to-Talk once to satisfy gesture policies |
| After restore, AI disabled          | Expected: re-add keys in Settings; chat history may restore from SQLite while secrets do not                               |
| High server memory with local voice | Local weights run in the browser only; inspect browser task manager, not the server cgroup                                 |

## Privacy and egress summary

| Data                                         | Leaves the machine?                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Task/planning context in AI chat             | Yes, to the configured chat provider endpoint when AI runs                          |
| Provider API keys                            | No (server-private file; used only as upstream auth)                                |
| Cloud STT audio / TTS text                   | Yes, via Junban server to OpenAI, Groq, or Inworld when cloud speech is enabled     |
| Browser speech audio                         | Depends on the browser vendor implementation                                        |
| Local Whisper/Kokoro/Piper audio and weights | No provider egress after the one-time pinned Hugging Face download you consented to |
| Automation CLI/MCP traffic                   | Separate scoped credentials; does not expose AI secret bytes or chat SSE            |

## Related operator docs

- [`setup.md`](setup.md) — toolchain and `pnpm check` (includes local-voice asset checks)
- [`performance.md`](performance.md) — hosted memory measurement (AI disabled by default in matched baselines)
- [`accessibility.md`](accessibility.md) — UI accessibility expectations
