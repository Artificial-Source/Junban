# Phase 3 visual authority

These twelve images freeze the approved legacy-rendered Phase 3 planning and
time surfaces. They were captured from the private `Junban-legacy` checkout at
`5e2b2b5adc865f401843c5030285293c5fabccc5`, not generated from the rewrite.

They are immutable historical evidence for Phase 3. The private legacy
repository is not required during CI after this capture. Updating these
authority images or accepting an intentional visible difference requires
explicit user approval; the rewrite may not silently bless its own output as
the new baseline.

The eight Phase 1 images in `../phase-1-visual-baseline/` and the twelve Phase 2
images in `../phase-2-visual-baseline/` remain immutable historical anchors and
are not modified by this evidence.

## 12-scene matrix

| #   | Scene                             | Baseline file                                | Viewport   | Theme |
| --- | --------------------------------- | -------------------------------------------- | ---------- | ----- |
| 1   | Calendar Day                      | `calendar-day-desktop-light.png`             | 1440 × 900 | light |
| 2   | Calendar Week                     | `calendar-week-desktop-dark.png`             | 1440 × 900 | dark  |
| 3   | Calendar Month                    | `calendar-month-mobile-light.png`            | 390 × 844  | light |
| 4   | Matrix desktop                    | `matrix-desktop-nord.png`                    | 1440 × 900 | Nord  |
| 5   | Plan My Day                       | `plan-my-day-desktop-light.png`              | 1440 × 900 | light |
| 6   | End of Day                        | `end-of-day-desktop-dark.png`                | 1440 × 900 | dark  |
| 7   | Weekly Review                     | `weekly-review-desktop-light.png`            | 1440 × 900 | light |
| 8   | Focus Mode                        | `focus-mobile-light.png`                     | 390 × 844  | light |
| 9   | Task reminder + recurrence detail | `task-reminder-recurrence-desktop-light.png` | 1440 × 900 | light |
| 10  | Stats + Smart Nudge toast         | `stats-smart-nudge-desktop-light.png`        | 1440 × 900 | light |
| 11  | Timeblocking Day with slots       | `timeblocking-day-slots-desktop-light.png`   | 1440 × 900 | light |
| 12  | Timeblocking Week                 | `timeblocking-week-desktop-dark.png`         | 1440 × 900 | dark  |

This is a hard maximum. Functional, semantic, and accessibility tests protect
adjacent states (Dopamine Menu, Eat the Frog, Task Jar, keyboard alternatives)
rather than creating additional screenshot combinations.

## Scene content

| Scene                    | Visible authority content                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Calendar Day             | Day mode, Thursday 2026-07-23 header, today's dated tasks with projects/priorities/tags   |
| Calendar Week            | Week mode 20–26 Jul 2026, multi-day task cards, dark theme                                |
| Calendar Month           | Month mode July 2026 on mobile chrome with bottom nav and day chips                       |
| Matrix                   | Four labelled quadrants (Do First / Schedule / Delegate / Eliminate), Nord theme          |
| Plan My Day              | Today header ritual modal step "Review Overdue" with overdue tasks and reschedule actions |
| End of Day               | Dark "Today's Wins" daily review step with completed counts and Next                      |
| Weekly Review            | Summary stats, daily completions chart, top accomplishments, neglected projects           |
| Focus Mode               | Full-shell mobile Focus Mode overlay with pending task, Complete/Skip controls            |
| Task reminder/recurrence | Task detail panel showing Reminder value and Weekly recurrence controls                   |
| Stats + Smart Nudge      | Productivity stats (Last 7 Days) plus overdue Smart Nudge toast                           |
| Timeblocking Day         | Day timeline with task blocks, multi-task Collaboration slot, task sidebar                |
| Timeblocking Week        | Week timeline with multi-day blocks, dark theme, Day/3D/5D/Week selector                  |

Built-in legacy plugins enabled for capture: `calendar`, `matrix`, `stats`,
`timeblocking`. Timeblocking was seeded through the real
`/api/plugins/timeblocking/rpc` bridge (blocks + slot membership), not mocked HTML.

## Deterministic protocol

- Capture date: 2026-07-30
- Legacy commit: `5e2b2b5adc865f401843c5030285293c5fabccc5`
- Frozen browser clock: `2026-07-23T10:30:00` (Thursday)
- Browser: Playwright Chromium
- Typography: Noto Sans (`fc-match system-ui` = Noto Sans); matches CI
  checksum-pinned `fonts-noto-core` / `fonts-noto-mono`
- Reduced motion: enabled via Playwright `reducedMotion: "reduce"` and
  `reduce_animations=true` setting
- Desktop viewport: 1440 × 900
- Mobile viewport: 390 × 844
- Themes: light, dark, and Nord through the canonical `junban-theme` key
- Fresh disposable SQLite profile and synthetic API token
  (`junban-phase3-visual-baseline-token`; never appears in images)
- Onboarding complete; Eat the Frog disabled; Smart Nudges enabled only for the
  overdue_alert rule used by the Stats scene
- Seed and capture harness: `scripts/capture-phase-3-visual-baseline.mjs` and
  `scripts/phase-3-visual-baseline/*`
- Task reminder uses a future wall instant (`2026-12-15T15:00:00.000Z`) so the
  live legacy delivery path cannot clear `remindAt` against real server time
  during capture; the browser clock remains frozen at 2026-07-23 for civil-day
  classification

## Acceptance rule

Phase 3 Playwright captures the same twelve scenes with the same clock, seed,
viewport, theme, fonts, and reduced-motion setting. Each image is compared
against its corresponding file here using Playwright's per-pixel threshold
`0.35` and maximum differing-pixel ratio `0.01` (1%). The ratio remains strict;
the per-pixel threshold absorbs text antialias variation measured between
otherwise identical pinned Linux browser/font environments. Structural assertions and
axe checks run separately so a tolerated antialiasing difference cannot hide
missing semantics.

A scene that exceeds the threshold blocks Phase 3. Updating these authority
images or accepting an intentional visible difference requires explicit user
approval.

## Capture command

Regenerate only from the pinned legacy checkout. Normal rewrite `pnpm test:e2e`
never writes to this directory.

```bash
# From a clean rewrite worktree based on the Phase 3 planning commit.
# Requires Node 22 available for legacy better-sqlite3 (JUNBAN_LEGACY_NODE),
# Noto Sans as system-ui, and the private legacy repo pinned at 5e2b2b5.
export JUNBAN_LEGACY_ROOT=/absolute/path/to/Junban-legacy
git -C "$JUNBAN_LEGACY_ROOT" checkout 5e2b2b5adc865f401843c5030285293c5fabccc5

node scripts/capture-phase-3-visual-baseline.mjs
```

The harness starts legacy `dev:full` against a private disposable database,
seeds synthetic workspace data through supported API paths (including
timeblocking RPC), freezes the browser clock, captures the twelve scenes, verifies
PNG dimensions, and scans for the synthetic token string.

## Privacy

Images contain only synthetic open-source demo copy (Website Redesign,
Documentation, Community, plugin/docs tasks). No real tokens, usernames, machine
paths, emails, or personal data. Inspected at full size after capture; PNG
dimensions and a token privacy scan are enforced by the capture harness.
