# Phase 4 Settings visual authority

These ten images freeze the approved legacy Settings presentation before the Phase 4 parity repair. They are immutable review inputs, not rewrite-generated expected output.

- Source repository: private archived `Artificial-Source/Junban-legacy`
- Source commit: `5e2b2b5adc865f401843c5030285293c5fabccc5`
- Capture date: 2026-08-02
- Desktop viewport: 1280 × 900
- Mobile viewport: 390 × 844
- Browser: local Chromium through `agent-browser`
- Profile: fresh E2E SQLite profile with onboarding complete

The legacy product has no first-class Hosted or Diagnostics tabs. Per the Phase 4 context map, `hosted-desktop-dark-nearest-legacy-data.png` uses the dark legacy Data tab as the nearest Settings-shell authority, and `diagnostics-desktop-light-nearest-legacy-about.png` uses the light legacy About tab. Their content semantics are not authority for the new tabs; shell, navigation, typography, spacing, dialog, and responsive behavior are.

`features-desktop-light-legacy.png` captures the legacy Advanced tab, which is the approved presentation authority for the Phase 4 Features tab. AI, Voice, Extensions, and About remain hidden from the Phase 4 product even where visible in these legacy shell captures.

Tests must never update these PNGs. Fix production or explicit query-scoped fixture presentation instead. SHA-256 values and dimensions are pinned in `manifest.json`.
