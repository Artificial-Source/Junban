# Phase 6 Wave 4 — Preserved AI and Voice Experience

- **Date:** 2026-08-03
- **Base:** Wave 3 closure at `040bab3`
- **Status:** implementation in progress
- **Scope:** preserved React AI/voice surfaces, browser and local speech execution, bounded Rust cloud speech, functional/visual/accessibility validation
- **Claim boundary:** this document does not claim local-model inference, browser voice cleanup, immutable visual parity, accessibility closure, or Phase 6 performance/dogfood closure until the remaining subwaves and Wave 5 evidence pass.

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

## Required remaining work

- Complete the generation-fenced browser PTT, hands-free VAD, Web Speech, cloud STT/TTS, and half-duplex call controller.
- Replace load-only local workers with exact-manifest Whisper/Kokoro/Piper inference and deterministic dispose/terminate behavior.
- Connect Voice Settings load/remove controls to verified local-engine state without importing engines into initial chunks.
- Add all sixteen immutable Phase 6 visual comparisons at `maxDiffPixelRatio: 0.01`, functional voice permission/cleanup tests, axe/mobile coverage, and production CSP/browser evidence.
- Run the integrated frontend/accessibility and security-dominant review gates, close every material finding with focused regressions, then proceed to Wave 5 performance/dogfood/closure evidence.

## Validation recorded so far

Focused subwave validation includes Rust AI/server tests and clippy, frontend Vitest/typecheck/build/runtime-boundary checks, OpenAPI/generated-contract checks, local-voice asset scans, supply-chain checks where applicable, and `git diff --check`. Exact commands and outcomes for cloud speech are retained in `phase-6-wave-4c.md`. Integrated Wave 4 validation remains pending and will replace subwave-only evidence at closure.
