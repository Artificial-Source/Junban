# Phase 6 Wave 4 — Preserved AI and Voice Experience

- **Date:** 2026-08-03
- **Base:** Wave 3 closure at `040bab3`
- **Status:** complete and reviewed at `975b513`
- **Scope:** preserved React AI/voice surfaces, browser and local speech execution, bounded Rust cloud speech, functional/visual/accessibility validation
- **Claim boundary:** Wave 4 claims the implemented frontend, browser/local/cloud voice, immutable visual, accessibility, and focused review gates only. Phase 6 enabled-runtime performance, real-browser model dogfood, exact-head specialist closure, documentation closure, and the final single phase commit remain Wave 5.

## Frozen plan corrections

| ID               | Resolution                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-W4-PLAN-001` | `/ai-chat` is the sole canonical route. Routing, direct-load, desktop, and mobile regressions reject an `/ai` alias.                                                                                                                                          |
| `P6-W4-PLAN-002` | Browser-owned immutable model delivery uses exact Hugging Face `connect-src` origins, same-origin workers, and `wasm-unsafe-eval`. Generic HTTPS, `unsafe-eval`, blob workers, provider origins, runtime CDN scripts, and a Rust model relay remain excluded. |
| `P6-W4-PLAN-003` | Cloud speech has a small supervisor separate from AI run state. Reconfiguration, restore, and shutdown serialize and drain both authorities.                                                                                                                  |
| `P6-W4-PLAN-004` | Cloud TTS performs one provider request. Provider character ceilings reject before secret resolution or egress; no automatic chunking, truncation, retry, or privacy-changing fallback.                                                                       |

## Completed subwaves

### Navigation and transport

- Canonical lazy `/ai-chat` route, desktop Sidebar destination, and raised mobile AI action.
- Typed authenticated AI transport over the Wave 3 OpenAPI contract.
- Bounded version-1 SSE framing, reduction, terminal handling, and animation-frame batching.
- Transport and SSE production ownership is split by endpoint family and protocol responsibility rather than accumulated in the existing application client.

### Cloud speech

`phase-6-wave-4c.md` records the exact provider endpoints, bounds, lifecycle, authorization, CSP, OpenAPI, generated contracts, deterministic 1 MiB fixtures, and validation. The implementation remains lazy at ordinary startup and keeps the 87-operation CLI/MCP catalog unchanged.

### Text AI and Settings presentation

- Preserved lazy AI chat route and not-configured, onboarding, welcome, history, message, tool, approval, composer, reasoning-status, and focused-task presentation.
- Safe Markdown excludes raw HTML and unsafe URLs; tool data remains bounded plain structured text.
- Canonical lazy `/settings/ai` and `/settings/voice` tabs use server-confirmed config, write-only credentials, model discovery, memory controls, microphone permission/cleanup, and immutable local-model metadata.
- Settings drafts never apply runtime behavior optimistically. Browser-local persistence is restricted to non-secret microphone/model consent preferences.

### Browser, cloud, and local voice

- One generation-fenced controller owns PTT, hands-free VAD, Web Speech, cloud STT/TTS, and half-duplex voice-call state. Physical media, VAD, TTS, and browser recognition are released on stop, end, error, unmount, reconfiguration, restore, and shutdown paths.
- End Call fences the current call/utterance/response generations, cancels the exact durable chat run, then releases physical resources. Late completions cannot restart output or persist a later tool effect.
- Cloud STT/TTS stays on authenticated Rust routes. Provider credentials, provider URLs, headers, and raw provider frames never enter browser storage or requests.
- Whisper, Kokoro, Piper, and VAD load only through dynamic worker/loader boundaries after explicit local selection. Settings load/remove controls use exact-manifest verified cache state; ordinary startup and initial chunks do not import or initialize an engine.
- User-selected local engines never silently fall back to a cloud provider. Local removal returns that engine to `not_installed`; restart revalidates marker and cache authority.

### Immutable visual, browser, and accessibility gates

- The sixteen Wave 0 legacy-rendered authorities remain byte-identical to their manifest and copied Playwright snapshots.
- All sixteen scenes pass at the frozen `maxDiffPixelRatio: 0.01`; no snapshot regeneration, mask, threshold exception, or baseline change was used.
- The query-scoped fixture gate accepts only `visual-fixture=phase-6` plus one allowlisted scene. Ordinary query strings cannot activate fixture presentation or suppress microphone guidance.
- Fifteen axe/keyboard scenarios cover desktop/mobile chat, history, settings, PTT errors, VAD, call controls, and the raised mobile AI destination with no serious or critical finding.
- Six Chromium fake-media/Web-Speech scenarios cover permission denial/retry, track cleanup, stale-generation suppression, half-duplex ordering, End Call cleanup, and browser-owned transcript paths without provider egress.

## Integrated review ledger

| ID              | Severity | Status | Resolution                                                                                                                                                                                                                                                                 |
| --------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P6-W4-REV-001` | High     | fixed  | End Call now fences call/utterance/response generations, clears pending response authority, cancels the exact durable conversation before physical release, and settles idle idempotently. Focused regressions prove one cancellation and suppression of stale completion. |
| `P6-W4-REV-002` | Medium   | fixed  | `VoiceButton` no longer reads ad-hoc query parameters. Normal `?ptt-error` keeps its alert, retry action, and valid `aria-describedby`; the immutable PTT authority uses only the allowlisted explicit fixture composition.                                                |

The narrow exact-delta recheck approved both findings. The integrated frontend/accessibility gate has no known material open finding.

## Validation

```text
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright test --project=visual-phase-6        # manifest + 16 scenes passed
pnpm exec playwright test --project=axe-phase-6           # 15 passed
pnpm exec playwright test --project=functional-phase-6-voice # 6 passed
pnpm check:runtime-boundary
pnpm check:phase6-legacy-visual
pnpm check:local-voice-assets --require-dist
pnpm contract:check
pnpm check:docs
pnpm format:check
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
git diff --check
```

Focused Rust cloud-speech and lifecycle outcomes remain in `phase-6-wave-4c.md`. Wave 5 owns release-binary disabled/enabled memory, first-download and warm-cache local-model execution, real browser permission/device cleanup, Tailnet dogfood, supply-chain refresh, exact-head security review, and final Phase 6 closure.
