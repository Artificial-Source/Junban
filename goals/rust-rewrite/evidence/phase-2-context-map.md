# Phase 2 Context Map

Status: implemented and validated. Planning was approved before code; the delivered behavior and measured evidence are summarized in `phase-2-outcome.md`. The live phase contract remains `../execplan.md`.

## Outcome

Phase 2 extends the Phase 1 `domain → app → storage → server → React API facade` vertical slice into complete day-to-day task and organization behavior. It does not add another runtime owner, storage backend, generic shared layer, or distant Phase 3–8 subsystem.

## Current extension points

| Layer               | Current authority                                                                                                                | Phase 2 direction                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Domain              | `crates/junban-domain/src/lib.rs`: typed IDs, task title/date/status and task transitions                                        | Add the complete task/organization model and invariants; split modules inside the crate only when the model justifies it.             |
| Application         | `crates/junban-app/src/lib.rs`: `TaskRepository`, `TaskService`, post-commit `EventSink`                                         | Add focused use cases and ports for organization, query and transactional mutations. Keep transport and SQLite details out.           |
| Storage             | `crates/junban-storage/src/lib.rs`: profile owner, one SQLite worker, schema v1, atomic mutation/receipt/activity/event/revision | Add a forward schema migration, transactional hierarchy/bulk/order operations and indexed query paths without a pool or second owner. |
| HTTP                | `crates/junban-server/src/lib.rs`: authenticated `/api/v1`, transport DTOs, OpenAPI, revisioned SSE                              | Add resource/query/mutation routes and DTOs while preserving host/auth/body/security and stream lifecycle invariants.                 |
| Contract            | `openapi/junban-v1.json` and generated `src/ui/api/generated.ts`                                                                 | Regenerate from Rust authority; never hand-edit generated artifacts.                                                                  |
| React data boundary | `src/ui/api/client.ts` and `src/ui/hooks/useTasks.ts`                                                                            | Extend the fetch-only facade and revision-monotonic client state. Components do not import legacy domain/runtime code.                |
| React shell         | `src/App.tsx`, `src/ui/app/AppLayout.tsx`, `src/ui/components`, `src/ui/views`                                                   | Enable only Phase 2 controls and views using the approved presentation; leave later-phase controls inert.                             |
| Performance         | `scripts/bench-hosted-server.py` and Phase 1 memory protocol                                                                     | Preserve the frozen 100-task memory protocol and add a separate deterministic 10,000-task Phase 2 benchmark.                          |

## Expected files to modify

### Rust

- `crates/junban-domain/src/lib.rs` or focused modules rooted from it
- `crates/junban-app/src/lib.rs` or focused modules rooted from it
- `crates/junban-storage/src/lib.rs` and its migration/tests
- `crates/junban-server/src/lib.rs`
- `crates/junban-server/src/bin/generate-openapi.rs` only if contract composition needs it
- crate/workspace manifests only for dependencies with demonstrated value

### Generated contract and React

- `openapi/junban-v1.json`
- `src/ui/api/generated.ts`
- `src/ui/api/client.ts`
- `src/ui/hooks/useTasks.ts`
- `src/ui/hooks/useRouting.ts`
- `src/App.tsx`
- `src/ui/app/AppLayout.tsx`
- Phase 2 navigation, task, organization and view components under `src/ui/components/` and `src/ui/views/`
- focused client-only rendering helpers under `src/ui/lib/`; Rust remains natural-language parsing authority

### Tests, evidence and docs

- Rust tests beside the owning modules and server lifecycle tests where relevant
- `src/ui/**/*.test.ts{,x}`
- `tests/e2e/{functional,visual,axe}.spec.ts`
- a Phase 2 deterministic fixture and visual authorities under this evidence directory
- `scripts/bench-hosted-server.py` or a separate focused scale harness if that keeps both protocols clearer
- canonical architecture, accessibility, performance and setup docs
- the live ExecPlan and Phase 2 outcome evidence

## Patterns to preserve

1. UUID v7 entity IDs and client-created operation IDs.
2. Domain validation before application persistence.
3. One SQLite transaction for effect, operation receipt, activity, revision and durable event; publish only after commit.
4. Canonical request identity for mutation retries.
5. Transport DTOs distinct from domain entities and persistence rows.
6. Utoipa-derived OpenAPI and generated checked TypeScript.
7. Authenticated SSE with durable catch-up, bounded resources and revision deduplication.
8. Client-side mutation identity, revision-monotonic snapshots and task-ID upserts.
9. Civil dates that never shift through timezone conversion.
10. Inert interface controls until their owning backend behavior exists.

## Behavior acceptance map

The private legacy checkout defines visible behavior, not implementation. Fresh contracts may fix legacy gaps where doing so makes the feature actually functional and simpler.

### Task fields and limits

- Task status is pending, completed or cancelled; complete, uncomplete, cancel and reopen are explicit transitions.
- Round-trip title (1–500 characters), Markdown description (maximum 10,000), priority P1–P4, civil due date, optional local due time plus IANA timezone, UTC deadline, someday flag, estimated minutes (positive), actual minutes (non-negative), dread level 1–5, project, section, parent, tags, order and an opaque validated recurrence rule.
- A task may have at most 100 unique normalized tags; a bulk or reorder operation accepts at most 500 unique task IDs.
- Phase 2 stores and parses recurrence rules but does not expose incomplete recurrence controls or generate occurrences. Phase 3 owns occurrence generation and exact completion reversal.
- Markdown editing preserves an in-progress draft through same-task refresh and resets it when task identity changes.

### Organization and detail behavior

- Projects support name, color, icon, parent, favorite, archive, order and list/board view style. Calendar style is stored only if needed for forward domain continuity; its visible behavior waits for Phase 3.
- Sections belong to one project and support create, rename, collapse, reorder and delete. Deleting a section sets its tasks' `section_id` to null while retaining their project; the transaction advances one revision. A task section must belong to the same project.
- Tags are global first-class resources and task assignment is transactional.
- Templates support CRUD, `{{variable}}` substitution and task creation without a macro language. Phase 2 exposes the legacy Templates tab/shell necessary to manage them; unrelated settings remain disabled until Phase 4.
- A parent completion transitions only pending descendants; already-completed and cancelled descendants remain unchanged. Child completion does not complete the parent. Parent deletion removes descendants transactionally. Indent uses the previous sibling; outdent promotes after the former parent. The graph must be acyclic; no arbitrary hierarchy-depth limit is invented. Any cascade is preflighted and capped at 500 affected tasks.
- Directed `blocks` relations reject self-links and cycles with conflict; repeated identical adds are idempotent.
- Comments support content from 1–10,000 characters and full CRUD. Phase 2 writes real field-level task activity rather than preserving the legacy empty-history gap.
- Project deletion is an explicit transaction: tasks become unprojected/unsectioned, project sections are removed, child projects become roots, and unrelated task hierarchy remains intact. Archive is the ordinary non-destructive action.

### Ordering, bulk actions and undo

- Reorder submits the complete ordered ID permutation for one sibling/project/section scope and commits once.
- List and board movement is single-flight while pending and supports keyboard operation.
- Bulk complete, delete, move, tag and update are atomic for at most 500 unique tasks; the fresh implementation does not preserve legacy partial-progress behavior.
- Supported task undo targets an applied operation receipt. The server stores a bounded inverse/before-image and expected post-image with that receipt and accepts a compensating undo request with a new operation ID only when affected current fields still match; otherwise it returns conflict rather than clobbering newer work. Undoing an undo provides redo. The browser keeps only a 50-entry session stack of operation IDs, not authoritative snapshots. Catalog deletion requires explicit confirmation and is not silently promised undo.
- One user-visible bulk, reorder, hierarchy or undo transaction advances the global revision once and publishes one typed transaction event after commit.
- A task-delete inverse contains the complete removed closure: task/subtask rows, task-tag links, directed relations, comments, task activity and hierarchy/order links. Restore requires referenced external project/section/tag/relation endpoints still to exist and deleted task IDs still to be absent; otherwise undo conflicts.
- Before mutation, storage rejects more than 500 cascade tasks or combined canonical request, response, inverse and post-image JSON above 4 MiB with stable `operation_too_large` validation details. Event JSON has a separate 512 KiB ceiling.

### Quick entry and query behavior

- One Rust parser owns priority, tags, project, recurrence rule, duration, deadline, someday, dread and English date phrases in a fixed documented order. Today supplies today's civil date only when parsing yields no due date.
- The text/Markdown import boundary parses line, bullet and checkbox tasks into drafts without creating a second live backend; full import UX waits for Phase 4.
- Search and saved-filter queries support priority, status, tags, project, overdue, today/tomorrow/week ranges, due before/after/on and residual title/description text.
- Project-name query clauses resolve to project IDs; the fresh rewrite fixes the legacy clause that parsed but did not filter.
- Saved filters are semantic first-class resources with name, query, color and ordering.

### View rules

| View      | Inclusion and behavior                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox     | Unprojected, non-someday tasks; pending first plus recently completed tasks from the last 14 calendar days. Pending count excludes completed rows.        |
| Today     | Pending tasks whose civil due date is today, with overdue tasks separated; create defaults to today; workload sums estimates.                             |
| Upcoming  | Pending tasks after today grouped by civil date, with a separate overdue section.                                                                         |
| Someday   | Pending someday tasks; Activate clears the flag.                                                                                                          |
| Completed | Completed and cancelled history grouped by completion/update day, matching the approved legacy presentation.                                              |
| Cancelled | Cancelled-only history with Restore to pending.                                                                                                           |
| Project   | Pending project tasks in list or section board plus completed progress; load failure is distinct from not-found and must not flatten last-known sections. |
| Task      | Full-page and panel editors preserve dirty/pending drafts and block unsafe navigation while a mutation is unresolved.                                     |

### Keyboard and command behavior

Phase 2 ships palette, search, Quick Add, templates, project navigation, undo/redo and owned navigation commands. Later-phase AI, plugin, Focus, Dopamine, Stats and Settings commands are hidden until functional. Shortcuts do not intercept focused inputs or modal focus traps. Custom shortcut persistence remains Phase 4.

## Architecture and transaction plan

### Domain ownership

Keep four crates only. Split modules inside each crate by owned meaning as growth requires:

- domain: IDs, task, project, section, tag, template, comments/relations, hierarchy/order, filters/query parser, quick entry and pure import parsing;
- app: focused task/catalog/query use cases and store ports, validation orchestration and post-commit publication;
- storage: schema migration, one worker's commands, SQL queries and atomic receipts/activity/events;
- server: HTTP DTOs/routes, OpenAPI and broadened revision events.

Do not add a generic repository, unit-of-work framework, CQRS bus, cache layer or pool. SQL filtering and indexed `LIKE` search are the starting point; FTS is added only if the 10,000-task evidence fails.

### Schema direction

One forward schema v2 adds projects, sections, tags, task-tags, templates, comments, directed task relations, task activity and saved filters. Because SQLite cannot widen the v1 status `CHECK` in place, migration v2 rebuilds `tasks` with the complete column/FK/check definition, copies and validates v1 rows, replaces the table, and recreates only demonstrated indexes. The sole unopened profile connection disables `foreign_keys` before `BEGIN IMMEDIATE`, follows SQLite's table-rebuild procedure, runs `foreign_key_check` before commit, and re-enables enforcement on every success/failure exit. A v1 fixture proves rollback leaves a usable v1 database and success yields a valid v2 database.

Schema v2 also removes task-only assumptions from global logs:

- `events` remains one row per global revision, but stores operation ID plus a typed transaction-event JSON envelope rather than mandatory `task_id`/`task_json` columns;
- a single-entity change may include its snapshot; bulk, cascade, hierarchy and catalog changes include bounded affected IDs and explicit task-query/catalog resync scopes rather than hundreds of snapshots;
- global `activity` remains one mutation summary per revision with nullable typed subject metadata; detailed user-visible field history lives in `task_activity`;
- operation receipts add bounded inverse and expected-post-image JSON required for supported task undo.

The app/server mirror this with a typed `CommittedEvent` envelope. SSE publishes exactly one event per revision, so reconnecting by revision cannot skip part of a transaction; clients apply a safe snapshot or perform one coalesced resync for each declared scope.

A mutation transaction retains the Phase 1 shape:

1. replay or reject the operation receipt;
2. preflight cascade count and exact serialized receipt/event byte ceilings;
3. validate current state and undo post-image conditions;
4. apply all effects and field activity;
5. advance one revision;
6. write one bounded typed transaction event, global activity summary, canonical request, response, inverse and post-image where applicable;
7. commit;
8. publish in-process only after success.

Catalog and task store ports are concrete app-owned traits implemented by the same `SqliteRepository`; they are not generic persistence abstractions. View queries execute in SQL and return only the requested view/detail/catalog data rather than making React refilter the full database.

### API and React direction

All mutations retain `Idempotency-Key`. Prefer one partial task update style, resource collection/detail routes, explicit bulk/reorder/indent/outdent/undo operations, first-class catalog routes, parse endpoints and broadened namespaced SSE events. Unknown committed event types trigger one coalesced current-query/catalog resync.

React grows the existing API facade into view-scoped task queries, catalog state, task detail and a bounded undo stack. It does not retain a parallel all-task authority. The contract is frozen before presentation-heavy work begins, then OpenAPI and TypeScript are regenerated once per coherent contract change.

### Frozen Phase 2 transport details

Phase 2 replaces the task-only Phase 1 transport in one hard cut; it does not retain parallel `PUT` and `PATCH` semantics. All paths remain under `/api/v1`, Phase 1 Host/Origin/auth/error protections remain in force, and every mutation requires a UUID `Idempotency-Key`. Typed canonical request serialization—not incidental JSON whitespace—is the receipt identity. Exact replay returns the original status and body without a second revision; it does not change the response merely to label it a replay.

- `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/{id}`, explicit status routes, `POST /tasks/actions`, `POST /tasks/reorder`, and `POST /tasks/{id}/move` cover task mutation. Move carries the explicit target parent/scope/order anchor; the server does not infer an indent target from an unknown client view.
- `GET /tasks/{id}/activity`, task comment routes, and directed `blocks` relation routes cover detail resources.
- `GET /catalog` returns the small organization snapshot and current revision; conventional collection/detail routes mutate projects, project sections, tags, templates and saved filters. Template apply performs substitution on the server and creates one task.
- `POST /parse/quick-entry` and `POST /parse/filter` are read-only parser routes and do not create receipts.
- `POST /operations/{source_operation_id}/undo` accepts a new operation ID. The OpenAPI contract lists supported task/comment/relation operations; catalog deletion is not promised undo.
- `GET /events` remains authenticated fetch SSE with revision catch-up, a 64-stream cap and one event per committed revision.

`GET /tasks` accepts a view preset plus structured filters, opaque keyset cursor and limit 1–100. Omitted project/section/parent filters mean any; the token `-` means null; a UUID means exact match. The response contains the current revision, server civil `as_of_date`, tasks and optional next cursor. Saved-filter evaluation uses the same typed query model. Completed and Cancelled remain distinct routes/views even though the approved Completed presentation may include cancelled history.

A mutation response contains one `CommittedEvent`; there is no second, competing resource envelope. The event has revision, operation ID, event type, occurrence instant, optional primary resource, at most one tagged resource snapshot, bounded affected-ID sets, and explicit task-query/catalog resync scopes. Single-resource operations include a snapshot. Bulk, cascade, hierarchy and delete-closure operations omit task arrays and request one coalesced query resync. Unknown event types trigger one safe coalesced resync rather than terminating the stream. The frontend's Phase 1 task-only SSE guard is removed in the same contract change.

The HTTP body cap is 512 KiB. A transaction rejects more than 500 task IDs/cascade rows, event JSON over 512 KiB, or combined canonical request/response/inverse/post-image material over 4 MiB before mutation. Relation duplicates and invalid status transitions are conflicts; only replaying the same operation ID is idempotent success. Activity DTOs include revision, sequence and operation ID so history has a stable cursor and undo link.

Recurrence rule round-trip is contract-visible for storage/editor continuity, but occurrence controls and generation remain hidden until Phase 3. Reminder, planning, settings, CLI/MCP, AI, plugin and desktop routes remain absent until their owning phases.

## Preserved UI map

The visual authority is `Junban-legacy@5e2b2b5`; only presentation and visible behavior are references. Phase 1's eight Today/Inbox authorities remain immutable historical evidence. Phase 2's expanded navigation and organization chrome are governed by the separate 12-scene authority rather than rewriting those earlier files.

### Legacy presentation sources

| Surface                               | Legacy paths to consult                                                                                                                                                | Phase 2 boundary                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upcoming                              | `src/ui/views/Upcoming.tsx`                                                                                                                                            | Direct first-party view with overdue and future day groups; replace parser/domain imports with Rust DTO/API behavior.                                                             |
| Someday, Completed, Cancelled         | `src/ui/views/{Someday,Completed,Cancelled}.tsx`                                                                                                                       | Direct first-party views. Do not port their legacy builtin-plugin wrappers.                                                                                                       |
| Project list and board                | `src/ui/views/Project.tsx`, `src/ui/views/project/*`, `src/ui/views/Board.tsx`, `src/ui/dnd/columnKeyboardCoordinates.ts`, `src/ui/components/sidebar/ProjectTree.tsx` | Preserve list/board and section chrome; Calendar project style remains Phase 3.                                                                                                   |
| Task page and detail                  | `src/ui/views/TaskPage.tsx`, `src/ui/components/TaskDetailPanel.tsx`, `src/ui/components/task-detail/*`, `src/ui/components/task-metadata/*`, subtask components       | Restore the full layout for Phase 2 fields. Reminder/recurrence controls remain absent until Phase 3.                                                                             |
| Filters and saved filters             | `src/ui/views/FiltersLabels.tsx`, `FilterView.tsx`, `src/ui/components/QueryBar.tsx`, `TagsInput.tsx`                                                                  | Preserve layout, suggestions, live regions and error presentation; Rust owns query parsing/filtering and saved filters are first-class resources rather than a settings-key blob. |
| Palette, search, Quick Add, templates | `src/ui/components/{CommandPalette,SearchModal,QuickAddModal,TemplateSelector}.tsx`, `src/ui/app/AppModals.tsx`                                                        | Preserve dialogs and keyboard semantics; omit plugin, AI and later-phase commands.                                                                                                |
| Drag/drop and bulk                    | `src/ui/components/task-list/*`, `src/ui/views/Board.tsx`, `src/ui/hooks/{useMultiSelect,useBulkActions}.ts`, `BulkActionBar.tsx`                                      | Preserve pointer and keyboard interaction; operations use the new API and Rust application semantics.                                                                             |
| Keyboard behavior                     | `src/ui/shortcuts.ts`, `src/ui/hooks/{useAppShortcuts,useGlobalShortcut,useKeyboardNavigation}.ts`, `ChordIndicator.tsx`                                               | Ship Phase 2 defaults and chords. Customizable shortcut/settings UI remains Phase 4.                                                                                              |
| Feedback and loading                  | `src/ui/components/{Toast,Skeleton,TaskMutationFeedback,StatusBar}.tsx` and `src/ui/app/ViewRenderer.tsx`                                                              | Preserve status/alert/busy semantics; replace legacy direct-services and undo manager.                                                                                            |
| Theme/responsive behavior             | `src/ui/themes/*`, legacy density/font/forced-color/reduced-motion CSS, `useIsMobile.ts`, `MobileDrawer.tsx`, `BottomNavBar.tsx`                                       | Phase 2 proves light/dark/Nord and desktop/mobile. Appearance preference controls remain Phase 4.                                                                                 |

Safe presentation sources must be rebound to generated DTOs and frontend hooks. The rewrite UI must not import legacy `src/core`, `src/application`, `src/storage`, `src/db`, `src/parser`, `src/plugins`, `src/desktop-server`, `src/cli`, `src/mcp`, `src/ai`, `ui/api/direct-services`, sql.js, or the legacy undo/query/filter authority.

### Compact Phase 2 visual authority

Retain the existing eight Phase 1 images as immutable historical evidence. Unchanged regions remain references, but intentionally enabling Phase 2 navigation or task chrome is compared to the exact legacy presentation and captured as new Phase 2 authority rather than rewriting Phase 1 artifacts.

Add at most this 12-scene representative matrix instead of multiplying every theme, viewport and state:

1. Today with organization fields — desktop light.
2. Inbox with organization fields — desktop dark.
3. Today organization state — mobile light.
4. Upcoming with overdue and future groups — desktop dark.
5. Project section list — desktop light.
6. Project board with three sections — desktop Nord, combining the board and Nord sentinels.
7. Cancelled grouped history with restore — desktop light; functional coverage protects Completed and Someday variations.
8. Full task-detail panel with Markdown, tags, priority, hierarchy, relation, comment and activity — desktop dark.
9. Filters & Labels plus a saved-filter result — desktop dark.
10. Command palette — desktop light; structural tests protect Search.
11. Open mobile drawer with project tree — mobile dark; functional tests protect the bulk bar and toast.
12. Quick Add with template selector open — desktop light.

The Phase 1 frozen clock, reduced motion, Noto-pinned CI fonts, 1440×900 and 390×844 viewports, threshold `0.2` and maximum `1%` differing pixels remain the protocol. Accent, forced-color and contrast variants use semantic/unit accessibility checks rather than a screenshot matrix. Density/font preference screenshots wait for their Phase 4 settings owner.

### Accessibility contract

- Preserve the skip link and focused `main` landmark.
- Every panel/modal/drawer has the correct dialog label, focus trap, Escape behavior and focus restoration.
- Palette and search follow combobox/listbox/option semantics with active descendant and selected state.
- Task completion, selection, reorder and pending states have explicit accessible names and busy state.
- Drag/drop is keyboard operable; board/list/subtask movement is not pointer-only.
- The bulk bar is a named region and remains usable at narrow widths.
- Filters expose expanded state, labelled inputs, status updates and alert failures.
- Toasts, skeletons and mutation feedback retain alert/status/busy semantics.
- Reduced motion, forced colors, light/dark/Nord contrast, mobile current navigation and closed-drawer hidden state remain covered by structural/axe tests separate from image comparisons.

## Validation and performance plan

Use the nearest risk-matched check before broad browser validation:

| Risk                                                                       | Primary proof                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Value types, status transitions, hierarchy/query/parser invariants         | Domain unit/property tests and fixed-clock parser goldens    |
| Migration, FKs, transactional bulk/order/hierarchy/undo and exact receipts | Storage integration tests with injected rollback and restart |
| Validation-before-write and publish-after-commit                           | App fake-store tests                                         |
| DTOs, error envelopes, auth/host/origin continuity and idempotency         | Server route tests plus OpenAPI/TypeScript drift gate        |
| Revision races, SSE dedupe, cache invalidation and routing                 | Focused Vitest hook/client tests                             |
| Full day-to-day journeys and release-binary restart                        | Playwright functional tests                                  |
| Dialog, keyboard, drag/drop, live-region and contrast behavior             | Structural keyboard tests and axe serious/critical = zero    |
| Approved presentation                                                      | Phase 1 reference plus bounded Phase 2 visual authority      |

Every Phase 2 feature-inventory row maps to one automated case ID in the closeout evidence. Do not create one E2E per row when domain, storage or API tests prove the invariant more directly.

### Hosted-memory regression

Rerun the unchanged five-sample `junban-phase1-hosted-server-v1` release protocol. Every sample remains within 24 MiB warm and 32 MiB peak, uses one Rust process and has no Node marker. A median increase greater than the larger of 20% or 2 MiB from Phase 1 requires explanation but cannot waive either ceiling.

### Ten-thousand-task protocol

Freeze `junban-phase2-scale-v1` before its first measurement:

- Linux x64 cgroup v2, optimized release server, three authoritative samples and a two-second settle period.
- A Rust development-only storage seeder creates exactly 10,000 deterministic tasks before server startup; it is not included in release artifacts or the timed process tree. Record seed duration separately.
- Fixture distribution: ten projects with five sections each, deterministic tag/priority/status/date patterns, five percent subtasks, comments/relations/templates/saved filters represented, and fixed timestamps/clock.
- Product list/query endpoints use a maximum page size of 100 and stable cursors; the benchmark never requests all 10,000 tasks in one response.
- Measure per-operation samples and aggregate p50/p95 for: unfiltered first page, Inbox/Today/Project pages, hit and no-hit title/description search, tag+priority/due-range/project+section filters, 50 partial updates, 50 complete/uncomplete pairs, twenty 25-task bulk mutations and twenty 25-task reorder/hierarchy-safe moves.
- In every sample also execute one near-cap 500-task pending-descendant completion plus undo and one near-cap 500-task subtree delete plus full-closure undo. Validate status selectivity and exact restoration of tags, relations, comments, task activity and ordering while cgroup peak remains within the same ceiling.
- Hard pre-measurement p95 budgets on loopback: list/view ≤75 ms, search/filter ≤100 ms, single mutation ≤75 ms, and 25-task bulk/reorder ≤150 ms. Non-2xx, malformed response, receipt mismatch or ordering error fails immediately.
- The server remains one Rust process with no Node marker and ≤32 MiB cgroup peak during the complete seeded workload.
- Record sample-level and aggregate latency distributions, response counts, SQLite file size, warm memory and cgroup peak in `phase-2-scale-bench.json`.
- A quick 500-task/single-sample mode validates only the harness. Authoritative scale and five-sample memory runs are phase evidence, not noisy default pull-request CI.

## Phase 1 scaffolding to replace

- The minimal task model and pending/completed-only status.
- Schema v1's minimal task row and unfiltered created-order list path.
- Unused project/tag ID wrappers, by turning them into real owned entities.
- Inbox's temporary assumption that every task is an inbox task.
- Today/Inbox-only routing.
- Disabled Phase 2 search, Upcoming, Filters & Labels, projects and new-project controls.
- The inert drag handle and minimal title/due task editor.
- Quick-entry placeholder text that advertises parsing not yet implemented.

Phase 3 planning controls, Phase 4 settings and Phase 6 AI controls remain inert.

## High-risk seams

- One forward schema migration must introduce the organization graph without dual writers or partial authority.
- Hierarchy deletion, indent/outdent, bulk actions and reorder must preserve invariants in one transaction.
- Bulk, reorder and undo request identity must replay exactly without duplicating effects.
- Query/search must scale to 10,000 tasks without returning every row to React for every view.
- SSE/client convergence must avoid full-list reload storms after the event vocabulary grows.
- Natural-language quick entry must have one Rust parsing authority rather than resurrecting legacy client domain modules.
- Inbox/project semantics and phase ownership of recurrence must be explicit before coding.
- Enabling dense task-management controls must preserve the approved desktop/mobile and theme presentation.

## Explicit exclusions

- No CLI, MCP, AI, voice, plugin or Tauri crate.
- No Calendar, Matrix, scheduler, reminder delivery, planning ritual, nudge or timeblocking engine.
- No live Markdown backend or full import workflow; Phase 2 owns Markdown description rendering and import parsing boundaries only.
- No generic repository framework, event sourcing, state-management framework, SQLite pool or speculative extension interface.
- No legacy API/data compatibility.

## Risk checklist

- [x] Public API and generated contract change
- [x] Forward SQLite migration
- [x] Exact UI preservation and accessibility
- [x] Memory and 10,000-task performance evidence
- [x] Transactional hierarchy/bulk/reorder invariants
- [x] Multi-client convergence
- [ ] Settings/configuration model (Phase 4)
- [ ] Legacy compatibility (explicitly excluded)

## Resolved UI scope decisions

- Someday, Completed and Cancelled are first-party views, not builtin plugins.
- Phase 2 includes full task detail only for fields whose domain behavior ships in Phase 2; reminders and recurrence controls wait for Phase 3.
- Saved filters are first-class resources, not opaque settings storage.
- Phase 2 ships the default shortcut behavior and relevant chords; shortcut customization and appearance settings remain Phase 4.
- Phase 2 validates Nord and responsive behavior but does not prematurely ship Phase 4 density/font preference controls.
- The 12-scene visual matrix above is a hard maximum; functional, semantic and accessibility tests protect adjacent states rather than creating screenshot combinations.

## Minimal dependency decisions

- Store raw Markdown and render it in React with current `react-markdown` plus `remark-gfm`, `skipHtml`, no `rehype-raw`, the library's safe default URL transform, and one strict transform for valid internal Junban task UUID links. The Rust server does not render HTML, so Phase 2 does not add `pulldown-cmark`, `ammonia`, `comrak` or an HTML DOM stack.
- Add `proptest` 1.11 only as a `junban-domain` development dependency for targeted hierarchy/date/parser strategies. It has no release-binary impact.
- Write quick-entry and saved-query parsers directly over existing `jiff`; do not add another time stack, general NLP parser, regex-heavy date parser or ML runtime.
- Start search with prepared indexed SQL and escaped `LIKE`. Bundled SQLite already contains FTS5, so if the frozen benchmark fails, an external-content FTS5 table can be added without another crate or service. Raw user strings are never passed directly to `MATCH`.
- Reject additional Markdown sanitizers, Tantivy/search services, generic parser combinators and runtime property/fuzzing dependencies for this phase.

## Database planning-review ledger

| ID          | Status          | Resolution                                                                                                                                                                    |
| ----------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DBPLAN2-001 | fixed, approved | Schema/app/SSE now use one typed transaction event per revision with bounded affected IDs and explicit resync scopes; task-only global-log columns are rebuilt.               |
| DBPLAN2-002 | fixed, approved | Migration v2 explicitly rebuilds `tasks` under SQLite's foreign-key-safe table-rebuild procedure and validates both rollback and v1→v2 success.                               |
| DBPLAN2-003 | fixed, approved | Cascades are capped at 500; combined durable receipt material is capped at 4 MiB; event JSON is capped at 512 KiB; near-cap completion/delete undo enters the scale workload. |
| DBPLAN2-004 | fixed, approved | Delete undo restores the complete task closure and conflicts if referenced external entities or absence postconditions no longer hold.                                        |
| DBPLAN2-005 | fixed, approved | Parent completion changes pending descendants only and records the exact transitioned ID set.                                                                                 |
| DBPLAN2-006 | fixed, approved | Section deletion nulls task sections while retaining project membership in one revision.                                                                                      |

## Planning gate outcome

Focused recheck approved DBPLAN2-001 through DBPLAN2-006. Implementation preserved the approved migration/event/undo limits; later changes to those limits must reopen the relevant finding.
