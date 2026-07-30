# Accessibility

Junban preserves the approved interface, including its accessibility behavior. This document is the standing accessibility contract for rewrite phases that touch the UI.

## Requirements

- Keyboard-only use must remain viable for implemented flows.
- Focus visibility must remain clear.
- Support light, dark, and Nord themes without losing contrast expectations from the approved design.
- Honor reduced-motion and forced-colors where the approved UI already does.
- Interactive controls need accessible names and roles; do not remove semantics while porting components.
- Modal dialogs and drawers trap Tab and Shift+Tab focus, close on Escape, restore the opener focus when closed, and make the complete background shell inert to keyboard and assistive technology while open.
- Shell isolation follows an actually rendered blocking layer rather than selection state; toast live regions remain outside isolation so status announcements and Undo stay available over dialogs.
- Screen-reader-meaningful labels, headings, and live updates stay intact for ported views.
- Search and palette use labelled dialog/listbox semantics with one interactive surface per option.
- List and board movement have keyboard paths; modifier+Space supports bulk range selection; bulk Move/Tag menus provide arrow, Home, End, Escape, and trigger-focus restoration.
- The bulk bar is a named region and pending mutations expose busy/status feedback.

## Validation posture

- Phase 0 establishes tooling only; no product UI is claimed.
- Representative desktop and mobile scenes run axe with zero serious/critical findings, plus structural tests for skip navigation, narrow viewports, task-entry keyboard behavior, full-shell modal isolation/focus restoration, platform shortcuts, list/board keyboard movement, bulk selection, and menu keyboard behavior.
- Visible design changes, including spacing or control chrome that affect accessibility, require explicit user approval.

## Ownership

Frontend changes that affect behavior, semantics, or visuals need the frontend/accessibility review checkpoint described in [`../PLANS.md`](../PLANS.md).
