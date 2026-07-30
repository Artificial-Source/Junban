# Phase 2 Dogfood Report

- Target: `http://127.0.0.1:4277`
- Scope: Phase 2 complete task management
- Status: complete — all findings fixed and retested

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 1 (fixed) |
| Medium | 5 (fixed) |
| Low | 0 |

## Findings

### ISSUE-006 — Task creation wedges across a temporary server outage

- **Severity:** High
- **Area:** Reliability / Tailnet recovery
- **Status:** Fixed in `dcc9e19`
- **Reproduction:** With Today open, stop the Rust server, submit a task, then restart the server.
- **Expected:** The request fails within a bounded time, the draft remains editable, an actionable error is announced, and Retry succeeds after the server returns.
- **Actual:** The input enters an indefinite busy state with no error or Retry control. It remains stuck after the server is healthy again; recovery requires a page reload, which discards the draft ([screenshot](screenshots/issue-006-offline-submit-stuck.png)).
- **Impact:** A routine Tailnet/server restart can block the primary task-capture workflow and lose the user's typed task during recovery.
- **Repro Video:** [issue-006-repro.webm](videos/issue-006-repro.webm)
- **Resolution:** Finite API calls now have an 8-second retryable timeout while SSE remains unbounded. The draft becomes editable with a visible Retry action, and retry after reconnection succeeds ([retest](screenshots/issue-006-fixed-retry.png)). Focused client and `TaskInput` tests cover hanging fetches, same-key retries, outcome-unknown, draft preservation, and SSE exemption.

### ISSUE-001 — Quick Add advertises `p1`–`p4` priority syntax but saves it in the title

- **Severity:** Medium
- **Area:** Quick Add / natural-language parsing
- **Status:** Fixed in `dcc9e19`
- **Reproduction:**
  1. On mobile Today, open Quick Add ([step 1](screenshots/issue-001-3-step-1.png)).
  2. Enter `Dogfood priority today p2` using the placeholder's documented `p1` style ([step 2](screenshots/issue-001-3-step-2.png)).
  3. Submit. `today` is parsed, but `p2` remains in the visible task title and priority is not applied ([result](screenshots/issue-001-3-result.png)).
- **Expected:** The advertised `p2` token is removed from the title and applies priority 2, matching the legacy parser and placeholder.
- **Actual:** The task is titled `Dogfood priority p2`.
- **Repro Video:** [issue-001-repro-3.webm](videos/issue-001-repro-3.webm)
- **Resolution:** The Rust parser now accepts standalone case-insensitive `p1`–`p4` tokens while preserving `!1`–`!4` and rejecting embedded/malformed lookalikes. Live retest returned title `Dogfood priority` and priority `2` ([response](issue-001-fixed-response.json)).

### ISSUE-002 — Applying a variable template creates a task with unresolved `{{variable}}` text

- **Severity:** Medium
- **Area:** Templates / Quick Add
- **Status:** Fixed in `dcc9e19`
- **Reproduction:**
  1. Create template `Release checklist` with title `Prepare {{thing}}` in Filters & Labels.
  2. Open Quick Add and expand Templates ([step 1](screenshots/issue-002-step-1.png), [step 2](screenshots/issue-002-step-2.png)).
  3. Apply `Release checklist` and open Inbox.
  4. The created task is literally titled `Prepare {{thing}}` ([result](screenshots/issue-002-result.png)).
- **Expected:** Quick Add asks for `thing` before applying and substitutes the value, as the UI's placeholder guidance promises.
- **Actual:** No variable form is shown and raw placeholder text is persisted. Repeated applications create repeated malformed tasks.
- **Repro Video:** [issue-002-repro.webm](videos/issue-002-repro.webm)
- **Resolution:** Quick Add detects unique placeholders, presents accessible required inputs, and sends the existing variable payload. Live retest created `Prepare release docs` ([retest](screenshots/issue-002-fixed-template-variable.png)); variable-free behavior remains immediate.

### ISSUE-003 — Activity stays stale after actions performed in the open task panel

- **Severity:** Medium
- **Area:** Task detail / Activity
- **Status:** Fixed in `dcc9e19`
- **Reproduction:**
  1. Open a task and add a comment; the new comment appears immediately ([comment added](screenshots/issue-003-comment-added.png)).
  2. Switch to Activity without closing the task panel.
  3. The new `updated · comment` event is absent ([stale activity](screenshots/issue-003-stale-activity.png)).
  4. Close and reopen the same task, then open Activity; the missing event now appears ([after reopen](screenshots/issue-003-after-reopen.png)).
- **Expected:** Selecting Activity or successfully mutating the task refreshes its activity list.
- **Actual:** Activity is fetched only when the task ID changes, so it remains stale until the panel is reopened.
- **Repro Video:** [issue-003-activity-repro.webm](videos/issue-003-activity-repro.webm)
- **Resolution:** Related-resource mutations reload authoritative activity, and opening Activity refreshes it again without touching dirty task/comment drafts. Live retest displayed `updated · comment` immediately ([retest](screenshots/issue-003-fixed-activity.png)).

### ISSUE-004 — Advertised Ctrl shortcuts do nothing on Linux/Windows

- **Severity:** Medium
- **Area:** Keyboard shortcuts / cross-platform UX
- **Status:** Fixed in `dcc9e19`
- **Reproduction:**
  1. On Linux, open the desktop UI where Search advertises `Ctrl+K` ([before](screenshots/issue-004-before.png)).
  2. Press `Ctrl+K`.
  3. No search dialog opens ([after Ctrl+K](screenshots/issue-004-after-ctrl-k.png)).
  4. Click Search; the dialog opens normally ([click Search](screenshots/issue-004-click-search.png)). `Ctrl+Z` likewise does not trigger Undo.
- **Expected:** The displayed `Ctrl` shortcuts work on Linux and Windows, with `Cmd` equivalents on macOS.
- **Actual:** Shortcut normalization rejects every Control-modified key and commands are registered only as `cmd+…`.
- **Repro Video:** [issue-004-repro.webm](videos/issue-004-repro.webm)
- **Resolution:** The platform-primary accelerator now maps configured `cmd+…` shortcuts to Meta on Apple platforms and Control elsewhere, rejecting Alt/wrong modifiers and typing targets. Live Linux `Ctrl+K` opened Search; focused tests cover both platform families.

### ISSUE-005 — Today exposes nonfunctional later-phase controls

- **Severity:** Medium
- **Area:** Today / scope integrity
- **Status:** Fixed in `dcc9e19`
- **Reproduction:** Open Today on desktop.
- **Expected:** Later-phase planning controls remain hidden until Phase 3, as the approved Phase 2 scope requires.
- **Actual:** `Plan My Day (unavailable)` and `End of Day (unavailable)` are visible but disabled ([screenshot](screenshots/issue-005-disabled-later-phase-controls.png)).
- **Impact:** The primary daily screen advertises actions that cannot work and presents unfinished functionality to users.
- **Resolution:** Both Phase 3 controls are absent from the Phase 2 Today header; tests assert their absence.

## Passed surfaces

- Auth bootstrap and protected API access
- Today, Inbox, Upcoming, Someday, Completed, and Cancelled views
- Task create/edit/complete/uncomplete/cancel/delete
- Projects, sections, board movement, tags, templates, saved filters, comments, hierarchy, and relations
- Undo plus replay-safe duplicate submission and stale-revision conflict handling
- Multi-client SSE convergence and authenticated reconnect
- Mobile navigation, Quick Add, deep-linked task detail, and browser back behavior
- Offline recovery with preserved draft and explicit retry
- Live cross-platform keyboard shortcut behavior

## Validation performed

Targeted regression checks were run after each remediation. Final integrated closure then passed:

- `pnpm test` — 124 frontend tests;
- `pnpm test:e2e` — 35 browser checks;
- `pnpm build`, `pnpm typecheck`, and `pnpm lint`;
- `cargo test --locked --workspace --all-targets --all-features` — 146 Rust tests;
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`;
- authenticated restart/persistence, shared-client SSE and reconnect dogfood;
- the 12-scene Phase 2 visual comparison suite.

Representative multi-client evidence: [live peer convergence](screenshots/multi-client-peer-convergence.png) and [reconnect convergence](screenshots/reconnect-peer-convergence.png).

The dedicated visual authorities live under `goals/rust-rewrite/evidence/phase-2-visual-baseline/`; this directory retains issue reproduction and fixed-state dogfood evidence. No production-data exposure, retained background runtime, or unreverted host change was found during cleanup.
