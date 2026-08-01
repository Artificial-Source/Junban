# Phase 3 implementation contract

This file turns the approved authority in `phase-3-context-map.md` into the smallest concrete app, storage, server, and UI behavior needed for the remaining Phase 3 waves. The private legacy repository at commit `5e2b2b5` is a behavior and presentation oracle only. It is not an architecture source.

## Shared temporal rules

- Sample the server-local civil date, current instant, and system timezone once per use case. Pass those values into domain and storage logic.
- Date-only values remain civil dates and are never shifted through UTC.
- Use Jiff and the existing hand-written recurrence grammar. Do not add cron, RRULE, scheduling, drag-and-drop, or timezone-database dependencies.
- Range reads are bounded: Calendar and timeblocking at 42 inclusive civil days and 2,000 returned items; stats at 366 days.
- Planning selection is bounded at 500 tasks. Time-slot membership is bounded at 100 tasks.

## Reminders

Task `remind_at` is user intent. The matching occurrence row is reconciled in the same task mutation transaction.

Lease, claim, acknowledgement, failure, and retention are control-plane writes. They do not create a user revision, task activity, undo material, a general operation receipt, or a revisioned task event.

- One opaque fenced lease lasts 90 seconds and renews around every 30 seconds.
- Claims default to 20, cap at 100, and last 90 seconds.
- A current owner recovers its still-claimed batch before claiming new work.
- Expired owner claims become retryable with bounded 30-second-to-one-hour backoff and the allowlisted `owner_lost` code.
- Stale terms cannot claim or settle after ownership changes.
- Durable acknowledgement is idempotent for task, instant, and channel.
- External toast, sound, browser notification, or later native notification delivery is at-least-once across the acceptance-before-ack crash window. Task mutations remain exactly idempotent.
- Editing, clearing, completing, cancelling, or deleting a task cancels pending intent. Exact restoration returns an undelivered intent to pending; a delivered task/instant stays terminal.

The Rust server owns one wakeable scheduler loop. It sleeps until the earliest pending due instant or `Notify`, emits only a content-free `reminders_due` SSE wake, and shuts down before SSE/storage/profile-lock teardown. No pending reminder means no polling. Browser clients acquire, claim, resolve task presentation through authenticated reads, present configured channels, and settle.

Phase 3 web channels are in-app, granted Web Notification, and configured sound. Permission requests never block saving. Native OS delivery waits for the Tauri phase and uses the same contract.

## Calendar and Matrix

`GET /api/v1/calendar/tasks?from=&to=&project_id?` returns tasks whose civil `due_date` is inside the inclusive bounded range. The project Calendar reuses this implementation with a project filter. Day view separates timed and untimed tasks.

Matrix contains pending tasks only. One task update applies each pointer or keyboard move using the request's sampled civil today:

| Quadrant  | Classification                       | Drop result             |
| --------- | ------------------------------------ | ----------------------- |
| Do First  | priority 1–2 and due on/before today | priority 1, due today   |
| Schedule  | priority 1–2 and not urgent          | priority 1, no due date |
| Delegate  | priority 3–4 and urgent              | priority 3, due today   |
| Eliminate | remaining tasks                      | priority 3, no due date |

Never preserve the legacy bug that wrote an ISO timestamp into a date-only field.

## Planning and reviews

Plan My Day steps are overdue review, today's focus, time budget, and ready. Rescheduling overdue tasks uses today's civil date. Exclusions are session-local and do not clear task dates. Finishing persists only changed estimates. Capacity defaults to 480 minutes until Phase 4 exposes settings.

End of Day shows wins completed on the sampled civil day, pending carry-over, tomorrow preview, and completion rate. Carry-over can move to tomorrow or become Someday with no due date. Capacity displays use configured capacity.

Weekly Review covers the prior complete week according to configured `week_start` (Sunday by default), not the current partial week and not the legacy hard-coded Monday. Rust-derived output includes daily completion counts, created/cancelled counts, completion rate, busiest day, completion-time buckets, top-five accomplishments, top-ten overdue tasks, up-to-ten neglected projects, a bounded streak, and up-to-four suggestions. No durable ritual-session table is needed.

## Focus and motivation

- Focus Mode uses all pending tasks and route state `?focus=1`; completion advances safely and pending mutations block accidental dismissal.
- Eat the Frog selects highest dread, then earliest due date, then title. It is disabled by default.
- Task Jar chooses from pending tasks due on/before today. It is disabled by default.
- Dopamine Menu shows pending tasks estimated at 15 minutes or less or priority 3–4, shortest estimates first.

These features reuse task reads and mutations; they do not require dedicated mutation APIs.

## Stats and Smart Nudges

Rust derives stats directly from task truth. Do not add a second daily counter authority unless measurement proves it necessary.

Per-day stats bucket completions by server-zone `completed_at`, creations by `created_at`, and completion minutes from estimates. Accuracy considers completed tasks with positive estimate and actual values:

`max(0, round((1 - mean(abs(actual - estimate) / estimate)) * 100))`.

The streak is consecutive civil days with at least one completion ending today and is zero when today has no completion.

Nudges evaluate in the domain's stable rule order and return bounded facts:

- overdue: pending due before today;
- approaching deadline: pending deadline today or tomorrow;
- stale: pending, no due date, at least 14 days old, oldest first;
- empty today: no pending task due today, allowed to coexist with overdue;
- overloaded day: estimated pending work due on/before today exceeds capacity.

Return at most 20 task identities per rule and 50 combined, with `has_more` when truncated. Dismissal is session-local. Nudges are enabled by default.

## Timeblocking

Time slots and blocks are first-party SQLite resources. CRUD, move, resize, task membership, and replan are user mutations with one transaction, revision, event, summary, and receipt.

- A civil range stays within one day and requires end after start.
- Task-to-slot drop appends only if absent. Membership is unique and ordered.
- Task-to-timeline drop creates a block using estimate or the documented default and clamps to workday end.
- Move and resize use the visual snap grid; end always remains after start.
- Locked blocks are skipped by automatic replan.
- Replan examines the prior seven civil days through yesterday. A typed Rust preview returns the sampled server-local date plus the sorted, bounded eligible owner IDs and blocks. Mutation carries that exact date and ID set; storage compares both atomically against its freshly sampled date and current candidates before moving to today/tomorrow or deleting, and conflicts without writes when stale.
- Recurrence expands virtual read instances inside the requested range. Edits target the series owner; Phase 3 has no exception rows.
- AI auto-scheduling waits for the AI phase.

## Minimal HTTP surface

Extend generated OpenAPI and TypeScript contracts with:

- task reminder and recurrence fields plus explicit uncomplete outcome;
- fenced reminder lease, claim, delivered, and failed operations;
- bounded Calendar range reads;
- capacity/temporal settings reads;
- daily and weekly planning reads;
- stats and nudge reads;
- time block/slot CRUD, range, membership, move, resize, and replan operations.

All remain behind existing bearer authentication, host/origin checks, body bounds, and rate limits. SSE uses small typed snapshots where useful and explicit resync scopes otherwise.

## Bugs and architecture not to preserve

Do not preserve timestamp-as-date Matrix writes, hard-coded Monday Weekly Review, dual stats authorities, unbounded client-side nudge scans, non-deterministic stale nudge ordering, plugin-KV timeblocking, loading all tasks for Calendar, or hard-coded capacity where settings exist. Do not copy legacy service, storage, plugin, sql.js, or Node runtime architecture.
