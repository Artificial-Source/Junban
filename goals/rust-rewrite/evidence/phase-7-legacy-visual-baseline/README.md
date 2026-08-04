# Phase 7 legacy visual authority

These thirteen images freeze the approved legacy-rendered **Extensions** and
plugin contribution surfaces before any Phase 7 rewrite UI exists. They were
captured from a clean detached worktree of private `Junban-legacy` at
`5e2b2b5adc865f401843c5030285293c5fabccc5` through an ephemeral fixture harness
that mounts the real legacy React components with offline props/state. They are
not rewrite-generated expected output.

After this capture, CI and local rewrite work do not need the private legacy
repository. Updating these authority images or accepting an intentional visible
difference requires explicit user approval. The rewrite may not silently bless
its own screenshots as the new baseline.

Phase 1–6 visual authorities remain immutable and are not modified here.

## Authority scope

This directory is **behavioral and visual authority only** for:

- Settings tab id `plugins`, visible label **Extensions**
- Restricted Mode / community-enable safety confirmation
- Permission approval chrome showing exact requested permissions
- Registry browser list/search/filter, detail/install, empty/loading/error
- Typed plugin settings panel
- Pomodoro structured view + status item
- Declarative structured panel/actions (`StructuredContentRenderer` + `PluginPanel`)
- Mobile Settings Extensions category/detail flow
- One dark-mode contribution

### Explicitly rejected legacy architecture

These images must **not** be read as approval to port:

- Node `vm`, `require`, archive extraction, or unrestricted host filesystem/process access
- Dynamic TypeScript/React imports and `contentType: "react"` guest UI / arbitrary React architecture
- “Restricted Mode” presented as hostile-code isolation
- Package code staged under the application source tree or resolved through `node_modules`
- Live marketplace/network registry dependencies

`manifest.json` records
`policy.rejects_node_vm_require_arbitrary_react` and the repository checker
fails closed when that policy string is missing. Phase 7 implements
capability-limited portable WebAssembly Component Model plugins with trusted
declarative React rendering only.

## 13-scene matrix

| #   | Scene ID                                     | File                                               | Viewport | Theme |
| --- | -------------------------------------------- | -------------------------------------------------- | -------- | ----- |
| 1   | Settings Extensions main / built-in list     | `settings-extensions-main-desktop-light.png`       | 1280×900 | light |
| 2   | Restricted Mode safety confirmation          | `settings-extensions-safety-desktop-light.png`     | 1280×900 | light |
| 3   | Permission approval dialog                   | `settings-extensions-permission-desktop-light.png` | 1280×900 | light |
| 4   | Registry list/search/filter + detail/install | `registry-browser-list-detail-desktop-light.png`   | 1280×900 | light |
| 5   | Registry empty                               | `registry-browser-empty-desktop-light.png`         | 1280×900 | light |
| 6   | Registry loading                             | `registry-browser-loading-desktop-light.png`       | 1280×900 | light |
| 7   | Registry error                               | `registry-browser-error-desktop-light.png`         | 1280×900 | light |
| 8   | Typed plugin settings (Pomodoro)             | `plugin-settings-pomodoro-desktop-light.png`       | 1280×900 | light |
| 9   | Pomodoro view + status                       | `pomodoro-view-status-desktop-light.png`           | 1440×900 | light |
| 10  | Declarative panel/action                     | `declarative-panel-action-desktop-light.png`       | 1280×900 | light |
| 11  | Mobile Settings Extensions category          | `settings-extensions-mobile-category-light.png`    | 390×844  | light |
| 12  | Mobile Settings Extensions detail            | `settings-extensions-mobile-detail-light.png`      | 390×844  | light |
| 13  | Pomodoro view + status (dark)                | `pomodoro-view-status-desktop-dark.png`            | 1440×900 | dark  |

Each scene records its legacy component and focused test authority in
`manifest.json`. Every scene uses `maxDiffPixelRatio: 0.01`.

## Authority gaps (behavior-only)

| Gap                                                                                   | Disposition                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy `contentType: "react"` guest components                                        | **Rejected** by Phase 7. Nearest visual authority is structured/declarative panel+action chrome (`declarative-panel-action-desktop-light`).                            |
| First-party Calendar/Matrix/Stats/Timeblocking/Someday/Completed/Cancelled/Quick Wins | Remain first-party Phase 2/3 surfaces; not rewrapped as plugins. Built-in list density may still show legacy labels where the Extensions tab historically listed them. |

## Deterministic protocol

- Legacy commit: `5e2b2b5adc865f401843c5030285293c5fabccc5`
- Capture harness: `scripts/capture-phase-7-legacy-visual-baseline.mjs` +
  `scripts/phase-7-legacy-visual-baseline/**` (ephemeral overlay only; never
  committed into the legacy repository)
- Frozen browser clock: `2026-08-04T15:00:00.000Z`
- Browser: Playwright Chromium, `deviceScaleFactor: 1`, `reducedMotion: reduce`,
  animations disabled at screenshot time
- Typography: Noto Sans via `system-ui` (Outfit/Google Fonts network blocked)
- Network: non-local requests aborted; no marketplace, registry CDN, or package
  download traffic
- Fixture data: synthetic demo copy and offline store fixtures only

## Acceptance rule

Wave 4 rewrite visual tests compare against these PNGs with
`maxDiffPixelRatio: 0.01` for every scene. Repository integrity is enforced by:

```bash
node scripts/check-phase7-legacy-visual-baseline.mjs
pnpm check:phase7-legacy-visual
node scripts/check-phase7-legacy-visual-baseline.mjs --self-check
```

The checker rejects missing/changed PNG hashes, wrong source commit, duplicate
scene IDs/files, non-`0.01` thresholds, orphan PNGs, harness/capture provenance
drift, missing `policy.rejects_node_vm_require_arbitrary_react`, and forbidden
secret/network strings. `--self-check` mutates temporary copies to prove those
rejection paths (wrong commit, PNG mutation, dimension mismatch, duplicate id,
wrong ratio, missing reject policy) without touching this authority directory.

## Capture command

Regenerate only from the pinned legacy checkout. Normal rewrite `pnpm test:e2e`
never writes to this directory.

```bash
export JUNBAN_LEGACY_ROOT=/absolute/path/to/Junban-legacy
node scripts/capture-phase-7-legacy-visual-baseline.mjs
node scripts/check-phase7-legacy-visual-baseline.mjs
node scripts/check-phase7-legacy-visual-baseline.mjs --self-check
```

The capture creates a clean detached temporary worktree at the pinned commit,
overlays the ephemeral harness (fixture mocks + Tailwind `@source` injection so
utilities used only by legacy components such as `sr-only` are emitted), renders
offline, writes PNGs + `manifest.json`, and removes the worktree. Untracked
`.junban-builtin-*` directories in any dirty legacy working tree are ignored
because capture never uses that checkout's dirty tree. Manifest provenance
hashes the unmodified legacy source bytes (pre-overlay), not the ephemeral
fixture copies.

## Privacy

Images contain only synthetic open-source demo copy. No real tokens, API keys,
hostnames from the operator profile, personal paths, or live registry
identifiers. PNG bytes and the manifest are scanned by the capture harness and
the repository checker.
