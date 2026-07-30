# Phase 3 context map — planning and time

Status: approved implementation authority

This map defines the smallest complete Phase 3 extension of the shipped Rust architecture. It was synthesized from the active repository, the private archived implementation at `Junban-legacy@5e2b2b5` as a behavioral and visual oracle, current Jiff/Tokio/SQLite research, and the rewrite ExecPlan. It does not authorize copying the legacy backend.

## Outcome

Phase 3 adds recurrence occurrence generation and safe reversal, durable reminders and delivery, Calendar, Matrix, planning/review rituals, workload capacity, Focus Mode, motivation tools, Smart Nudges, Stats, and first-party timeblocking. The approved React appearance remains unchanged. Every authority-bearing runtime remains Rust; no shipped path launches Node.

## Architecture freeze

Keep the four crates and their existing dependency direction:

```text
junban-domain -> junban-app -> junban-storage -> junban-server -> React over HTTP/SSE
```

- `junban-domain`: pure recurrence/time rules, reminder/timeblock values, and planning/nudge calculations.
- `junban-app`: use cases, ports, request/result shapes, and user-visible events. It does not know SQLite or Axum.
- `junban-storage`: schema v3 and all durable mutation/query authority on the existing single SQLite worker.
- `junban-server`: authenticated Axum routes, OpenAPI, SSE, browser reminder-delivery protocol, and one shutdown-bound wake loop.
- `src/ui`: preserved presentation and API orchestration only.

Do not add a scheduler crate, task queue framework, cron/RRULE engine, SQLite pool, second database owner, or browser domain authority. One bounded Tokio wake loop asks app use cases what is due; SQLite remains durable truth. Optional work stays idle when unused.

## Dependency decision

Add no recurrence or scheduling crate. Extend Jiff 0.2 only with the minimum system-timezone capability needed for real IANA/DST evaluation. Use Jiff civil `Date`/`Time` for floating values and `Zoned`/`Timestamp` for instants. Use existing Tokio primitives for one wake task. Do not add `rrule`, `recurring`, `croner`, `tokio-cron-scheduler`, `chrono`, `chrono-tz`, or a bundled timezone database without measured evidence.

The current recurrence grammar remains authoritative:

`daily | weekly | monthly | yearly | weekdays | every N day(s) | every N week(s)`

RRULE is not accepted in Phase 3.

## Frozen product decisions

1. Add a thin schema-v3 `app_settings` authority for only Phase 3 temporal keys: notification channels, reminder defaults, capacity, work hours, week start, and nudge rules. Phase 4 owns the complete Settings screen, transfer, and backup behavior.
2. Generated task occurrences use UUID-v7 IDs plus a unique source-lineage invariant. Persist the completion operation ID on changed tasks so ordinary uncomplete can locate exact durable authority without inventing a second history system.
3. Persist an explicit monthly anchor day. Jan 31 -> February clamp -> Mar 31 survives an intact lineage. A manual due-date, representation, or recurrence-rule change resets the anchor to that occurrence.
4. Persist timeblocks and timeslots as local civil date/time + IANA timezone with bounded optional recurrence. Query expansion is virtual and bounded; it does not materialize years of instances.
5. Calendar uses a dedicated date-range API and never fetches all paginated tasks at 10,000-task scale.
6. Planning/review dialog selection state is session-local; resulting task mutations are durable. Stats starts as server-authoritative derived queries over tasks/activity. Aggregate tables require failed measured budgets.
7. Reminder terminal audit retention is 90 days, 2,000 rows, and 2 MiB. Current task intents and active occurrences are never removed by compaction.
8. Matrix drops use the one server-local civil date sampled for the request.
9. Weekly Review covers the prior complete week. Daily Planning exclusions remain session-local. Focus Mode contains all pending tasks. Daily Review uses configured capacity rather than a hard-coded 480 minutes.
10. Empty-today and overdue nudges may both fire. Stale tasks are oldest-first. Server evaluates nudge facts; browser session state owns dismissals.
11. Stats has one Rust-derived authority. Yearly Feb 29 recurrence rolls to Mar 1 in non-leap years, matching the preserved product contract.
12. First-party routes are `/calendar`, `/matrix`, `/stats`, `/dopamine-menu`, and `/timeblocking`; Focus Mode remains an overlay/query state. AI auto-scheduling is absent until Phase 6.
13. Prefer native pointer/keyboard interactions already used by Board. Add no drag library unless acceptance tests prove the native implementation inadequate.
14. Stats and weekly review are always first-party; they never depend on plugin enablement.

## Temporal authority and recurrence transition table

One server-local civil date, current instant, and system timezone are sampled at each use-case boundary and passed downward. Domain code never calls the system clock independently.

| Source shape                   | Next occurrence basis                       | Result                                                                                                                                                           | Reminder/deadline behavior                                                                |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `due_date`, no `due_time`      | Stored civil due date                       | Advance exactly one rule interval and remain date-only. An overdue source does not skip intervals.                                                               | Preserve elapsed offsets from server-zone start-of-day when an offset exists.             |
| `due_date` + `due_time` + zone | Stored civil date, wall time, and IANA zone | Advance the civil date and preserve wall time/zone. A nonexistent target moves forward by the DST gap; an ambiguous target uses the earlier offset consistently. | Preserve elapsed reminder-before-due and deadline-after-due offsets across DST.           |
| No due date                    | Sampled server-local completion date        | Advance one interval from that date and create a date-only due date.                                                                                             | Clear source absolute reminder/deadline because no meaningful due-relative offset exists. |
| Monthly                        | Persisted anchor day                        | Clamp short months but retain the anchor for later months.                                                                                                       | Preserve offsets from the resolved due value.                                             |
| Yearly Feb 29                  | Stored civil date                           | Mar 1 in non-leap years; Feb 29 in the next leap year while lineage remains intact.                                                                              | Preserve offsets from the resolved due value.                                             |
| Weekdays                       | Stored/sampled civil date                   | Friday and Saturday advance to Monday; Sunday advances to Monday.                                                                                                | Same offset rules as the source shape.                                                    |

Completing a pending recurring task marks the source complete and creates exactly one next pending occurrence. The next task copies title, description, priority, project, section, recurrence rule, estimate, someday state, tags, and due-relative temporal values. It is top-level rather than copying a parent link. Each pending recurring descendant completed by an allowed cascade receives its own next occurrence in the same transaction. Overlapping bulk roots are deduplicated before the 500 affected-task ceiling is applied.

One user mutation produces one revision, event, summary, and receipt. Exact retry replays exact bytes without generating again. A unique lineage constraint prevents two children for one source occurrence.

Ordinary uncomplete and operation undo are distinct APIs but share exact authority:

- Completion stores the operation ID on every changed task and the receipt owns generated snapshots and reminder transitions.
- If the retained receipt exists, ordinary uncomplete runs the same exact reversal as operation undo. It restores the entire owned cascade and removes only matching receipt-owned generated occurrences with no children, changed sidecars, or new references. Any divergence conflicts atomically and leaves everything unchanged.
- If durable authority has expired or is unavailable, ordinary uncomplete performs a conservative source-only reopen and never guesses at or deletes generated work. The response explicitly reports `source_only` so the UI does not claim full reversal.
- Replaying either exact reversal is idempotent. An independently absent owned occurrence is acceptable only when no replacement lineage owner or dependent state exists.

Monthly anchor, recurrence lineage, completion operation IDs, reminder transitions, tags, and generated snapshots are receipt material and remain within the 4 MiB ceiling.

## Reminder authority and lifecycle

Task intent stores a UTC `remind_at` instant. User task mutations reconcile the corresponding durable occurrence in the same task transaction and follow the normal revision/event/receipt invariant.

Reminder coordination is explicitly control-plane state, not a user/domain mutation:

- Lease acquire/renew/release, claim, acknowledgement, failure, and retention bookkeeping use short SQLite transactions on the same worker but create no global user revision, activity, SSE task event, undo record, or general operation receipt.
- One owner lease expires after 90 seconds and renews about every 30 seconds. Acquisition returns an opaque server-issued fencing term. Renew, claim, acknowledge, fail, and release require the current unexpired term; a stale owner cannot settle work after another owner acquires the lease.
- Claims default to 20, cap at 100, and expire after 90 seconds. Durable acknowledgement is idempotent for task+instant+channel. External browser/OS presentation is at-least-once across the acceptance-before-ack crash window unless a channel supplies its own dedupe key.
- Failure backoff starts at 30 seconds and caps at one hour. Stored channels are an allowlisted enum. Stored errors are bounded codes only (`permission_denied`, `temporarily_unavailable`, `channel_failed`, `owner_lost`); arbitrary external messages, titles, descriptions, tokens, and fencing terms are never logged or persisted as diagnostics.
- Editing, clearing, completing, cancelling, or deleting a task suppresses/cancels pending intent without a delivery storm. Restoring an exact undelivered intent returns it to pending. A matching delivered task+instant remains terminal.
- Browser delivery supports in-app toast, Web Notification when granted, and configured sound. Phase 8 native delivery uses the same contract.

The server owns exactly one scheduler loop after storage opens. It queries the earliest pending due time, sleeps until that time, and can be woken through `tokio::sync::Notify` after reminder-affecting commits. With no pending reminder it waits without polling. When work becomes due it publishes only a content-free `reminders_due` SSE signal. An eligible browser with authoritative settings acquires the fenced delivery lease, claims work, resolves task presentation through authenticated reads, presents configured channels, and settles each claim.

Shutdown cancels the scheduler token, wakes its `Notify`, awaits its join and any one bounded in-flight repository call, then closes SSE, the SQLite worker, and the profile lock. Lifecycle tests prove no detached task retains the repository or lock.

## Schema-v3 and migration recovery

Expected additive durable shape:

- `tasks`: `remind_at`, `recurrence_anchor_day`, `recurrence_source_id`, and `completion_operation_id`, with indexes and unique lineage ownership.
- `app_settings`: allowlisted Phase 3 temporal keys only.
- `reminder_occurrences`: task/instant identity, state, fence-bound claim, attempts/backoff, terminal channel/error code, and timestamps.
- `reminder_delivery_lease`: one global owner row with expiry and opaque fencing term.
- `time_blocks`: task/slot link, title, civil date/start/end, timezone, color, lock flag, recurrence rule/parent, timestamps, revision.
- `time_slots`: title, optional project, civil date/start/end, timezone, color, recurrence rule/parent, timestamps, revision.
- `time_slot_tasks`: slot/task/position, unique per slot/task, maximum 100 tasks per slot.

Timeblock/slot/task-membership user mutations follow one transaction -> one revision/event/summary/receipt. Slot add/remove/reorder is conflict-checked and bounded by the existing 500 affected-identity ceiling. Virtual recurring instances are read models; Phase 3 edits the owning series because the preserved UI has no independent exception model.

Before migrating an existing v2 database, while holding the profile lock:

1. Create `backups/pre-migration/pre-v2-<UTC timestamp>.sqlite3` with private permissions using SQLite backup authority after a WAL checkpoint.
2. Open the backup read-only, require schema version 2, and require `PRAGMA integrity_check` to return `ok`.
3. Only then run the v3 migration in one immediate transaction.
4. On injected or real failure, rollback and leave v2 authoritative; retain the verified backup and allow an exact retry.
5. After successful migration, retain the newest three verified pre-migration backups and prune older ones only after the new backup and migrated database both reopen successfully.

Fresh databases do not create a migration backup. Tests cover successful v2->v3, injected rollback, backup integrity/reopen, permissions, retry, and future-version rejection.

## Numeric API and benchmark bounds

These public bounds are frozen before implementation:

| Read/operation             |                                                      Bound | Overflow behavior                                                        |
| -------------------------- | ---------------------------------------------------------: | ------------------------------------------------------------------------ |
| Calendar task range        |                       42 inclusive civil days; 2,000 tasks | Reject with structured `RESULT_LIMIT_EXCEEDED`; never truncate silently. |
| Timeblock/slot range       | 42 inclusive civil days; 2,000 expanded instances combined | Reject before serialization.                                             |
| Recurrence expansion       |                       2,000 virtual instances per response | Reject the whole read.                                                   |
| Stats                      |        366 inclusive civil days; at most 366 daily buckets | Return aggregates only, never raw unbounded tasks.                       |
| Planning/review candidates |                                                  500 tasks | Reject broader mutation selection; read UI may page.                     |
| Nudges                     |                             20 tasks per rule; 50 combined | Deterministic ordering and explicit `has_more`.                          |
| Reminder claims            |                                    default 20; maximum 100 | Reject larger claims.                                                    |
| Slot membership            |                                         100 tasks per slot | Reject before mutation.                                                  |

The deterministic 10,000-task benchmark declares these local release-build p95 budgets before measurement:

- 42-day Calendar query: <= 100 ms.
- 42-day blocks/slots expansion: <= 100 ms.
- 366-day Stats query: <= 150 ms.
- complete + generate one recurring occurrence: <= 100 ms.
- complete + exact reverse 500 recurring sources: <= 1,000 ms each direction.
- all nudge rules: <= 100 ms.
- reminder lease + 20-row claim: <= 50 ms.
- hosted memory with idle scheduler: <= 24 MiB warm and <= 32 MiB peak.

Measure p50/p95, response counts, revision/event deltas, SQL/work counters where relevant, and peak cgroup memory. Thresholds are not relaxed after seeing results without a recorded design decision.

## Rust/API seams

### Domain

Add bounded recurrence, reminder, timeblock, slot, and nudge/planning modules. Unit/property tests cover DST gaps/repeats, month-end, leap years, weekdays, no-due and overdue bases, invalid zones, limits, and deterministic pure evaluation.

### App/storage

Extend the repository and service rather than bypassing them. Recurring complete/uncomplete remains the task mutation path. Add reminder intent and fenced coordination operations; timeblock/slot CRUD, membership/range/replan operations; and bounded planning/stats/nudge reads. Only user-facing mutations create revisions/events/receipts.

### Server

Extend generated OpenAPI with task recurrence/reminder fields and snooze/clear operations; bounded Calendar queries; fenced reminder acquire/renew/claim/delivered/failed operations; timeblock/slot CRUD/range/move/resize/replan/membership operations; and server-derived planning/nudge/capacity/stats reads. All routes remain authenticated except health/static bootstrap, use existing host/origin/body/rate limits, and expose no secrets. SSE carries typed snapshots when small and explicit resync scopes otherwise.

## Preserved frontend and immutable authority

Before frontend implementation, capture and commit twelve legacy-rendered Phase 3 authority scenes under `goals/rust-rewrite/evidence/phase-3-visual-baseline/`. The private legacy repository is never needed during CI after capture.

Authority metadata:

- Legacy commit: `5e2b2b5adc865f401843c5030285293c5fabccc5`.
- Fixed clock and deterministic seed documented beside the images.
- Noto Sans environment matching CI, reduced motion enabled.
- Desktop 1440x900 and mobile 390x844.
- Light/dark plus one Nord scene.
- Playwright threshold `0.2`, maximum differing-pixel ratio `0.01`.
- Structural, keyboard, and axe checks remain separate from pixel comparison.
- Any intentional visible difference requires explicit user approval; the rewrite may not bless its own render as authority.

The twelve scenes are: Calendar Day light, Calendar Week dark, Calendar Month mobile, Matrix desktop, Plan My Day, End of Day dark, Weekly Review, Focus mobile, task reminder/recurrence detail, Stats + Smart Nudge, Timeblocking Day with slots, and Timeblocking Week dark. Dopamine/Eat-the-Frog/Task-Jar are covered by structural/axe behavior unless a scene replaces a redundant authority during capture without increasing the count.

Presentation authority includes Calendar day/week/month; Matrix quadrants; Today planning/review/capacity chrome; Focus Mode, Eat the Frog, Task Jar, Dopamine Menu, Stats; reminder/recurrence controls and Smart Nudge toast; and the legacy Timeblocking presentation promoted into a first-party view.

Reuse current shell, themes, fonts, task rows, overlays, focus trap, reduced motion, command palette, and API facade. Never import legacy core/application/storage/database/plugin runtime/Vite API/direct-service/AI/sql.js/Node code.

Behavior anchors:

- Plan My Day / End of Day / Weekly Review header controls remain large-desktop only.
- Calendar retains Day/Week/Month, previous/Today/next, week-start setting, day click to Day, completion/open actions, and dense mobile layout.
- Matrix remains four labelled regions, two columns desktop/one mobile, with pointer and keyboard moves through one mutation.
- Focus Mode is a full-shell modal with trap, safe Escape, restoration, pending/error states, and all-pending sequence.
- Planning/review dialogs trap and restore focus, expose pending failures, and never close before awaited mutations settle.
- Timeblocking retains day/week timeline, task sidebar, move/resize, keyboard alternatives, slots with ordered tasks, replan banner, recurrence editor, focus integration, and settings popover. AI proposals are absent.
- Full Settings, native shell behavior, AI/voice, and plugin runtime remain later phases.

Every overlay makes the background inert only while a rendered blocking layer exists. Drag/resize/move has keyboard alternatives and live announcements. Reminder controls have explicit names and live outcomes. Reduced motion applies to timelines and overlays.

## Implementation waves

1. Capture immutable legacy visual authority and commit benchmark thresholds.
2. Pure recurrence engine and timezone matrix.
3. Owner-locked verified pre-migration backup plus schema v3 task/reminder/settings/block/slot migration.
4. Recurring complete/uncomplete, bulk behavior, exact receipts and safe fallback.
5. Fenced reminder reconcile/lease/claim/settle, scheduler lifecycle, and browser delivery.
6. Bounded Calendar API plus Calendar/Matrix presentation.
7. Focus, motivation, Stats, capacity, and nudge evaluation.
8. Daily/weekly planning and review rituals.
9. First-party blocks, slots, membership, recurrence, move/resize/replan, and Focus integration.
10. OpenAPI/SSE convergence, multi-client/crash/restart hardening, temporal scale/memory evidence, docs, specialist review, and one clean phase commit.

Dependent waves use the same coder when practical. Parallel workers own non-overlapping files only from a clean committed base.

## Acceptance

- All recurrence shapes pass date-only, wall-time/DST, no-due, overdue, month-end, weekday, leap, retry, bulk, ordinary-uncomplete, exact-undo, expiry fallback, and conflict tests.
- Migration never starts before a private verified backup; rollback/retry/future-version tests pass.
- Reminder durable settlement is idempotent, stale fence terms fail closed, external at-least-once behavior is documented, coordination does not churn user revisions, and shutdown leaves no owner task or lock.
- Calendar/Matrix/planning/focus/motivation/nudges/stats/blocks/slots are functional with approved visuals and keyboard/AT operation.
- Multi-client effects converge monotonically and every numeric bound rejects safely.
- The predeclared temporal benchmark and 24/32 MiB hosted memory limits pass.
- No resident Node process or second live database exists.
- Formatting, lint, type, unit/integration, OpenAPI, visual, axe, security, supply-chain, and process-lifecycle checks pass.

## Planning gate

The initial independent gate rejected six material ambiguities. `P3-REC-001`, `P3-REM-001`, `P3-MIG-001`, `P3-TIME-001`, `P3-BOUND-001`, and `P3-UI-001` were fixed in this map and a focused recheck approved all six with no blocker. Material implementation changes to these frozen contracts require updating the map and ExecPlan before code changes.
