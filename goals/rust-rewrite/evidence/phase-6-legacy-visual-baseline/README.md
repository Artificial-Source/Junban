# Phase 6 legacy visual authority

These sixteen images freeze the approved legacy-rendered AI and voice surfaces
before any Phase 6 rewrite UI exists. They were captured from a clean detached
worktree of private `Junban-legacy` at
`5e2b2b5adc865f401843c5030285293c5fabccc5` through an ephemeral fixture harness
that mounts the real legacy React components with offline props/state. They are
not rewrite-generated expected output.

After this capture, CI and local rewrite work do not need the private legacy
repository. Updating these authority images or accepting an intentional visible
difference requires explicit user approval. The rewrite may not silently bless
its own screenshots as the new baseline.

Phase 1–4 visual authorities remain immutable and are not modified here.

## 16-scene matrix

| #   | Scene ID                        | File                                              | Viewport | Theme |
| --- | ------------------------------- | ------------------------------------------------- | -------- | ----- |
| 1   | AI chat not configured panel    | `ai-not-configured-panel-desktop-light.png`       | 320×720  | light |
| 2   | Welcome / daily briefing        | `ai-welcome-briefing-desktop-light.png`           | 1440×900 | light |
| 3   | Conversation + tool cards       | `ai-conversation-tools-desktop-light.png`         | 1440×900 | light |
| 4   | Chat history                    | `ai-chat-history-desktop-light.png`               | 1440×900 | light |
| 5   | Mobile AI view + bottom nav     | `ai-mobile-view-nav-light.png`                    | 390×844  | light |
| 6   | Settings AI unconfigured        | `settings-ai-unconfigured-desktop-light.png`      | 1280×900 | light |
| 7   | Settings AI configured (masked) | `settings-ai-configured-masked-desktop-light.png` | 1280×900 | light |
| 8   | Settings Voice defaults         | `settings-voice-defaults-desktop-light.png`       | 1280×900 | light |
| 9   | Settings Voice cloud            | `settings-voice-cloud-desktop-dark.png`           | 1280×900 | dark  |
| 10  | PTT listening                   | `ptt-listening-desktop-light.png`                 | 480×320  | light |
| 11  | PTT transcribing                | `ptt-transcribing-desktop-light.png`              | 480×320  | light |
| 12  | PTT error                       | `ptt-error-desktop-light.png`                     | 480×320  | light |
| 13  | VAD grace period                | `vad-grace-desktop-light.png`                     | 480×420  | light |
| 14  | Voice-call states               | `voice-call-states-desktop-light.png`             | 1280×900 | light |
| 15  | Focused-task launch             | `focused-task-launch-desktop-light.png`           | 1440×900 | light |
| 16  | Onboarding StepAI               | `onboarding-step-ai-desktop-light.png`            | 720×720  | light |

Each scene records its legacy component and focused test authority in
`manifest.json`. Every scene uses `maxDiffPixelRatio: 0.01`.

## Deterministic protocol

- Legacy commit: `5e2b2b5adc865f401843c5030285293c5fabccc5`
- Capture harness: `scripts/capture-phase-6-legacy-visual-baseline.mjs` +
  `scripts/phase-6-legacy-visual-baseline/**` (ephemeral overlay only; never
  committed into the legacy repository)
- Frozen browser clock: `2026-08-02T15:00:00.000Z`
- Browser: Playwright Chromium, `deviceScaleFactor: 1`, `reducedMotion: reduce`,
  animations disabled at screenshot time
- Typography: Noto Sans via `system-ui` (Outfit/Google Fonts network blocked)
- Network: non-local requests aborted; no provider, key, mic, or model traffic
- Fixture data: synthetic demo copy only; configured-secret scenes show masked
  presence (`Set`), never raw credentials
- Voice/media states driven through legacy component props and the VoiceButton
  state machine inside the harness

## Acceptance rule

`tests/e2e/visual-phase-6.spec.ts` (Wave 4) compares the rewrite against these
PNGs with `maxDiffPixelRatio: 0.01` for every scene. Repository integrity is
enforced by:

```bash
node scripts/check-phase6-legacy-visual-baseline.mjs
```

The checker rejects missing/changed PNG hashes, wrong source commit, duplicate
scene IDs, non-`0.01` thresholds, orphan PNGs, and forbidden secret/network
strings.

## Capture command

Regenerate only from the pinned legacy checkout. Normal rewrite `pnpm test:e2e`
never writes to this directory.

```bash
export JUNBAN_LEGACY_ROOT=/absolute/path/to/Junban-legacy
node scripts/capture-phase-6-legacy-visual-baseline.mjs
```

The capture creates a clean detached temporary worktree at the pinned commit,
overlays the ephemeral harness, renders offline, writes PNGs + `manifest.json`,
and removes the worktree. Untracked `.junban-builtin-*` directories in any dirty
legacy working tree are ignored because capture never uses that checkout's dirty
tree.

## Privacy

Images contain only synthetic open-source demo copy. No real tokens, API keys,
hostnames, microphone device names from the host, personal paths, or provider
network identifiers. PNG bytes and the manifest are scanned by the capture
harness and the repository checker.
