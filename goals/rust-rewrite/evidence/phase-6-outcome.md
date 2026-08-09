# Phase 6 outcome

Date: 2026-08-04

## Outcome

Junban now provides optional AI and voice through the shared Rust application authority while preserving the approved React interface:

- a lazy `junban-ai` provider boundary covers the approved OpenAI Chat, OpenAI Responses, Anthropic Messages, and Gemini wire families without constructing a client on disabled startup;
- schema-v6 sessions, messages, memories, runs, approvals, receipts, invalidations, quotas, and private credential bindings are durable, bounded, restore-validated, and crash-recoverable;
- streaming chat, history, edit/retry/regenerate, daily briefing, focused-task entry, tool execution, approval/rejection, cancellation, and startup dispatch recovery share one application-service path;
- the fixed 49-tool AI registry includes read and mutation tools plus exact preview-bound approved schedule application; the independent CLI/MCP catalog remains the frozen 87 tools;
- browser, cloud, and optional hash-verified local speech support push-to-talk and half-duplex calls with explicit privacy, download, retry, and cleanup controls;
- all local Whisper, Kokoro, Piper, and VAD code remains behind browser-only dynamic imports/workers, while ordinary startup loads no engine/model module and performs no provider/model request;
- provider and speech secrets remain in the private sidecar, never SQLite or complete backups, and restore clears bindings and disables AI/cloud speech before cutover.

No Node runtime, second live store, schema-v7 compatibility layer, unrestricted plugin surface, or speculative provider framework was introduced.

## Acceptance evidence

### Disabled path

The authoritative five-pair matched-release report at code/evidence candidate `6401108b31e7768048d154c8b14662bb3a2e9bb1` passed every gate:

- Phase 5 parent median warm: **8.0742 MiB**;
- Phase 6 disabled median warm: **8.3711 MiB**;
- median delta: **0.2969 MiB**, below the frozen **1.2111 MiB** allowance;
- Phase 6 maximum warm / peak: **8.8477 / 8.9727 MiB**, below the **24/32 MiB** ceilings;
- one Rust process, no resident Node process, cleanup, initial-UI request proof, and absolute/growth budgets all passed.

Evidence: [`phase-6-disabled-matched-release.json`](phase-6-disabled-matched-release.json) and [`phase-6-disabled-matched-release-protocol.md`](phase-6-disabled-matched-release-protocol.md).

### Enabled local-mock path

The authoritative three-profile optimized local-mock run on the same candidate passed every frozen gate:

- post-session warm maximum: **11.0898 MiB**;
- operation peak maximum: **12.6953 MiB**;
- cgroup absolute peak maximum: **13.3164 MiB**;
- post-drain growth maximum: **3.0898 MiB**;
- first normalized event p95: **6.8936 ms**;
- completed short turn p95: **10.5165 ms**;
- cancellation-to-terminal-quiescence p95: **1.8527 ms**;
- 1 MiB STT/TTS p95: **6.3739 / 3.9619 ms**.

The exact operation matrix covered discovery, 90 fragmented UTF-8 streams, read tools, rejected and approved exactly-once mutations, retry-before-body, timeout, mid-stream failure, cancellation, 1 MiB speech, drain cleanup, secret scans, and the one-Rust/no-Node process boundary. Evidence: [`phase-6-enabled-benchmark.json`](phase-6-enabled-benchmark.json) and [`phase-6-enabled-benchmark-protocol.md`](phase-6-enabled-benchmark-protocol.md).

### Browser and local engines

- Sixteen immutable legacy-rendered AI/voice scenes passed at `maxDiffPixelRatio: 0.01`.
- All Phase 6 axe and keyboard checks passed.
- Deterministic browser/media and lazy-network scenarios passed.
- Real Chromium hash-verified Whisper, Kokoro, and Piper inference passed, including first-download admission, warm-cache reuse, cancellation, cache-miss recovery, playable PCM/WAV output, and worker/media/AudioContext/object-URL cleanup without provider credentials or live provider egress.
- Exact optimized-build dogfood passed provider setup, model discovery, text/history/read tools, approval and rejection, 67 ms withheld-header cancellation with no late text after seven seconds, focused Ask AI, preview-bound schedule approval into Timeblocking, VAD call listening/cleanup, complete backup/restore, and disabled-state recovery.

Evidence: [`phase-6-wave-5-local-voice-acceptance.json`](phase-6-wave-5-local-voice-acceptance.json), [`phase-6-dogfood/report.md`](phase-6-dogfood/report.md), and [`phase-6-legacy-visual-baseline/README.md`](phase-6-legacy-visual-baseline/README.md).

### Cross-surface and contracts

The exact candidate passed the frozen Phase 5 corpus again as `junban-phase6-conformance-v1` with schema version 6 and one matching digest across HTTP, remote CLI, local-owner CLI, and MCP. OpenAPI and generated TypeScript are current; AI/voice operator routes remain outside the independent 87-tool automation catalog.

Evidence: [`phase-6-conformance.json`](phase-6-conformance.json) and [`phase-6-conformance-protocol.md`](phase-6-conformance-protocol.md).

## Dogfood findings

All discovered material dogfood findings are fixed with focused regressions:

- `P6-DOG-001`: approval controls now remain usable while a tool proposal is streaming;
- `P6-DOG-002`: cancellation races the provider response-header future and suppresses late output without retry;
- `P6-DOG-003`: `apply_auto_schedule_day` is approval-required and accepts only the exact immediately preceding successful preview in the same run;
- `P6-DOG-004`: browser VAD receives both exact hashed ORT `.mjs` and `.wasm` paths and reaches listening without mutable fallback.

The complete closure record is in [`phase-6-dogfood/report.md`](phase-6-dogfood/report.md).

## Validation

Final integrated validation passed:

- `cargo fmt --all -- --check`;
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`;
- `cargo test --locked --workspace --all-features` — **837 passed**;
- `cargo audit` and `cargo deny check` — no advisory, license, source, or ban failure;
- `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`;
- `pnpm test` — **606 passed**;
- `pnpm build`, contract, docs, runtime-boundary, local-asset, and immutable-visual checks;
- `pnpm test:e2e` — **133 passed**;
- opt-in real local-voice acceptance — **2 passed**;
- `pnpm audit --audit-level high` — no known vulnerability after raising the exact `brace-expansion` override from 5.0.8 to 5.0.9;
- authoritative schema-v6 conformance, disabled matched release, and enabled local-mock protocols.

The final phase security review and clean squash are recorded in the review ledger and execution plan.

## Review

Every persistence, architecture, security, API, tool-run, frontend, accessibility, and dogfood finding is closed with focused evidence. The final security-dominant gate found `P6-FINAL-SEC-001`: generic approval cards hid executable arguments after 2,000 characters. Complete safely escaped argument rendering plus a valid 100-task bulk-mutation regression fixed it; the narrow recheck approved Phase 6 with no remaining blocker. See [`phase-6-review-ledger.md`](phase-6-review-ledger.md).

## Follow-up

Phase 7 introduces capability-limited portable plugins. It must preserve the lazy-disabled result: no enabled plugin means no Wasmtime engine resident, and plugin work must not weaken the AI/voice secret, network, restore, or no-runtime-Node boundaries established here.
