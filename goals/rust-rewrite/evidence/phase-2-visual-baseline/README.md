# Phase 2 visual authority

These twelve images freeze the approved Phase 2 task-management presentation for
the exact feature set shipped in Phase 2. They were captured from the rewrite's
optimized Rust release server with the preserved React interface, verified
against the legacy presentation sources at
`Junban-legacy@5e2b2b5adc865f401843c5030285293c5fabccc5`.

The eight Phase 1 images in `../phase-1-visual-baseline/` remain immutable
historical anchors and are not modified by this evidence.

## Legacy presentation authority

The visual authority is the private archived `Junban-legacy` repository at
commit `5e2b2b5`. Each rewrite component consulted during capture carries a
header comment stating it preserves the exact legacy layout, spacing, icons, and
interaction affordances. The legacy presentation sources consulted are:

| Scene                       | Legacy source consulted                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Today with organization     | `src/ui/views/Today.tsx`, `src/ui/views/today/*`, `src/ui/components/TaskItem.tsx`                              |
| Inbox with organization     | `src/ui/views/Inbox.tsx`, `src/ui/components/TaskItem.tsx`                                                      |
| Upcoming                    | `src/ui/views/Upcoming.tsx`, `src/ui/components/OverdueSection.tsx`                                             |
| Project list and board      | `src/ui/views/Project.tsx`, `src/ui/views/Board.tsx`, `src/ui/views/project/*`                                  |
| Cancelled                   | `src/ui/views/Cancelled.tsx`                                                                                    |
| Task detail panel           | `src/ui/components/TaskDetailPanel.tsx`, `src/ui/components/task-detail/*`, `src/ui/components/task-metadata/*` |
| Filters & Labels            | `src/ui/views/FiltersLabels.tsx`, `src/ui/views/FilterView.tsx`, `src/ui/components/QueryBar.tsx`               |
| Command palette             | `src/ui/components/CommandPalette.tsx`                                                                          |
| Mobile drawer               | `src/ui/components/MobileDrawer.tsx`, `src/ui/components/BottomNavBar.tsx`                                      |
| Quick Add template selector | `src/ui/components/QuickAddModal.tsx`, `src/ui/components/TemplateSelector.tsx`                                 |

The rewrite rebinds these presentations to generated DTOs and the Rust
application API; it does not import legacy `src/core`, `src/application`,
`src/storage`, `src/db`, `src/parser`, `src/plugins`, or `ui/api/direct-services`.

## 12-scene matrix

| #   | Scene                                     | Baseline file                       | Viewport   | Theme |
| --- | ----------------------------------------- | ----------------------------------- | ---------- | ----- |
| 1   | Today with organization fields            | `today-org-desktop-light.png`       | 1440 × 900 | light |
| 2   | Inbox with organization fields            | `inbox-org-desktop-dark.png`        | 1440 × 900 | dark  |
| 3   | Today organization state                  | `today-org-mobile-light.png`        | 390 × 844  | light |
| 4   | Upcoming with overdue and future groups   | `upcoming-desktop-dark.png`         | 1440 × 900 | dark  |
| 5   | Project section list                      | `project-list-desktop-light.png`    | 1440 × 900 | light |
| 6   | Project board with three sections         | `project-board-nord.png`            | 1440 × 900 | Nord  |
| 7   | Cancelled grouped history with restore    | `cancelled-desktop-light.png`       | 1440 × 900 | light |
| 8   | Full task-detail panel                    | `task-detail-desktop-dark.png`      | 1440 × 900 | dark  |
| 9   | Filters & Labels plus saved-filter result | `filters-labels-desktop-dark.png`   | 1440 × 900 | dark  |
| 10  | Command palette                           | `command-palette-desktop-light.png` | 1440 × 900 | light |
| 11  | Open mobile drawer with project tree      | `mobile-drawer-dark.png`            | 390 × 844  | dark  |
| 12  | Quick Add with template selector open     | `quick-add-template-light.png`      | 1440 × 900 | light |

This is a hard maximum; functional, semantic, and accessibility tests protect
adjacent states rather than creating additional screenshot combinations.

## Deterministic protocol

- Capture date: 2026-07-29
- Frozen browser clock: `2026-07-23T10:30:00` (Thursday)
- Fixture dates are seeded relative to the server's real `as_of_date`, so
  server-side Today / Upcoming / overdue selection remains truthful; list DTO
  dates are then shifted to the frozen `2026-07-23` visual day after selection
- Browser: Playwright Chromium
- Typography: Noto Sans (system-ui resolves to Noto Sans; CI installs
  checksum-pinned `fonts-noto-core` and `fonts-noto-mono` and asserts
  `fc-match system-ui` = `Noto Sans`)
- Reduced motion: enabled via `prefers-reduced-motion: reduce`
- Desktop viewport: 1440 × 900
- Mobile viewport: 390 × 844
- Themes: light, dark, and Nord through the canonical `junban-theme` key
- Fresh disposable SQLite profile and synthetic token
- All organization state seeded through the authenticated Rust release-server
  API (`/api/v1/projects`, `/api/v1/sections`, `/api/v1/tags`, `/api/v1/tasks`,
  `/api/v1/templates`, `/api/v1/saved_filters`, comments, relations) — never
  through UI shortcuts
- Completed/cancelled task timestamps are normalized to fixed instants in the
  visual spec's response interception so Inbox recent-completion and Cancelled
  grouped-history are deterministic across runs

## Synthetic workspace

Three projects (Website Redesign — board, Documentation — list, Community —
list), five board sections, two Documentation sections, six tags, one template
with `{{variable}}` substitution, one saved filter, today/overdue/upcoming/inbox/
someday/completed/cancelled tasks, a rich task with Markdown description,
subtasks, comments, and a `blocks` relation, plus board and section tasks.

Full seed details are in `tests/e2e/phase2-seed.ts`.

## Acceptance rule

The Phase 2 Playwright spec captures the same twelve scenes with the same
clock, seed, viewport, theme, fonts, and reduced-motion setting. Each image is
compared against its corresponding file here using Playwright's per-pixel
threshold `0.2` and maximum differing-pixel ratio `0.01` (1%). Structural
assertions verify expected headings, task titles, navigation, and content
before each capture so hiding or blanking content cannot game the comparison.

A scene that exceeds the threshold blocks Phase 2. Updating these authority
images or accepting an intentional visible difference requires explicit user
approval; the rewrite may not silently bless its own output as the new baseline.

## Capture command

Baselines are regenerated only by an explicit update; normal `pnpm test:e2e`
never writes to this directory (the snapshot directory is gitignored).

```bash
# Build the release binary and frontend assets first
cargo build --release && pnpm build

# Capture (or update) the twelve Phase 2 baselines
npx playwright test visual-phase-2.spec.ts --project=visual-phase-2 --update-snapshots

# Copy generated snapshots to this evidence directory with clean names
for f in tests/e2e/visual-phase-2.spec.ts-snapshots/*.png; do
  base=$(basename "$f" | sed 's/-visual-phase-2-linux.png$/.png/')
  cp "$f" "goals/rust-rewrite/evidence/phase-2-visual-baseline/$base"
done
```
