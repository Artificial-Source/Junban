# Phase 1 visual authority

These eight images freeze the approved legacy-rendered Today and Inbox shell for the exact Phase 1 field set. They were captured from the private `Junban-legacy` checkout at `5e2b2b5adc865f401843c5030285293c5fabccc5`, not generated from the rewrite.

## Deterministic protocol

- Capture date: 2026-07-28
- Frozen browser clock: `2026-07-23T10:30:00` (Thursday)
- Browser: Playwright Chromium
- Reduced motion: enabled
- Desktop viewport: 1440 × 900
- Mobile viewport: 390 × 844
- Themes: light and dark through the canonical `junban-theme` key
- Fresh disposable SQLite profile and synthetic token
- Onboarding complete, reduced animations enabled, Eat the Frog disabled

Synthetic tasks:

| Title                               | State                             | Civil due date |
| ----------------------------------- | --------------------------------- | -------------- |
| Review accessibility audit findings | pending                           | 2026-07-23     |
| Write release notes                 | pending                           | 2026-07-23     |
| Update onboarding copy              | pending                           | 2026-07-22     |
| Buy milk                            | pending                           | none           |
| Completed setup checklist           | completed at 2026-07-23T09:00:00Z | none           |

No project, priority, tag, description, reminder, recurrence, duration, or later-phase field is present. This makes the images authoritative for the subset Phase 1 actually implements rather than for omitted future features.

## Acceptance rule

Phase 1 Playwright captures the same eight scenes with the same clock, seed, viewport, theme, fonts, and reduced-motion setting. Each image is compared against its corresponding file here using Playwright's per-pixel threshold `0.2` and maximum differing-pixel ratio `0.01` (1%). Structural assertions and axe checks run separately so a tolerated antialiasing difference cannot hide missing semantics.

A scene that exceeds the threshold blocks Phase 1. Updating these authority images or accepting an intentional visible difference requires explicit user approval; the rewrite may not silently bless its own output as the new baseline.
