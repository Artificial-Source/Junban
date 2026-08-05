# Phase 4 dogfood report

- **Date:** 2026-08-02
- **Surface:** optimized Rust hosted server serving the production React build
- **Scope:** Settings parity and persistence, feature gates, task creation, JSON export, complete backup, restore cutover, required restart, and post-restart integrity
- **Result:** 1 issue found and fixed; 0 open reproducible issues

## Workflows exercised

1. Connected with a fragment access token and confirmed the token was scrubbed from the URL.
2. Opened the route-backed Settings dialog and traversed all eight desktop tabs.
3. Changed the confirmed theme to Nord and density to Compact, closed Settings, and confirmed runtime presentation changed.
4. Disabled daily planning, weekly review, and smart nudges, then confirmed their owning controls disappeared without deleting data.
5. Created a dated task through Quick Add and confirmed it appeared in Upcoming.
6. Exported JSON and created a complete backup through the Data tab.
7. Created post-backup state, restored the backup through the accessible in-DOM confirmation dialog, observed the restart-required state, restarted the Rust server, and confirmed the pre-backup task survived while post-backup state did not.
8. Checked browser console/errors during ordinary operation; no unexpected errors remained.

## Resolved finding

### P4-UI-DOG-001 — Successful restore showed a contradictory SSE failure banner

- **Severity:** Medium
- **Status:** Fixed
- **Observed:** A successful restore correctly showed “Restore cutover completed” and “Restart required”, but the intentional fail-closed server transition also surfaced the global “Event stream returned an invalid response. Retry” banner.
- **Expected:** Once the restore response authoritatively confirms `restart_required`, realtime reconnect and terminal-error UI should stop until reload.
- **Reproduction:**
  1. Open Settings → Data with an active authenticated session.
  2. Select a valid complete backup and confirm restore.
  3. Observe successful cutover and the contradictory SSE error banner in the pre-fix result.
- **Evidence:** `screenshots/issue-001b-step-1-data-tab.png`, `screenshots/issue-001b-step-2-confirm.png`, `screenshots/issue-001b-result.png`, and `videos/issue-001-first-attempt-repro.webm`.
- **Fix:** `WorkspaceContext.enterRestartRequired()` synchronously gates stale terminal callbacks, clears any existing SSE error, and disables the subscription only after a successful restart-required response. Failed restore attempts retain ordinary realtime behavior.
- **Regression evidence:** `src/ui/context/WorkspaceContext.restartRequired.test.tsx`; `src/ui/views/settings/DataTab.test.tsx`.
- **Fixed-state evidence:** `screenshots/issue-001-fixed.png` shows only the intended restart-required statuses, with no SSE retry banner.

## Additional evidence

- `screenshots/today.png`: authenticated normal runtime.
- `screenshots/appearance.png`: approved Appearance tab.
- `screenshots/nord-compact-runtime.png`: server-confirmed appearance consumed by runtime.
- `screenshots/task-created.png`: task workflow evidence.
- `screenshots/restore-confirm.png`: accessible restore confirmation.
- `screenshots/post-restore-restart.png`: restored state after a real server restart.
- `export.json` and `backup.junban-backup`: synthetic dogfood transfer artifacts used in the round trip.

An early automation attempt intentionally remained fail-closed while a prior browser download command had not released its request. It was not reproducible from a settled session and is not classified as a product finding; the clean end-to-end restore was repeated before and after the UI fix.
