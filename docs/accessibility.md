# Accessibility

Junban preserves the approved interface, including its accessibility behavior. This document is the standing accessibility contract for rewrite phases that touch the UI.

## Requirements

- Keyboard-only use must remain viable for implemented flows.
- Focus visibility must remain clear.
- Support light, dark, and Nord themes without losing contrast expectations from the approved design.
- Honor reduced-motion and forced-colors where the approved UI already does.
- Interactive controls need accessible names and roles; do not remove semantics while porting components.
- Modal dialogs trap Tab and Shift+Tab focus, close on Escape, and restore the opener focus when closed.
- Screen-reader-meaningful labels, headings, and live updates stay intact for ported views.

## Validation posture

- Phase 0 establishes tooling only; no product UI is claimed.
- From the first UI-bearing phase, representative desktop and mobile scenes get automated accessibility checks (for example axe) plus manual keyboard review for new flows.
- Visible design changes, including spacing or control chrome that affect accessibility, require explicit user approval.

## Ownership

Frontend changes that affect behavior, semantics, or visuals need the frontend/accessibility review checkpoint described in [`../PLANS.md`](../PLANS.md).
