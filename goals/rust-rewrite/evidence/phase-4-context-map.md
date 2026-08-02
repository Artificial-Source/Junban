# Phase 4 context map — data and hosted operation

Date: 2026-08-01

Base: `b68afbc` (`main`, completed Phase 3)

Working branch: `phase-4-data-hosted`

## Outcome

Phase 4 makes settings, data portability, complete backup/restore, hosted access, diagnostics, event catch-up, and recovery first-class parts of the Rust application. It extends the existing `junban-domain → junban-app → junban-storage → junban-server → React` path. It adds no crate, alternate database, Node runtime, telemetry service, or Tailscale controller.

Success means:

- one typed settings authority drives every surface;
- Markdown, JSON, and CSV are bounded import/export formats, never live backends;
- a strict complete-backup artifact can be validated and restored atomically;
- restore uses one process-wide maintenance barrier and forces a restart after cutover;
- Tailnet hosting stays loopback-only behind an operator-managed proxy;
- token rotation invalidates old credentials and streams immediately;
- diagnostics are bounded, local, and redacted;
- clients recover honestly from event-history gaps, token changes, maintenance, and restored history;
- migration/restore failures expose only a bounded recovery surface;
- ordinary hosted operation remains under the frozen 24 MiB warm / 32 MiB peak ceilings.

## Frozen architecture decisions

1. **Four crates only.** New code is organized as focused modules inside the existing crates. A new abstraction is allowed only when two current callers need it.
2. **SQLite remains the sole live authority.** Markdown/JSON/CSV are transfer formats. Complete backup is a separate, versioned, lossless profile artifact.
3. **Schema v5.** It expands the Phase 3 `app_settings` allowlist into a typed aggregate and adds an event-history epoch. Settings are not an arbitrary key/value extension API.
4. **Restore is terminal for the running service.** A successful database cutover returns one final response, closes streams, and leaves every normal API at `503 restore_restart_required` until process restart. This prevents stale service, scheduler, host-policy, and revision state from crossing the cutover.
5. **Every restore changes the event epoch.** Clients submit their epoch with catch-up requests. An epoch mismatch or pruned cursor returns `409 event_reset_required`; clients perform an authoritative reload rather than combining incompatible histories.
6. **No automatic Tailscale management.** Junban validates and persists exact permitted hostnames and shows setup guidance. It does not invoke `tailscale`, create serve rules, or bind publicly.
7. **Safe recovery is narrow.** If normal storage cannot open after migration or a restore rollback cannot be trusted, the process serves only health, recovery status, static recovery UI, and authenticated complete-backup restore. Task, settings, event, export, diagnostics, and ordinary mutation routes remain unavailable.
8. **Minimal dependencies.** Add `sha2` for artifact and preview fingerprints. Use existing `rusqlite` backup support and `http-body-util`; do not add archive, CSV, settings, async-runtime, or alternate database frameworks.

## Schema v5 and settings authority

### Domain

Add typed settings under `crates/junban-domain/src/settings.rs` and export them from `lib.rs`:

- appearance: theme, accent, density, font size/family, reduced motion;
- date/time display, week start, startup destination;
- task creation defaults;
- notification and sound preferences;
- daily capacity, optional work hours, nudge rules;
- first-party feature visibility;
- custom keyboard shortcuts.

Use closed enums and bounded value objects. Reject unknown settings keys, malformed colors, duplicate shortcuts, reserved browser chords, invalid work-hour ranges, and unknown feature identifiers. Defaults preserve Phase 3 behavior: Sunday week start, weekly Calendar default, 480-minute capacity, nudges enabled, Eat the Frog and Task Jar disabled, and no implicit work-hours restriction.

### Storage

`crates/junban-storage/src/migration.rs` migrates v4→v5 by rebuilding the constrained `app_settings` authority while preserving existing Phase 3 values. `app_state` gains `event_epoch TEXT NOT NULL` with a generated profile epoch. All existing profiles receive one epoch during migration.

Add settings repository commands in focused storage modules and worker messages in `storage/src/lib.rs`. A settings patch runs in one immediate transaction, increments global revision once, writes one operation receipt/undo record where applicable, and emits one `settings.updated` event with a settings resync scope.

Planning, Calendar, timeblocking, reminders, nudges, and motivation must stop calling Phase 3 static defaults and read the same persisted aggregate through `junban-app`.

## Import and export

### Supported transfer formats

- **JSON task transfer:** Junban-owned, versioned, human-readable, task/resource transfer; intentionally not a complete profile backup.
- **CSV:** task export/import with strict quoting and documented supported columns.
- **Markdown:** task export and existing Markdown/plain-text import semantics.
- **Todoist-style JSON import:** bounded projection of documented fields only; unknown fields are ignored and reported in preview rather than becoming hidden authority.

A pure domain parser produces an import preview with normalized drafts, project/tag create-or-reuse intent, line-level warnings/errors, and a SHA-256 content fingerprint. Invalid previews cannot be applied. Apply requires the exact fingerprint and an idempotency key.

Import apply is one transaction and is capped at the existing 500 affected-task ceiling. It generates new IDs, resolves names deterministically, emits one summary/receipt/event, and never silently splits one import into multiple commits. Export can include the whole profile’s transferable task resources and must stream or stage output rather than build an unbounded response in memory.

Proposed routes:

- `POST /api/v1/imports/preview`
- `POST /api/v1/imports/apply`
- `GET /api/v1/exports/tasks?format=json|csv|markdown`

Normal JSON bodies remain capped at 512 KiB. Transfer uploads receive a separate 8 MiB streamed limit. The 500-item semantic limit remains authoritative even when bytes are smaller.

## Complete backup artifact

Use a custom `.junban-backup` binary envelope instead of ZIP:

- fixed magic and framing version;
- bounded manifest and SQLite payload lengths;
- manifest SHA-256 in the frame header;
- manifest fields: artifact version, schema version, creation timestamp, payload SHA-256, inventory counts, and explicit exclusions/normalizations;
- SQLite online-backup payload.

The backup worker creates a private temporary SQLite snapshot, normalizes runtime-only reminder lease/claim state, runs `integrity_check`, foreign-key verification, schema/settings deserialization, inventory verification, and hashes before download. It excludes `access-token`, lock/runtime metadata, diagnostics, and temporary files. The logical SQLite profile remains complete.

Restore upload is streamed to a private staged file and capped at 512 MiB. Validation completes before maintenance begins. A single restore flow then:

1. wins the process-wide maintenance barrier;
2. rejects new normal authenticated work;
3. closes SSE/reminder streams and stops/joins the reminder coordinator;
4. waits for admitted handlers/forwarders to drain within a bounded deadline;
5. snapshots the live database to a private rollback file;
6. applies the validated candidate through SQLite backup into the live connection;
7. generates a new event epoch and validates integrity, foreign keys, schema, settings, and inventory;
8. restores the rollback snapshot on any failed apply;
9. remains fail-closed if rollback cannot be validated;
10. on success, returns the final restore response and remains restart-required.

A candidate rejected before maintenance leaves normal operation untouched. An apply failure with validated rollback still requires restart so no stale in-memory authority resumes.

## Server runtime and hosted access

### Maintenance admission

Add a small runtime gate in `junban-server` with states `normal`, `maintenance`, `restart_required`, and `recovery`. Middleware admits and counts normal requests before handlers. Maintenance is single-winner, stops new admission, cancels long-lived streams, and waits for the admitted count to reach zero. Recovery mode uses a separate minimal router and does not construct the normal application service.

### Token rotation

Replace immutable token state with narrowly synchronized runtime authority. Rotation:

1. authenticates with the current token and requires an idempotency key;
2. generates a new random token;
3. atomically writes, fsyncs, and renames the private token file;
4. updates in-memory authentication only after durable success;
5. closes active SSE streams;
6. returns the new token once with `Cache-Control: no-store`.

The old token fails immediately after success. Tokens never enter URLs, runtime metadata, diagnostics, tracing, or error details.

### Host policy

The server remains bound to loopback. Persist an exact validated Tailnet hostname allowlist. Effective host policy combines immutable loopback/operator hosts with the persisted allowlist. Validate raw `Host`, reject ports/Unicode ambiguity/wildcards, keep existing Origin checks, and provide documentation for operator-managed Tailscale Serve.

### Diagnostics

Add a bounded structured diagnostic ring/file containing only timestamp, severity, stable code, request ID, and redacted message fields. Strip Authorization values, bearer-like secrets, URL userinfo, query strings, and configured host/token values before storage or copy. No telemetry leaves the machine. Diagnostics routes support bounded read/copy and clear.

## Event catch-up and multi-client recovery

Preserve Phase 2 bounds:

- page: at most 100 events and 2 MiB serialized JSON;
- retained history: at most 2,048 events and 64 MiB total JSON;
- individual event: 512 KiB;
- operation receipt material: 4 MiB;
- undo retention: 30 days.

List/snapshot and SSE responses expose `event_epoch`. Catch-up requires both epoch and revision. Pruned history and epoch mismatch are typed reset conditions, not empty success. Settings updates use settings resync; imports use task/catalog resync; restore ends all streams before epoch replacement. Multi-client tests must prove stale clients converge after settings changes, imports, token rotation, reconnect, history pruning, and post-restore restart.

## React integration and visual authority

The existing shell, typography, spacing, dialogs, responsive behavior, themes, and navigation treatment remain unchanged. Enable the current Settings destination and port the legacy presentation over generated Rust API types only.

Tabs: Essentials, Appearance, Features, Keyboard, Templates, Data, Hosted, Diagnostics. Move template management from Filters & Labels into Settings without duplicate ownership. AI, voice, plugin, and desktop-only controls stay hidden until their phases.

Feature toggles affect navigation/UI visibility only; they do not delete data or become authorization. The client applies appearance only after confirmed server persistence, refreshes on `settings.updated`, and enters explicit maintenance/restart/recovery states without retry loops.

Before UI implementation, freeze at most ten legacy-authority scenes: Essentials desktop light, Appearance desktop dark, Features desktop light, Keyboard desktop dark, Templates desktop light, Data desktop light, Hosted desktop dark, Diagnostics desktop light, Data mobile light, and Appearance mobile dark. If a legacy scene does not exist, the approved nearest Settings shell is the visual authority and only content semantics may differ. Existing Phase 1–3 screenshots remain immutable.

## Files to modify

| Area          | Primary files                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Domain        | `crates/junban-domain/src/settings.rs`, import/export/backup format modules, `lib.rs`, focused tests                      |
| App           | `crates/junban-app/src/{ports,requests,service,lib}.rs` and focused modules/tests                                         |
| Storage       | `crates/junban-storage/src/{migration,lib,settings_ops,transfer_ops,backup_ops,event_ops}.rs`, rows/helpers/tests         |
| Server        | `crates/junban-server/src/{lib,main,routes,dto,sse,error}.rs`, maintenance/recovery/diagnostic modules, API/process tests |
| Frontend      | `src/ui/api`, `WorkspaceContext`, routing/sidebar, Settings components/context, transfer/restore/recovery UI, tests       |
| Contracts     | `openapi/junban-v1.json`, generated `src/ui/api/types.ts`                                                                 |
| Evidence/docs | Phase 4 context/outcome/review/performance/visual evidence; architecture, security, setup, performance docs               |

## Implementation waves

1. **Visual authority and contract tests:** freeze Settings scenes; add failing domain/API acceptance tests and numeric transfer/restore budgets.
2. **Settings + schema v5 + event epoch:** domain types, migration, storage/app service, settings routes, catch-up reset semantics.
3. **Transfer formats:** pure parsers/serializers, preview/fingerprint, atomic apply, streaming export.
4. **Backup/restore core:** framing, validated snapshots, rollback, fault injection, permissions.
5. **Runtime barrier and recovery:** request admission/drain, SSE/reminder cancellation, restart-required and recovery routers.
6. **Hosted operation:** host allowlist, token rotation, diagnostics/redaction.
7. **React Settings/Data/Hosted UI:** exact presentation port, transfer dialogs, terminal/recovery states, multi-client settings sync.
8. **Integrated security/database review fixes:** only verified material findings, each with a focused regression.
9. **Dogfood and evidence:** real Tailnet access, token rotation, import/export round trips, backup/restore/restart, corruption/rollback drills, recovery mode, multi-client convergence.
10. **Performance and closure:** five-sample release benchmark, 10,000-task transfer/backup workloads, docs, final specialist review, one clean phase commit/PR.

## Validation and budgets

- Rust: format, Clippy `-D warnings`, workspace tests, docs, release build, supply-chain audit.
- Frontend: format, lint, typecheck, unit/integration tests, build, runtime-boundary check.
- Browser: focused Phase 4 functional/accessibility flows plus unchanged Phase 1–3 visual suites and ≤10 new Settings scenes.
- Security/database: hostile backup frames, truncated/oversize upload, future schema, hash/inventory mismatch, path/symlink attacks, token/Host/Origin attacks, redaction corpus, concurrent restore, admitted-request drain, injected apply and rollback failures.
- Ordinary hosted memory: ≤24 MiB warm and ≤32 MiB peak, five final same-head release samples.
- 10,000-task profile targets (p95 unless operation is singular): settings read/patch ≤100 ms; catch-up page ≤150 ms; transfer preview of 500 tasks ≤250 ms; atomic import of 500 tasks ≤750 ms; streamed 10,000-task export ≤1.5 s; complete backup ≤2 s; validated restore/cutover of the benchmark profile ≤5 s. Budgets include server work and exclude browser download prompting.
- Transfer/backup operations may use bounded private temporary disk, but no ordinary idle-memory regression or unbounded heap buffer is allowed.

## Main risks

- Restore deadlock or stale request crossing the cutover: explicit admission counter, cancellation, bounded drain, fault tests.
- Restored revision colliding with stale clients: persisted event epoch and typed reset response.
- Backup advertised as complete while omitting state: manifest inventory and cross-table round-trip assertions.
- Token leakage: durable-update ordering, no-store response, redaction tests, URL/runtime-metadata scans.
- Settings drift between features: one typed aggregate consumed through app service, no frontend-only persistence.
- Scope inflation from legacy settings: ship only Phase 4-owned controls; later-phase tabs remain absent.

Phase 4 is accepted only when all paths above are functional, evidence is on the exact final head, review findings are closed, and no material defect remains.
