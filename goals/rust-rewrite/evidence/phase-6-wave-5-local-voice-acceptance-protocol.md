# Phase 6 Wave 5 — real-browser local-voice acceptance protocol

Status: frozen before the authoritative opt-in run. Ordinary CI does **not**
download model weights. Discovery-only or mocked inference cannot accept local
voice.

## Command

```bash
pnpm build
cargo build --locked --release -p junban-server
pnpm exec playwright install chromium
JUNBAN_LOCAL_VOICE_ACCEPTANCE=1 pnpm test:e2e:local-voice-acceptance
# equivalent:
# node scripts/run-phase6-local-voice-acceptance.mjs
# optional rebuild: node scripts/run-phase6-local-voice-acceptance.mjs --build
```

## What must be proven

1. Exact-manifest OPFS admission (size + SHA-256) for Whisper, Kokoro, and Piper.
2. One first-download path and one warm-cache reverify/reload path per engine.
3. Real inference, not load/discovery only:
   - Whisper: nonempty transcript with expected phrase signal (`plan` / `day`)
     from the committed synthetic fixture.
   - Kokoro: nonempty playable PCM.
   - Piper: nonempty playable WAV.
4. Worker dispose/terminate, MediaStream track stop, AudioContext/object URL cleanup.
5. Cancelled download recovery and failed (cache-miss) load recovery.
6. No live provider credentials or provider egress.
7. Settings → Voice consent Load path admits at least one verified package.
8. Separate ordinary CI check (`lazy-network-phase-6`) proves `/` initial load
   fetches no AI/voice/local-model chunks or model origins; AI/Voice chunks
   appear only after opening those surfaces; engines/models only after consent.

## Fixture

See `tests/acceptance/fixtures/README.md`. Synthetic eSpeak NG WAV, 16 kHz mono,
phrase `plan my day`. Not shipped under `public/`.

## Evidence outputs

| Path                                                                             | Meaning                                                                     |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `goals/rust-rewrite/evidence/phase-6-wave-5-local-voice-acceptance.json`         | Pass/fail machine-readable report                                           |
| `goals/rust-rewrite/evidence/phase-6-wave-5-local-voice-acceptance-blocker.json` | Written when the harness cannot complete (no network, missing binary, etc.) |

Passing acceptance requires `status: "passed"` in the primary evidence file.
A blocker file means the executable harness exists but acceptance is **not**
claimed.

## Allowlisted acceptance seam

Query: `?acceptance=phase-6-local-voice` only. Lazy-loaded root; not linked from
ordinary navigation; does not weaken CSP; does not embed model weights.

## Authoritative run result

- **Status:** passed
- **Evidence:** `phase-6-wave-5-local-voice-acceptance.json`
- **Command:** `JUNBAN_LOCAL_VOICE_ACCEPTANCE=1 pnpm test:e2e:local-voice-acceptance`
- **Browser:** Chromium (Playwright Desktop Chrome)
- **Whisper:** hash-verified load + nonempty transcript signal (`day` from fixture phrase `plan my day`); first download ~8.6 s, warm load ~6.2 s, infer ~2.1 s
- **Kokoro:** hash-verified load + playable PCM (~1.65 s / 158400 bytes); first download ~7.4 s, warm ~3.5 s, infer ~4.1 s
- **Piper:** hash-verified load + playable WAV (~1.03 s / 45612 bytes); first download ~5.0 s, warm ~3.0 s, infer ~0.4 s
- **Cache/cleanup:** first-download network observed; warm reuse skipped model origins; cancel + cache-miss recovery passed; workers terminated; MediaStream tracks stopped; AudioContext/object URLs cleaned
- **Ordinary CI:** `pnpm exec playwright test --project=lazy-network-phase-6` (no model downloads)
