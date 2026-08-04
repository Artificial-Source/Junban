# Ground-up Rust Rewrite of Junban

This ExecPlan is the live authority for rebuilding Junban around a Rust application core while preserving the approved React interface. It follows `PLANS.md` and must remain current as implementation proceeds.

**Status:** approved by the user on 2026-07-28 and expanded with an evidence-driven Phase 10 on 2026-07-29. Phases 0 through 6 are complete. Phase 7 capability-limited portable plugins are in progress at the Wave 1 SDK-first acceptance gate; Phases 8–10 remain.

## Purpose and user-visible outcome

Junban will remain the same local-first task manager visually and functionally, but its shipped runtime will no longer depend on Node.js. The primary result is a small, fast native Rust server for Tailnet/web use. The same Rust domain and storage authority will also power the Tauri desktop app, native CLI, MCP server, AI orchestration, reminders, backup/restore, and portable plugin host.

A finished rewrite means:

- the approved React design is visibly unchanged;
- the Tailnet/web server, desktop app, CLI, and MCP surfaces work;
- one SQLite database is the sole live source of truth;
- Markdown is supported through import/export rather than a parallel live backend;
- all shipped backend and integration runtime code is Rust;
- Node/pnpm are development and frontend-build tools only;
- optional AI, voice, and plugins do not inflate the default runtime when unused;
- the legacy supported feature set is accounted for by an acceptance checklist;
- optimized builds demonstrate a large, repeatable reduction from the legacy memory baseline;
- every phase is validated, documented, reviewed, and committed before the next begins.

## Baseline and evidence

The retired implementation is private and archived as `Artificial-Source/Junban-legacy`; the local reference checkout is the sibling `Junban-legacy` directory at commit `5e2b2b5adc865f401843c5030285293c5fabccc5`. It is a visual and behavioral reference, not an implementation dependency.

On 2026-07-28, both servers were measured on the same Linux host with empty fresh SQLite data and optimized frontend assets:

| Process                      | Warm cgroup memory | Purpose                                     |
| ---------------------------- | -----------------: | ------------------------------------------- |
| Legacy Junban Tailnet server |         179.25 MiB | Rewrite baseline                            |
| Kessai optimized Rust server |          13.45 MiB | Feasibility comparator, not a Junban target |

The legacy server kept a launcher and a TypeScript/Node server process resident. Full methodology is in `evidence/baseline-memory.md`. Frontend migration evidence is in `evidence/frontend-preservation-map.md`; plugin runtime research is in `evidence/plugin-runtime-research.md`.

Phase 1's final five-sample optimized run measured 8.79 MiB median / 9.23 MiB maximum warm cgroup memory and 9.41 MiB maximum peak. The final hosted-server budget is frozen at 24 MiB maximum warm and 32 MiB peak under the exact Phase 1 protocol. Same-commit warm-median variance may not exceed the larger of 15% or 1 MiB without an idle-host rerun; per-phase median growth above the larger of 20% or 2 MiB requires measured explanation and explicit acceptance. Phase 9 must pass the same protocol and ceilings; explaining individual deltas cannot waive the final bounds. Every later phase records its memory delta, and an unexplained material regression blocks that phase. Final acceptance also requires no resident Node process.

## Product decisions already approved

1. The product remains named **Junban**. The fresh repository starts around `0.1.0`; “zero” is not a public codename.
2. The React interface and design are preserved. Rendering can be optimized, but visible changes require explicit approval.
3. Tailnet/web is the first priority. Desktop, CLI, and MCP are required completion surfaces.
4. Current supported product features are preserved, but old databases, API contracts, CLI output, MCP contracts, and plugins need not remain compatible.
5. SQLite is the only live database. Markdown is import/export compatibility.
6. AI and voice remain and should improve.
7. Plugins become sandboxed portable packages. Old plugins are not compatible.
8. Windows, macOS, and Linux remain supported.
9. The work proceeds in explicit, validated, cleanly committed phases. Replaced scaffolding is deleted.
10. The retired repository remains private and archived.
11. Implementation follows Google's code-health standard: make focused progress with simple, functional, maintainable code; do not pursue theoretical perfection or speculative abstraction.
12. Phases 2–10 proceed sequentially without pausing at phase boundaries. Phase 10 performs a final evidence-driven codebase, developer-experience and documentation audit before any separately approved release tag.

## Scope

### In scope

- Rust domain model, application services, SQLite persistence, migrations, scheduler, and eventing
- Axum HTTP server and built React asset serving
- Tailnet-oriented loopback hosting, exact host allowlisting, authentication, token rotation, and multi-client consistency
- Exact React design preservation and frontend-only rendering optimizations
- Native CLI and MCP server over the same application semantics
- Rust AI provider clients, orchestration, tool execution, secret handling, and server-side voice adapters
- Browser-only voice and VAD code in the React frontend where the browser is the execution environment
- Wasmtime Component Model/WASI P2 plugin packages with Rust and TypeScript authoring paths
- Tauri v2 shell, tray lifecycle, Quick Capture, autostart, notifications, updater, and hosted-access controls
- New complete backup/restore plus task import/export including Markdown
- Cross-platform packaging, accessibility, security, memory, performance, and release evidence

### Out of scope

- compatibility with legacy databases, backup envelopes, API payloads, command output, MCP tools, plugins, or updater lineage
- a second live Markdown database
- unrestricted native dynamic-library plugins
- a resident Node, Deno, or JavaScript plugin process
- native mobile apps, paid sync, collaboration, billing, or enterprise features from the legacy future roadmap
- native calendar OAuth integrations that were never shipped
- redesigning the interface without a separate explicit user decision
- copying legacy backend code merely to reduce initial effort

## Architecture

### Stable repository shape

Create crates only when their owning phase starts; do not generate empty crates for distant work.

```text
crates/
  junban-domain/       Pure entities, value objects, validation, recurrence and query rules
  junban-storage/      SQLite schema, migrations, repositories, backup primitives
  junban-app/          Use cases, transactions, idempotency, events, scheduler-facing ports
  junban-server/       Axum composition, auth, static UI serving, SSE, server binary
  junban-cli/          Native command-line client and local-owner coordination
  junban-mcp/          Native MCP stdio/HTTP adapter over application/client ports
  junban-ai/           Optional provider clients, orchestration and tool integration
  junban-plugin-sdk/   WIT contract/package types shared with plugin author tooling
  junban-plugin-host/  Optional Wasmtime runtime, created only after the measured spike
src/                   React frontend only
src-tauri/             Thin Rust desktop shell and native lifecycle integration
tests/                 Cross-surface and acceptance tests that do not belong beside a crate
docs/                  Canonical architecture, contributor, security and product docs
goals/                 Live plans and evidence
```

`junban-domain` has no dependency on HTTP, SQLite, Tauri, Wasmtime, AI vendors, or frontend tooling. `junban-app` owns application semantics and transaction boundaries through explicit storage and event ports. HTTP, CLI, MCP, desktop, AI tools, and plugins must invoke these same use cases rather than reimplement rules.

Avoid creating a generic “shared” crate. A type belongs to the layer that owns its meaning. Public transport DTOs are not domain entities.

### One storage authority

At any moment, one process owns a profile's SQLite authority. A cross-platform owner lock and private runtime metadata prevent two Junban owners from starting over the same database.

- `junban-server` owns the database for hosted/headless use.
- The desktop app hosts the same server/application composition inside its Rust process; there is no Node sidecar.
- React uses one HTTP path in web and desktop builds.
- CLI and MCP prefer the active local server through its private endpoint metadata. Their phase will measure and choose a safe fallback for “no server running”: either starting the owner or temporarily acquiring ownership. They may never silently become a second owner.
- Explicit Quit closes listeners, scheduler, SQLite, and the owner lock in that order.

SQLite uses WAL mode, foreign keys, a bounded busy timeout, explicit transactions, and a single dedicated connection worker initially. Phase 1 measures this against a small pooled alternative before freezing the implementation. The invariant—not the helper crate—is frozen now: one writer authority, no connection held across arbitrary async work, and transaction completion before event publication.

### Domain and time semantics

Define distinct value types for:

- date-only local calendar values;
- UTC instants;
- local wall-clock times with an IANA timezone;
- recurrence rules with an original anchor;
- validated task/project/tag/section/plugin IDs;
- client-generated mutation identities.

A date-only value must never be shifted by timezone conversion. Timestamp recurrence preserves local wall time through DST and anchored monthly recurrence preserves the intended month-day behavior. These invariants receive property and timezone tests before Calendar or reminders are ported.

### Transactions, retries and events

Fresh contracts allow simplification, but ordinary reliability is not optional.

- Mutations accept a client-generated operation ID.
- A small durable receipt table prevents duplicate effects after network retries.
- Domain mutation, receipt, activity record, and durable outbox entries commit atomically.
- In-process consumers observe events only after commit.
- Multi-client updates use a revisioned event stream with reconnect/resync behavior; clients never rely on best-effort broadcasts as the source of truth.
- Reminder/plugin/AI side effects consume durable work and record completion so retries do not duplicate user-visible effects.

Do not copy the legacy backup replay and compatibility machinery. Implement only the guarantees required by the new contracts.

### HTTP and frontend contracts

The server exposes a versioned `/api/v1` JSON API with a consistent error envelope, request ID, error code, retryability, and field details. Streaming AI and live change notifications use bounded SSE; WebSockets are added only if a demonstrated bidirectional requirement cannot use HTTP plus SSE.

Rust request/response types are the contract source. Phase 1 evaluates and freezes an OpenAPI generation path, expected to be Rust schema derivation plus a checked-in OpenAPI document and generated TypeScript types/client. CI must fail on contract drift. Generated DTOs do not leak persistence rows into React.

The frontend keeps a fetch-only `src/ui/api` facade so components do not know transport details. There is no direct sql.js path or inline Vite backend.

### Hosted security

- Bind loopback by default.
- Require authentication on all non-health application endpoints.
- Permit only exact configured hostnames; no wildcard host trust.
- Store runtime metadata and local tokens in owner-only files or an OS secret facility.
- Support token rotation and bounded authentication lockout/rate limiting.
- Never invoke, install, or configure Tailscale. Display setup guidance only.
- Keep browser security headers, request/body limits, origin/host validation, redacted logging, and restore maintenance barriers.
- Define scoped automation credentials during the CLI/MCP phase rather than treating every client as full admin forever.

The public server security model receives a specialist review before Phase 1 closure.

### Optional subsystems and idle memory

AI provider clients, local voice engines, and Wasmtime are not initialized during ordinary task-server startup. Their configuration and dependencies live behind explicit feature/service boundaries and are loaded only when enabled.

The plugin phase compares:

1. lazy Wasmtime embedding in the owner process; and
2. an on-demand Rust `junban-plugin-host` process with private IPC.

The decision is based on default idle memory, first-call latency, steady plugin memory, crash isolation, capability enforcement, and cross-platform operability. No plugin enabled means no Wasmtime engine resident.

### Desktop composition

Tauri remains a thin native shell. It starts the same Rust server/application composition in-process and loads the same built React assets. Tauri commands are limited to native capabilities such as windows, tray, notifications, autostart, updater, secure secret access, and Quick Capture. Domain mutation does not bypass `junban-app` through ad hoc Tauri commands.

## Complete legacy feature acceptance inventory

The inventory is a verification checklist, not a mandate to preserve legacy implementation details. Each item receives a phase owner and at least one automated or manual acceptance case before final release.

### Tasks and organization — Phases 1–3

- create, read, edit, delete, complete, uncomplete and cancel tasks
- title, Markdown description, priority P1–P4, due date/time, deadline, someday flag
- estimated and actual minutes, dread level and default task settings
- projects, project icons/colors, archive behavior, sections and section ordering
- tags, assignment, filtering and labels management
- parent/subtask hierarchy, indent/outdent, inline subtasks and hierarchy-safe deletion
- task relations, comments and activity history
- drag/drop and explicit reorder
- bulk complete, delete, move, tag and update
- operation retry safety plus user-facing undo for supported mutations
- templates and template application
- natural-language quick entry and query parsing
- search, saved filters and advanced filtering
- recurring-task rule storage is established in Phase 2; occurrence generation and exact completion undo/reversal semantics ship in Phase 3

### Views and interaction design — Phases 1–4

- Inbox, Today, Upcoming, Someday, Completed and Cancelled
- project list and Kanban/board workflows
- Calendar day, week and month
- urgency/importance Matrix
- task page and task detail panel
- Filters & Labels and saved filter views
- productivity Stats
- sidebar, collapsed navigation, mobile drawer and bottom navigation
- Quick Add, global search, command palette and customizable keyboard shortcuts/chords
- desktop and mobile responsive behavior
- light, dark and Nord themes; accent colors; density/font preferences
- focus visibility, forced colors, reduced motion, contrast and screen-reader semantics
- drag/drop, virtualization where useful, loading skeletons, toasts and mutation feedback
- onboarding presets/theme/AI steps
- sound effects and completion animations

### Planning, motivation and time — Phases 3 and 7

- reminders, reminder recurrence, snooze/delivery tracking and notification settings
- daily planning and daily review
- weekly review and workload/capacity display
- Focus Mode
- Eat the Frog, Dopamine Menu and Task Jar
- Smart Nudges with configurable overdue, approaching-deadline, stale-task, empty-Today and overloaded-day rules; deferred first evaluation; periodic refresh; capacity input; and session-scoped dismissal
- timeblocking day/week layouts, 1–7 day columns, drag/create/move/resize
- TimeBlocks and TimeSlots, work hours, grid interval and default duration
- recurring blocks, replan unfinished work and current-block focus integration
- AI-assisted auto-scheduling when AI is enabled

Timeblocking becomes a first-party domain capability with the approved existing UI. The new plugin system may expose it through capabilities, but preserving the feature does not depend on arbitrary plugin-supplied React code.

### Data, settings and recovery — Phase 4

- one SQLite live database and forward schema migrations
- complete backup export, validation and atomic restore using a new format
- JSON, CSV and Markdown task export
- Markdown, plain-text, JSON and supported Todoist-style import where the legacy UI exposed it
- import preview and validation
- application, appearance, date/time, task default, sound, nudge and feature settings
- diagnostic/error log with secret and URL redaction
- hosted server setup, status, token rotation and exact hostname allowlist
- multi-client consistency and stale mutation recovery

### CLI, MCP and agent integration — Phase 5

- native task/project/tag/reminder and planning commands
- human output and strict machine-readable JSON modes
- discoverable shared tool catalog
- MCP tools, resources and prompts over persistent stdio and any approved HTTP transport
- exact ID handling, date/reminder rules and bounded errors
- one agent skill documenting when to use CLI versus MCP
- scoped credentials and no diagnostic text on machine stdout

Old command names and JSON/MCP schemas need not be preserved; the user workflow and feature reach must be.

### AI and voice — Phase 6

- optional AI chat with streaming responses
- persisted chat sessions, memories, custom instructions and daily briefing settings
- context injection from tasks/projects/schedule
- task, project, tag, reminder, planning and scheduling tools
- extraction, follow-up questions, priority suggestions, pattern/workload/organize/energy tools
- model discovery, timeouts, retries, cancellation and graceful provider failure
- OpenAI-compatible providers plus the shipped named providers: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, DeepSeek, Gemini, Mistral, Kimi, DashScope, Groq and ZAI
- custom provider configuration and supported OAuth flows
- speech-to-text and text-to-speech abstractions
- browser, Groq, local and Inworld-style adapters where the legacy product exposed them
- push-to-talk, VAD, bidirectional voice mode and voice-call overlay
- cancellation that prevents late transcript/audio application
- API key and secret protection

Provider-specific support is verified against current official APIs during Phase 6; dead or superseded vendor contracts may be upgraded while preserving the user capability.

### Plugins — Phase 7

- portable package manifest, validation, hash/signature verification and compatibility range
- install, uninstall, enable, disable and failure containment
- manifest dependency IDs and semantic-version constraints; dependency-first activation; safe disable/removal rules for dependents; missing/incompatible dependency errors; and cycle detection
- explicit permissions and approval/revocation UI
- scoped task/project/settings/event/HTTP/logging capabilities
- plugin commands and event subscriptions
- isolated plugin settings and key-value storage
- declarative panels, views, status items and structured actions rendered by trusted React components
- registry browsing/search and package installation
- Rust SDK and a real TypeScript build template
- reference plugins such as Pomodoro and automation/import examples
- resource limits, crash containment and cross-platform hostile-plugin tests

Arbitrary plugin React execution is intentionally replaced by declarative host-rendered UI. This preserves extension surfaces without reintroducing an unrestricted JavaScript runtime.

### Desktop and native lifecycle — Phase 8

- Tauri packages for Linux x64, macOS Intel/ARM and Windows x64/ARM where the platform toolchain supports them
- one in-process Rust server and one AppData SQLite authority
- tray lifetime, explicit Quit and close-to-tray behavior
- launch at login and hidden startup
- global Quick Capture window/protocol
- native notifications and reminder handoff
- hosted-access controls using the same local server
- secure updater flow and recovery behavior
- package/resource verification and no Node runtime artifact

### Product posture and release — Phases 9–10

- no account, telemetry or mandatory cloud service
- local-first defaults and private data paths
- accessibility and keyboard-only acceptance
- cross-platform source and package documentation
- checksums, SBOM and provenance/attestation for releases
- clear OS-signing truth
- clean fresh `0.1.x` release history

## Phase graph and acceptance contracts

The dependency chain is `0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`. Small independent documentation or test work may run in parallel within a phase, but implementation phases do not overlap across an uncommitted boundary.

### Phase 0 — Repository and toolchain foundation

**Outcome:** a public, coherent fresh repository whose empty workspace is reproducible and whose rules prevent old architecture from returning.

**Completion evidence:** local acceptance, architecture approval, exact-head GitHub checks on PR #1, and public repository configuration are recorded in the Phase 0 evidence and retrospective.

Work:

- finalize this plan and baseline evidence;
- establish Rust 2024 workspace policy, formatter, lints, dependency/audit policy and reproducible toolchain; retain one minimal `junban-domain` crate so standard Cargo workspace checks operate on a real long-lived target rather than temporary scaffolding;
- establish React/Vite/Tailwind test/build tooling with Node used only for development;
- add minimal CI for Rust, frontend, docs and repository invariants;
- add architecture, security, accessibility, performance and contributor documentation skeletons;
- add a check that release artifacts cannot contain or launch Node/backend JavaScript;
- configure the new GitHub repository and make it public only after this phase passes.

Acceptance:

- `cargo fmt --all -- --check`
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`
- `cargo test --locked --workspace --all-features`
- frontend format, lint, typecheck, unit-test and production-build commands
- docs link/format checks and `git diff --check`
- CI passes on the exact commit
- architecture review approves boundaries
- one clean commit: `chore: establish Rust rewrite foundation`

No product feature is claimed in Phase 0.

### Phase 1 — Hosted vertical slice and first native memory proof

**Outcome:** an optimized Rust binary serves the React shell and supports a complete authenticated task loop over one fresh SQLite database: health, create, list, edit, complete/uncomplete and delete. The Today/Inbox shell matches approved screenshots for implemented states.

Work:

- implement the existing minimal `junban-domain` foundation and create `junban-storage`, `junban-app` and `junban-server` only;
- freeze task/project/tag ID and date/time value semantics;
- implement schema v1, migration runner, owner lock and private runtime metadata;
- evaluate dedicated single SQLite worker versus a minimal pool and record the decision;
- implement versioned API/error envelope, generated frontend types and contract drift gate;
- implement loopback default, exact Host checks and security headers for every response; keep static shell/assets unauthenticated for fragment bootstrap; require auth on every `/api/v1` route except health; use authenticated fetch-based SSE; enforce body limits;
- implement operation IDs/receipts and post-commit event revision;
- port only the visual shell, themes, fonts/assets, Sidebar, Today, Inbox, TaskItem and minimum editor;
- add deterministic seed and memory/startup benchmark harness.

Acceptance:

- fresh install and restart preserve tasks;
- duplicate operation ID cannot duplicate a task;
- auth/host/body limits fail closed;
- two browser clients converge after mutation and reconnect;
- optimized release process contains no resident Node and no backend JS resources;
- same-host idle/warm/startup measurements compare with the 179.25 MiB baseline;
- before Phase 2, record and approve the numeric final hosted-server memory ceiling, exact workload/protocol, variance and regression rule that Phase 9 must pass;
- all eight deterministic legacy-derived Today/Inbox desktop/mobile light/dark comparisons in `evidence/phase-1-visual-baseline/` pass at threshold 0.2 and maximum 1% differing pixels; axe and structural checks pass separately; intentional visible differences require explicit user approval;
- Rust unit/integration tests, frontend checks, Playwright task smoke and security review pass;
- decision records cover SQLite worker and contract generation;
- one clean commit: `feat: deliver Rust hosted task vertical slice`.

After evidence, freeze the first native memory regression budget instead of inventing it in advance.

### Phase 2 — Complete task and organization domain

**Outcome:** the Rust server and preserved UI provide complete day-to-day task management without AI, plugins or native desktop dependencies.

Work:

- all Phase 2 task fields, projects, sections, tags, templates, hierarchy, relations, comments and activity; persist validated recurrence rules without generating occurrences or exposing incomplete recurrence controls before Phase 3;
- bulk actions, ordering, drag/drop contracts and undoable mutations;
- natural-language quick entry and search/query/filter engine;
- saved filters and Inbox/Today/Upcoming/Someday/Completed/Cancelled/Project/Task views;
- Markdown description rendering and import parsing boundaries;
- command palette and relevant keyboard interactions;
- frontend DTO cleanup so components import no legacy domain/runtime modules.

Acceptance:

- feature checklist rows owned by Phase 2 are automated; recurrence acceptance in this phase is limited to parser/API/storage round-trip, while occurrence generation and exact reversal remain Phase 3 gates;
- parser golden tests and property tests cover dates, priorities and invalid input;
- hierarchy/reorder/bulk operations preserve invariants transactionally;
- 10,000-task list/search/filter/mutation benchmark records p50/p95 and peak memory;
- screenshots and accessibility pass across light/dark/Nord and desktop/mobile representative scenes;
- API-contract and frontend review pass;
- one clean commit: `feat: complete Rust task management`.

### Phase 3 — Calendar, recurrence, reminders and planning

**Outcome:** temporal behavior, planning rituals, motivation features and first-party timeblocking work from the Rust authority.

Work:

- recurrence engine with anchored month behavior and exact completion reversal;
- Calendar day/week/month and Matrix;
- reminders, scheduler leases, snooze, delivery state and browser/native delivery port;
- daily planning/review, weekly review, workload capacity and stats;
- Focus Mode, Eat the Frog, Dopamine Menu and Task Jar;
- Smart Nudges for overdue, approaching deadline, stale, empty-Today and overloaded-day conditions, including per-rule settings, configured capacity, deferred/periodic evaluation and session-scoped dismissal;
- first-party timeblocks/timeslots, day/week views, recurrence, DnD/resize and replan;
- revisioned multi-client updates for scheduler effects.

Acceptance:

- timezone matrix covers DST, date-only values, month end and representative world zones;
- crash/restart and duplicate-delivery tests prove reminder idempotency;
- recurrence complete/uncomplete round trips exactly;
- Calendar, Matrix, planning/review, focus, nudge and timeblocking visual/a11y scenes pass;
- deterministic nudge tests cover all five rules, disabled rules, capacity boundaries, refresh and dismissal semantics;
- seeded temporal benchmark and idle scheduler memory delta are recorded;
- architecture/reliability review passes;
- one clean commit: `feat: add Rust planning and temporal engine`.

### Phase 4 — Data portability, backup, settings and hosted operations

**Outcome:** users can configure, host, export, back up and restore the new Junban safely.

Work:

- settings model and UI integration;
- JSON/CSV/Markdown export and supported import/preview workflows;
- versioned complete-backup manifest, SQLite online backup, checksum validation and atomic restore;
- restore maintenance barrier and rollback on failed apply;
- hosted-access status, allowed hostnames, token rotation and setup guidance;
- diagnostics/error log redaction;
- performance-safe data limits and malicious-input handling.

Acceptance:

- restore round-trip reproduces all authoritative tables and rolls back on injected failure;
- malformed/future/oversized artifacts are rejected before mutation;
- import/export tests cover Unicode, line endings and path traversal attempts;
- active requests cannot cross the restore barrier;
- hosted access remains loopback-only and Junban never executes Tailscale;
- storage/database and security specialist review passes;
- backup throughput, restore peak memory and post-restore memory are recorded;
- one clean commit: `feat: add Rust backup and hosted operations`.

### Phase 5 — Native CLI, MCP and agent skill

**Outcome:** native command-line and MCP clients reach the Phase 1–4 feature set without opening a competing database authority.

Work:

- freeze active-owner discovery and no-server fallback after a cross-platform spike;
- native CLI with human and strict JSON output;
- shared typed tool catalog mapped to `junban-app` operations;
- MCP tools/resources/prompts and persistent stdio lifecycle;
- scoped automation credentials;
- agent skill and setup docs.

Acceptance:

- CLI/MCP/web conformance runs the same operation corpus and compares resulting state;
- structured stdout is parseable and diagnostics use stderr;
- active-owner races cannot create two authorities;
- abrupt client/MCP termination does not corrupt state or retain the owner lock;
- command startup time, idle MCP memory and repeated-operation latency are recorded;
- API-contract review passes;
- one clean commit: `feat: add native CLI and MCP surfaces`.

### Phase 6 — Optional Rust AI and voice

**Outcome:** the existing AI and voice user experience works through optional Rust provider services with no idle cost when disabled.

Work:

- provider-neutral streaming model, provider registry and secure settings;
- current official adapters for approved providers and model discovery;
- chat sessions, memory, custom instructions, daily briefing and context assembly;
- shared tool execution through application services;
- timeout/retry/cancel and late-result suppression;
- server-side STT/TTS adapters in Rust and browser-only VAD/speech integration in React;
- voice-call lifecycle, push-to-talk and privacy controls;
- AI auto-scheduling integration with Phase 3.

Acceptance:

- disabled AI/voice changes default idle memory only within noise and opens no provider/model resources;
- mock-provider contract suite covers streaming, tool calls, retry, timeout and cancellation;
- provider secret redaction and untrusted model-output boundaries pass security review;
- Stop prevents late transcript, tool or audio effects;
- AI/voice UI screenshot and accessibility checks pass;
- enabled-session memory and stream latency are recorded separately from default memory;
- one clean commit: `feat: add optional Rust AI and voice`.

### Phase 7 — Portable capability-limited plugins

**Outcome:** users can install signed/hash-verified portable plugins authored in Rust or TypeScript without a resident Node runtime or unrestricted native code.

Work:

- versioned Junban WIT world and package manifest;
- measured lazy in-process versus on-demand Rust host spike and ADR;
- capability linker, memory/CPU/time/concurrency/output/network/filesystem limits;
- package verification, compatibility, lifecycle, settings, KV and event delivery;
- dependency graph validation with semantic-version constraints, dependency-first activation, dependent-aware disable/uninstall, missing/incompatible dependency failures and cycle rejection;
- declarative panels/views/status/actions rendered by trusted React components;
- registry/store and permission UX;
- Rust SDK, TypeScript `jco/componentize-js` template and reference plugins;
- hostile-plugin and crash-containment suite.

Acceptance:

- no enabled plugins means no Wasmtime engine resident;
- denied imports, network, filesystem, oversized output, CPU loop and memory growth fail closed;
- component imports cannot exceed the approved manifest;
- dependency activation order is deterministic; missing/incompatible dependencies and cycles fail before activation; disabling/removing a required dependency cannot leave an active dependent;
- plugin failure cannot corrupt task state or stop the server;
- Rust and TypeScript examples build and run on Windows/macOS/Linux;
- default, Rust-plugin and TypeScript-plugin memory/cold-start evidence are separate;
- security review, threat model and adversarial tests pass;
- one clean commit: `feat: add portable Wasm plugins`.

### Phase 8 — Thin Tauri desktop and native lifecycle

**Outcome:** packaged desktop Junban uses one Rust process for application/server authority plus the platform webview, while retaining Quick Capture, tray and hosted access.

Work:

- Tauri v2 shell with in-process server composition;
- AppData paths, owner admission and renderer readiness;
- tray, close-to-tray, Quit, autostart and hidden startup;
- Quick Capture and native reminders/notifications;
- hosted-access settings and server lifetime;
- updater and package metadata;
- target-native installers and resource verifier.

Acceptance:

- desktop and hosted browser mutate the same SQLite database;
- closing to tray keeps configured hosting; Quit releases listener, DB and lock;
- abrupt parent death and relaunch recover without orphan authority;
- hidden login launch and Quick Capture work target-natively;
- package scan proves no Node executable, Node backend, sql.js or legacy sidecar;
- desktop process-tree cold/warm memory and launch-to-interactive time are recorded;
- target-native package, install and launch smoke evidence passes for Linux x64, macOS Intel, macOS ARM64, Windows x64 and Windows ARM64;
- an unavailable target may be omitted only through an explicit user-approved exception recorded before Phase 8 closes; the exception names the missing evidence and blocks release until the user separately approves releasing without it;
- architecture and native lifecycle review passes;
- one clean commit: `feat: deliver native Rust desktop`.

### Phase 9 — Integrated parity, hardening and release candidate

**Outcome:** every in-scope feature row is closed with evidence and the fresh Junban is a complete, honest release candidate ready for the final codebase audit.

Work:

- close the feature inventory and remove all superseded scaffolding;
- full cross-surface, accessibility, security, performance, recovery and portability pass;
- dogfood Tailnet/web first, then desktop, CLI, MCP, AI/voice and plugins;
- release packaging, checksums, SBOM, provenance and updater-signature policy;
- public setup, security, plugin-author, CLI/MCP and recovery docs;
- assemble the release candidate only after target-native evidence is complete; publication waits for Phase 10 and the separately approved release tag.

Acceptance:

- no unchecked in-scope inventory row or unresolved severe finding;
- optimized hosted server passes the exact numeric final memory ceiling and workload protocol frozen after Phase 1;
- no release path launches/requires Node;
- target-native package, install and launch smoke evidence is complete for Linux x64, macOS Intel, macOS ARM64, Windows x64 and Windows ARM64; any missing target requires the explicit user-approved release exception defined in Phase 8;
- full screenshot/a11y set demonstrates approved design preservation;
- long-run and crash/recovery tests show no owner/process leaks;
- working tree is clean and all canonical docs match behavior;
- integrated final review passes;
- one clean commit: `chore: complete Junban Rust rewrite`.

### Phase 10 — Codebase excellence, DX and documentation audit

**Outcome:** the completed rewrite receives one fresh, evidence-driven audit of implementation quality, architecture, dependencies, tests, contributor experience, documentation and operational maintainability. Verified high-value improvements land without redesigning the product or starting speculative framework work. The resulting tree is ready for a separately approved first release tag.

Work:

- create a fresh whole-repository map covering ownership, dependency direction, concurrency boundaries, public contracts, generated code and runtime entry points;
- inspect production Rust and React for dead or superseded paths, needless duplication, unclear ownership, unsafe assumptions, panic/error behavior, hidden global state and avoidable complexity;
- audit direct dependencies, enabled features, advisories, licenses, duplicate versions, binary contribution and optional-subsystem isolation; remove only dependencies or features whose value is not demonstrated;
- assess test effectiveness, flake history, fixture duplication, slow suites and uncovered high-consequence invariants; add or simplify tests where evidence shows value rather than chasing a cosmetic coverage number;
- dogfood a clean-clone contributor journey from setup through first focused change, local checks, debugging, contract generation, benchmarks, plugin authoring, CLI/MCP use and release rehearsal;
- verify every canonical document, command, example, architecture diagram and troubleshooting path against the finished product; remove stale planning language and duplicated authorities;
- review CI duration, cache behavior, diagnostics, artifact retention and release operations for reliable feedback without weakening gates;
- rerun the final optimized memory, startup, seeded performance, accessibility, security, recovery, package and cross-surface evidence after all accepted audit fixes;
- maintain a stable finding ledger. Fix verified material issues; reject or defer speculative polish with reasons.

Acceptance:

- a clean checkout on each supported development platform can follow the documented setup and reach the nearest focused checks without hidden machine state;
- all runtime entry points, ownership boundaries, generated artifacts and optional feature-loading rules have one documented authority and match implementation;
- no superseded implementation, unexplained production dependency, unresolved advisory, unapproved license, accidental runtime Node path or material dead code remains;
- tests cover every verified high-consequence gap found by the audit, while redundant or flaky coverage is simplified without reducing behavior protection;
- contributor, architecture, API, CLI/MCP, plugin-author, security, recovery, performance and release documentation is command-checked and task-oriented;
- CI and release rehearsal complete with actionable diagnostics, exact artifact identity and no weakening of Phase 9 gates;
- the Phase 1 hosted-memory ceiling, final seeded latency budgets, package checks and no-resident-Node invariant still pass after accepted fixes;
- the finding ledger has no unresolved severe or material issue; an integrated final reviewer approves the changed delta, with a specialist checkpoint added only if a discovered issue creates a distinct severe-risk domain;
- one clean commit before the separately approved release tag: `chore: complete Junban codebase excellence audit`.

Phase 10 is deliberately bounded. “Take the codebase to the next level” means measurable improvements to correctness, clarity, feedback speed, onboarding and operational confidence—not an endless refactor or theoretical perfection exercise.

## Phase-level validation policy

Run nearest checks first. The expected mature command families are:

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
cargo audit
cargo deny check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Exact package scripts are established in Phase 0. Do not claim commands that do not yet exist or were not run.

Runtime evidence always uses optimized release binaries. Measure cgroup memory when available plus RSS/PSS/process tree, startup-to-health, first UI interaction, warm steady state, seeded workload latency and peak memory. Record OS, toolchain, commit, data size and exact command. Development servers are not authoritative memory evidence.

## Decisions frozen now

- fresh repository and history;
- exact visible design preservation;
- Rust for all shipped backend/runtime logic;
- React frontend and build-only Node;
- Axum-style versioned HTTP boundary shared by web and desktop;
- one SQLite live authority and no live Markdown backend;
- one application-service semantic core for every surface;
- Tauri in-process Rust server, not a packaged Node sidecar;
- durable mutation identity and post-commit events, implemented more simply than legacy;
- Wasmtime Component Model/WASI P2 plugin contract;
- declarative plugin UI instead of arbitrary React execution;
- timeblocking preserved as a first-party capability;
- optional subsystems lazy by default;
- phase-by-phase validation and clean commits.

## Decisions deferred to measured spikes

1. Dedicated SQLite worker implementation versus a minimal pool (Phase 1).
2. OpenAPI/type-generation tool choice, while Rust remains contract authority (Phase 1).
3. SSE event-log retention and resync window (Phase 1–2).
4. CLI/MCP no-server owner strategy (Phase 5).
5. OS keyring versus encrypted private secret file for headless/desktop parity (Phase 4/6 security spike).
6. Lazy in-process Wasmtime versus on-demand Rust plugin-host process (Phase 7).
7. Provider libraries and local voice engines after current official API verification (Phase 6).
8. The numeric final RAM ceiling, exact workload/protocol, allowed variance and regression rule; these are deferred only until Phase 1 evidence and must be frozen before Phase 2.

Each spike has a timebox, benchmark, threat-model note and ADR. A spike cannot leave two production implementations.

## Recovery and rollback

- Every phase starts from a clean committed predecessor and ends in one clean commit.
- Before the first public release, a failed phase is reverted as a commit or corrected on its branch; unfinished partial behavior is not merged.
- SQLite migrations are forward-only within a release. Before applying a migration, create and verify a recoverable backup. A failed migration leaves the original database authoritative.
- Restore and migration tests use private disposable directories, never shared `/tmp` paths or real user data.
- Owner-lock and process tests must kill the full process tree and prove listener/lock release before cleanup.
- Optional AI/plugin/desktop failures may be disabled without disabling ordinary task management.
- The private legacy repository remains historical reference only; rollback never means reviving its backend in the new tree.

## Review checkpoints

Use one dominant-risk reviewer at each phase gate:

- Phase 0–1: architecture/security
- Phase 2: API/frontend
- Phase 3: architecture/reliability
- Phase 4: database/security
- Phase 5: API contracts
- Phase 6: security
- Phase 7: security with an explicit plugin threat model; adversarial review if warranted
- Phase 8: architecture/native lifecycle
- Phase 9: integrated final review
- Phase 10: evidence-driven whole-codebase review; add one specialist only if a discovered issue has a distinct severe-risk domain

Track findings by stable ID as open, fixed, rejected or deferred with reasons. A severe unresolved finding blocks the phase.

## Progress

- [x] User scope and repository transition decisions recorded.
- [x] Legacy repository made private and archived.
- [x] Fresh repository created privately pending coherent foundation.
- [x] Legacy memory baseline and same-host Rust comparator measured.
- [x] Frontend preservation map completed.
- [x] Plugin runtime research completed.
- [x] Independent plan-gate review approved after `PLAN-001`–`PLAN-003` were fixed.
- [x] User approved this plan and explicitly requested simple, functional, non-overengineered implementation.
- [x] Phase 0 implementation, validation, architecture review and exact-head CI.
- [x] Phase 1 implementation, validation, dogfood, benchmark, review and protected delivery through PR #5.
- [x] Phase 2 context, behavior, UI, dependency, validation and database plan approved.
- [x] Phase 2 domain model and invariant wave.
- [x] Phase 2 parser and transactional schema waves.
- [x] Phase 2 application, HTTP, React, scale, dogfood, review and delivery waves.
- [x] Phase 3 context, temporal authority, migration recovery, reminder fencing, timeblock/slot, bounds and visual-evidence plan approved.
- [x] Phase 3 temporal benchmark harness and five-sample release evidence recorded; `P3-FINAL-007` is fixed after the bounded analysis snapshot rerun passed every frozen latency and memory budget.
- [x] Phase 3 recurrence, reminder, planning, timeblocking, visual, accessibility, performance, review and delivery implementation.
- [x] Phase 4 settings, portability, backup/recovery, hosted operations, performance, dogfood and specialist acceptance; all `P4-DB`, `P4-SEC`, `P4-UI`, and dogfood findings are closed.
- [x] Phase 5 context, ownership, credential, catalog, MCP lifecycle, conformance and performance plan approved; `P5-PLAN-001` and `P5-PLAN-002` are closed.
- [x] Phase 5 Wave 0 dependency/ownership spike: `junban-cli`/`junban-mcp` crates, exact-pinned `rmcp 3.1.0` stdio features, versioned instance-matched runtime metadata, API-only `LocalApiOwner`, `junban status`, temporary MCP status probe, and focused regressions (see `evidence/phase-5-context-map.md`).
- [x] Phase 5 Wave 1 principal scopes: private hashed automation credentials, centralized pre-body route authorization, operator CLI `auth create|list|revoke`, OpenAPI/TS contract update, and completed security gate; `P5-SEC-001`–`P5-SEC-004` are fixed with focused ambiguity, parent-permission, Windows-ACL, and durable-replacement regressions in `phase-5-review-ledger.md`.
- [x] Phase 5 Wave 2 CLI session/catalog/commands: versioned 87-tool OpenAPI-bound catalog with exact result schemas, bounded HTTP request plans with idempotent retry, resumable token rotation, private atomic staged upload/download, generic `tools list`/`tool call`, ergonomic task/project/tag/reminder/plan/data/server commands, strict JSON parse errors, `docs/cli.md`, and focused catalog/executor/process regressions. `P5-API-001`–`P5-API-011` are fixed (see `evidence/phase-5-context-map.md` and `evidence/phase-5-review-ledger.md`).
- [x] Phase 5 Waves 3–4 MCP, conformance, performance, dogfood, API-contract review, and phase closure: all four surfaces matched one 17-revision digest, optimized automation passed every absolute/lifecycle/latency budget, `P5-API-012`–`P5-API-018` plus `P5-DOG-001` are closed, and the phase is one clean commit.
- [x] Phase 5 Wave 4 protocols frozen before measurement: 17-revision cross-surface corpus and fixed CLI/MCP latency, memory, lifecycle, ownership, secrecy, cleanup, and no-Node acceptance budgets; local-owner CLI dry run passed every corpus operation/error assumption.
- [x] Phase 6 legacy/current context and official provider/local-browser dependency research completed; four provider wire families, exact lazy local-voice pins, schema/settings/secrets/tool/cancel authority, interface scenes, and disabled/enabled release budgets are frozen in `evidence/phase-6-context-map.md`. The high-risk planning gate approved after `P6-PLAN-001`–`P6-PLAN-005` were fixed.
- [x] Phase 6 Wave 0 dependency/contract authorities: lazy provider client/SSE/error/cancel foundation in `junban-ai`; exact-pinned browser-only Whisper, Kokoro, Piper, and VAD packages behind dynamic workers; bounded hash-verified OPFS admission with same-origin support assets; and sixteen immutable legacy-rendered AI/voice authorities.
- [x] Phase 6 Wave 1 schema-v6 persistence and secret authority: typed `AiSettings`/`VoiceSettings`, atomic v5→v6 AI tables/quotas, crash-valid approval/run transitions, bounded bidirectional restore validation, private receipt-first `ai-secrets.json`, restore credential clearing, focused failure-injection coverage, and approved database gate with `P6-DB-001`–`P6-DB-007` fixed (see `evidence/phase-6-wave-1.md` and `evidence/phase-6-review-ledger.md`).
- [x] Phase 6 Wave 2 provider runtime: one domain-owned preset authority, approved named providers over four wire families, lazy model discovery/retry/cancel/redaction, bounded provider-neutral speech contracts, and deterministic loopback fixture coverage (see `evidence/phase-6-provider-adapters.md`).
- [x] Phase 6 Wave 3 orchestration/tools/API complete, including durable chat, approvals, dispatch recovery, daily briefing, edit/retry/regenerate, and the exact-head security/API gate.
- [x] Phase 6 Wave 4 preserved React AI/voice implementation: canonical lazy chat/settings, browser/cloud/local speech, half-duplex call UX, exact-manifest local workers, sixteen immutable visual comparisons, browser functional coverage, axe/keyboard coverage, and the integrated frontend/accessibility gate are complete; `P6-W4-REV-001` and `P6-W4-REV-002` are fixed.
- [x] Phase 6 Wave 5 closure. Exact optimized browser dogfood and real local-voice inference pass; `P6-DOG-001`–`P6-DOG-004` and final security finding `P6-FINAL-SEC-001` are fixed; disabled matched-release, enabled local-mock, schema-v6 conformance, full validation, dependency audit, and final security recheck pass; the phase is one clean commit.
- [x] Phase 7 Wave 0 host-placement gate: temporary `tools/phase7-host-placement` probes compared protocol-only / lazy in-process / SDK-parent-plus-child with real Rust + pure TypeScript components, actual import inspection, fair warm/peak/cold selection, trap/CPU/memory/in-flight-child-crash/recovery/cleanup containment, exact byte/hash binding and cgroup evidence. The clean idle five-sample campaign and focused architecture recheck closed `P7-ARCH-001`–`004` and accepted `on_demand_child_host`. Frozen projected active gates are Rust 18.6016/19.5078 MiB and TypeScript 357.334/415.6201 MiB warm/peak; ordinary no-plugin 24/32 MiB remains unchanged. See `evidence/phase-7-host-placement-adr.md` and `evidence/phase-7-host-placement.json`.
- [ ] Phase 7 portable-plugin implementation (Waves 1–5). Contract remains `evidence/phase-7-context-map.md`. Planning, schema, package, WIT and host-placement gates are approved.
  - [x] Wave 1 SDK-first implementation subgate: production `junban-plugin-sdk` owns exact WIT/JBP1/JRI1/manifest/signature/capability/graph/component/protocol authorities; default server linkage is static-only with a matched feature-off baseline, and the superseded Wasmtime probe is deleted.
  - [ ] Wave 1 SDK-first acceptance: `P7-PKG-001`–`003` and `P7-WIT-001`–`006` are fixed and focused package-security/API rechecks approve the exact SDK, consumers, protocol and frozen WIT. The clean exact-commit parent five-sample matched default/feature-off release memory gate remains; schema v7 must not start earlier. Runtime host, routes, UI, registry artifacts, and reference plugins have not started.
- [ ] Phase 8 implementation.
- [ ] Phase 9 implementation.
- [x] User requested sequential execution through a new Phase 10 without pausing at phase boundaries.
- [x] Phase 10 scope and release sequencing passed focused planning review.
- [ ] Phase 10 codebase excellence, DX and documentation audit.

## Plan review ledger

- `P1-SEC-001` — **fixed**. Phase 1 now distinguishes unauthenticated static shell/assets from authenticated application APIs. Exact Host/security headers still apply globally; every `/api/v1` route except health requires bearer auth; SSE uses authenticated fetch rather than native EventSource.
- `P1-UI-001` — **fixed**. Eight legacy-rendered Phase 1 authority images freeze Today/Inbox at desktop/mobile in light/dark with a fixed clock, seed, viewport, and blocking diff tolerance. Rewrite-generated screenshots cannot silently replace them.
- Phase 1 focused planning recheck — **approved**. Both `P1-SEC-001` and `P1-UI-001` are closed with no remaining blocker.
- `P1-FINAL-LIFE-001` — **fixed**. SSE `forward_events` tasks now select on stream receiver closure, process shutdown cancellation, and broadcast work; `send_event` also selects on disconnect/shutdown while awaiting a full mpsc buffer so backpressured catch-up cannot hang shutdown; `main` cancels a process-wide `CancellationToken` when shutdown is requested before Axum drains in-flight responses; concurrent authenticated SSE connections are hard-capped at 64 per process with retryable `503 sse_connection_limit`. Dropped bodies and SIGINT/SIGTERM with an open SSE stream release forwarders and profile locks.
- `P1-FINAL-CONV-001` — **fixed**. React applies authoritative list snapshots monotonically by server revision, coalesces reloads to one in flight plus one follow-up, and upserts mutation results by task ID. Deterministic reversed-response and own-event-before-response tests pass.
- `P1-FINAL-GATE-001` — **fixed**. The authoritative five-sample report passes the frozen 24 MiB warm / 32 MiB peak ceilings and records exact variance/regression rules.
- `P1-FINAL-TM-001` — **fixed**. Bearer holders are untrusted for availability; the 64-stream nonblocking cap enforces that decision.
- `DOGFOOD-001` — **fixed**. Same-page connection fragments now authenticate and scrub without a forced reload; focused Playwright and real Tailnet retests pass.
- `P1-CI-VIS-001` — **fixed**. GitHub's browser runner resolved `system-ui` to DejaVu Sans while the immutable legacy authorities used Noto Sans. CI now checksum-verifies and installs the exact Ubuntu 24.04 Noto packages used for capture, asserts font resolution, and retains failure images for diagnosis; all eight visual comparisons pass remotely.
- `PLAN-001` — **fixed**. Added all five Smart Nudge behaviors and session dismissal semantics to the inventory, Phase 3 implementation and acceptance. Added plugin dependency constraints, dependency-first activation, dependent-aware disable/removal, missing/incompatible failures and cycle rejection to the inventory, Phase 7 work and acceptance.
- `PLAN-002` — **fixed**. Phase 1 must freeze a numeric final hosted-memory ceiling and exact protocol before Phase 2; Phase 9 must pass it and cannot waive it by explaining cumulative deltas.
- `PLAN-003` — **fixed**. Phase 8 and Phase 9 now require target-native package/install/launch evidence for Linux x64, macOS Intel/ARM64 and Windows x64/ARM64. Only an explicit recorded user exception can permit a missing target.
- Focused recheck — **approved**. The planning reviewer found no remaining blocker in `PLAN-001`–`PLAN-003`.
- Phase 10 planning review — **approved**. The final audit is bounded by evidence and stable findings, has observable DX/docs/quality acceptance, and precedes rather than follows the separately approved release tag.
- Phase 6 planning review — **approved after fixes**. `P6-PLAN-001`–`P6-PLAN-005` close secret backup/restore authority, dispatch/cancel linearization, aggregate quotas and mutation policy, manifest-verified real local-engine acceptance, and independent legacy-rendered visual authorities.
- `DBPLAN2-001`–`DBPLAN2-006` — **fixed and approved**. Phase 2 freezes a generalized one-event-per-revision envelope, SQLite table rebuild, bounded cascade/receipt/event payloads, complete delete-undo closure, pending-only completion cascade, and explicit section deletion. Focused database recheck approved implementation.
- Phase 2 final review — **approved after fixes**. Frontend, accessibility, database and API findings plus six dogfood issues are fixed with focused regressions. Targeted closure re-review confirmed `P2-CLOSE-001`–`P2-CLOSE-003` fixed with no material finding remaining; the full ledger is `evidence/phase-2-review-ledger.md`.
- `P3-REC-001`, `P3-REM-001`, `P3-MIG-001`, `P3-TIME-001`, `P3-BOUND-001`, `P3-UI-001` — **fixed and approved**. Phase 3 now freezes recurrence/uncomplete transitions, fenced reminder control-plane semantics and shutdown, verified pre-migration recovery, durable blocks/slots and ordered membership, numeric API/performance limits, and twelve independent legacy-rendered visual authorities.
- `P3-FINAL-003` — **fixed**. Matrix consumes the existing authoritative task-list civil date; daily and weekly planning/review reads expose their sampled civil date, and ritual reschedules derive today/tomorrow from that response rather than browser time. Rust API and non-default-browser-timezone frontend regressions cover the contract.
- `P3-FINAL-007` — **fixed**. A one-shot, bounded SQLite analysis snapshot replaces 100 paged task-list reads and per-task tag hydration. The final same-head five-sample 10,000-task rerun passed the frozen 24/32 MiB memory ceiling (16.7812 MiB median / 23.8047 MiB maximum warm; 25.6328 MiB maximum peak), Stats p95 27.356 ms (150 ms budget), Nudges p95 29.528 ms (100 ms budget), and all scheduler lifecycle checks. Raw evidence: `evidence/phase-3-temporal-bench.json`.
- `P3-FINAL-008` — **fixed**. Replan preview and mutation now share Rust server-local civil-date authority and an exact bounded candidate-ID expectation; SQLite rejects date or candidate drift atomically, and the browser refreshes rather than selecting destructive candidates from its own clock.
- `P3-FINAL-009` — **fixed**. Timeblocking mutations no longer advertise or push unsupported Undo entries, preserving earlier valid task undo history.
- `P3-FINAL-010` — **fixed**. Calendar planning controls now await authoritative task mutations and keep the selected task on failure instead of reporting success and clearing selection optimistically.
- Phase 3 final review — **approved after fixes**. All reminder/storage findings and `P3-FINAL-001`–`P3-FINAL-016` are closed with focused regressions. The final closure hardened recurring reversal sidecars, reminder and recurring-timeblock timezone edits, immutable cancellation transitions, v3 undo-snapshot migration, and bounded migration memory; focused database re-review found no remaining material issue. Full ledger: `evidence/phase-3-review-ledger.md`.
- Phase 4 final review — **approved after fixes**. Database `P4-DB-001`–`P4-DB-010` plus `P4-DB-R1`, security `P4-SEC-001`–`P4-SEC-003`, UI `P4-UI-001`–`P4-UI-006` plus `P4-UI-R1`, and dogfood `P4-UI-DOG-001` are closed with focused regressions. Database, security, and UI gates found no remaining material issue; full ledger: `evidence/phase-4-review-ledger.md`.
- Phase 5 Wave 1 security review — **approved after fixes**. `P5-SEC-001`–`P5-SEC-004` close ambiguous credential creation, output-parent metadata mutation, Windows token DACL, and Windows write-through replacement findings with focused regressions. Full ledger: `evidence/phase-5-review-ledger.md`.
- Phase 5 Wave 2 API-contract review — **approved after fixes**. Exact-delta recheck `630ac80..3ccb221` approved `P5-API-001`–`P5-API-011`, covering catalog result schemas, token-rotation recovery, secret-safe generic tools, bulk confirmation, side-effect annotations, cross-platform private/durable downloads, strict JSON parser failures, pure-parser metadata, restore ambiguity, and the operator access label.
- Phase 5 final API-contract review — **approved after fixes**. `P5-API-012`–`P5-API-018` and `P5-DOG-001` close catalog identity, scoped MCP projection, lifecycle/progress/cancellation, concise secret-safe human output, and the discovered temporary-owner handoff race. Exact-delta recheck found no material contract issue remaining; full ledger: `evidence/phase-5-review-ledger.md`.
- Phase 6 Wave 1 database review — **approved after fixes**. `P6-DB-001`–`P6-DB-007` close hostile restore validation, approval/run crash consistency, immutable run identity, cross-session messages, receipt-safe private credential verification, restore-test isolation, and indexed historical approval validation. Focused exact-delta recheck found no material persistence issue remaining; ledger: `evidence/phase-6-review-ledger.md`.
- Phase 6 final security review — **approved after fix**. `P6-FINAL-SEC-001` removed generic approval-card argument truncation so operators see every field/item in the exact action they approve. A valid 100-task bulk mutation regression and narrow security recheck found no remaining blocker; full ledger: `evidence/phase-6-review-ledger.md`.

## Decision log

- 2026-07-28: chose a fresh repository because there are no active users or compatibility obligations and the existing architecture would make a clean Rust runtime harder to achieve.
- 2026-07-28: preserved the React design as a non-negotiable product contract.
- 2026-07-28: chose SQLite as the only live store and Markdown as import/export.
- 2026-07-28: chose Wasmtime + Component Model + WASI P2 as the plugin direction; TypeScript authoring is compiled ahead of time and does not imply runtime Node.
- 2026-07-28: made `Junban-legacy` private, archived and read-only; created the new `Junban` repository privately until its initial foundation is approved and coherent.
- 2026-07-28: declined a guessed RAM promise; Phase 1 evidence will establish the numeric final hosted-memory ceiling, exact protocol, variance and regression rule that Phase 9 must pass.
- 2026-07-28: user approved the plan and required Google's code-health posture: good functional progress, small focused changes and no speculative overengineering.
- 2026-07-28: froze eight deterministic legacy-rendered Today/Inbox reference scenes for Phase 1 rather than allowing the rewrite to generate its own visual authority.
- 2026-07-28: selected one dedicated long-lived SQLite connection thread rather than a pool. The required Phase 1 mutation volume is serialized, executor threads never block on SQLite, and a pool would add ownership and memory complexity without demonstrated benefit.
- 2026-07-28: selected Utoipa-derived OpenAPI plus checked `openapi-typescript` output. Rust transport DTOs and route annotations remain the only hand-maintained contract authority; generation and non-mutating drift checks cover both artifacts.
- 2026-07-28: froze the final hosted-server budget at 24 MiB maximum warm / 32 MiB peak after the integrated Phase 1 run measured 9.23 / 9.41 MiB maxima. Later phases use the same protocol and cannot waive the final ceiling.
- 2026-07-29: user requested uninterrupted sequential execution through Phase 9 and added Phase 10 for a deep codebase, DX and documentation audit. Release publication now follows that audit and still requires a separately approved tag.
- 2026-07-30: completed Phase 2 without adding crates or runtime owners. Recurrence remains validated rule storage only; Phase 3 owns occurrence generation, reminders and planning semantics. Final release-binary evidence passed at 6.96 MiB median warm for the frozen workload and 15.18 MiB maximum warm for deterministic 10,000-task scale.
- 2026-07-30: Phase 3 keeps the four-crate architecture and adds no scheduler/recurrence framework. One dormant Tokio wake loop, fenced browser/native delivery ownership, verified v2 backup before schema v3 migration, bounded virtual time recurrence, and independent legacy visual authority are required.
- 2026-07-31: the Phase 3 temporal benchmark extends the existing hosted cgroup harness and existing development-only scale seeder rather than adding a runner or dependency. Its recurring bulk covers 250 sources plus 250 generated children because the frozen 500 affected-task ceiling includes generated occurrences.
- 2026-07-31: completed Phase 3 over the existing four crates with no scheduler/recurrence framework. One dormant reminder coordinator, server-civil-date planning authority, exact replan candidate binding, immutable cancellation-transition history, and immutable Phase 3 visual authorities preserve correctness while keeping the optimized 10,000-task workload below 18.20 MiB peak.
- 2026-08-02: completed Phase 4 in the existing four crates. Settings remain one typed server-confirmed aggregate; complete backups use private bounded staging and fail-closed recovery; one server-wide permit serializes large artifacts; the legacy Settings modal is the visual authority. Linux drops durable rollback file-cache pages before cutover so a 10,000-task restore remains under the frozen 32 MiB peak without weakening rollback.
- 2026-08-02: approved the Phase 5 contract plan after `P5-PLAN-001` and `P5-PLAN-002` were fixed. Phase 5 adds the two planned CLI/MCP crates, uses official slim `rmcp` over persistent stdio, verifies local owners through versioned instance-matched metadata, and uses one authenticated HTTP execution path with an in-process temporary owner after exclusive lock acquisition. Automation credentials are private-file-backed, hashed, non-admin, and scope-limited; explicit remote targets require a credential file, HTTPS, no redirects, and no URL credentials.
- 2026-08-02: completed Phase 5 with an 87-tool OpenAPI-bound catalog shared by native CLI and MCP. No-owner clients host the existing Rust owner in-process only after exclusive lock acquisition; discovered local clients receive one bounded ownership handoff only for a definitive non-timeout pre-dispatch connect failure. The accepted automation result retains a failed raw owner-delta assertion and applies the frozen `durable-sqlite-state-growth` disposition only after matched idle controls and absolute 24/32 MiB ceilings passed.
- 2026-08-02: Phase 6 local Piper defaults to `en_US-ljspeech-medium` rather than the legacy HFC female package. Both preserve an English female local fallback, but LJ Speech source data is public domain while HFC records CC-BY-NC-SA-4.0 source-data terms. Exact model revision, sizes, hashes, and license evidence are frozen in `evidence/phase-6-local-voice-manifest.json`; weights remain optional browser downloads and are not distributed or backed up.
- 2026-08-04: Phase 6 auto-schedule application is a distinct approval-required tool that accepts only the exact immediately preceding successful preview in the same run. It creates at most 16 ordinary Phase 3 time blocks through deterministic child operations; no hidden apply mode or direct unpreviewed mutation exists.
- 2026-08-04: Phase 6 disabled acceptance uses the same-host Phase 5 parent/Phase 6 head matched protocol, while enabled acceptance is separate local-mock evidence. The final accepted candidate passed at 8.3711 MiB disabled median warm and 11.0898/13.3164 MiB enabled maximum post-session warm/cgroup peak without a waiver.
- 2026-08-04: completed Phase 6 with lazy Rust provider/chat/tool/speech services, private receipt-first credentials, durable approval/recovery/cancellation, preview-bound schedule application, and hash-gated browser-local voice. Final security review found and closed complete approval-argument visibility; no reviewed finding remains.
- 2026-08-04: Phase 7 Wave 1 starts SDK-first. `junban-plugin-sdk` owns exact package/WIT/trust/capability/graph/index/component/protocol data authority and bounded pure verification only. Default server linkage touches one static table, feature-off remains the matched baseline, and Wasmtime remains absent. Schema v7, runtime/process I/O, routes, persistence, registry, UI, and reference plugins wait for the parent-run memory gate and package security review.

## Discoveries and risks

- The legacy Tailnet memory reading is reproducible: the launcher plus TypeScript/Node server measured 179.25 MiB warm on this host.
- The legacy UI is fetch-first in active behavior, so removing dormant direct/sql.js branches is feasible without redesigning components.
- The UI still imports many legacy domain helpers and types. Copying `src/ui` wholesale would import the old architecture; migration must be vertical and contract-led.
- Real TypeScript plugins through `componentize-js` carry a JavaScript-engine memory cost. They must load lazily and be measured separately.
- Arbitrary React plugin rendering conflicts with a capability-limited portable package model. Declarative host-rendered plugin UI is the safe replacement.
- One database authority is easy for web and desktop but needs deliberate CLI/MCP ownership behavior.
- AI provider APIs and local voice tooling change quickly; implementation must verify current official contracts rather than port old adapters blindly.
- The most likely way to lose the memory benefit is eager initialization or dependency aggregation. Per-phase release-memory evidence is therefore part of correctness, not optional optimization.
- Phase 0: the official Vite React-TS template already prefers Oxlint over ESLint, which keeps the frontend toolchain smaller without a custom lint stack.
- Phase 0: Tailwind v4 via `@tailwindcss/vite` needs no `tailwind.config` for an empty shell; keep config absent until design tokens are ported.
- Phase 0: with an empty Rust dependency graph, wiring `cargo-audit`/`cargo-deny` into CI would only compile tooling noise; gate them when Phase 1 adds production crates.
- Phase 0: a root `pnpm-workspace.yaml` is required even for this single-package repo so a checkout nested beneath an unrelated ancestor workspace remains reproducible and audits only Junban.
- Phase 0: Dependabot's first activation proposed incompatible TypeScript 7 and Node 26 type majors. Routine patch/minor updates are now grouped; major upgrades require an explicit migration decision instead of automatic PR churn.
- Phase 1 planning: URL fragments never reach the server, so bearer-protecting static assets would make browser bootstrap impossible. Static shell/assets stay unauthenticated but exact-Host/security-header protected; the fragment token authenticates API fetches including SSE.
- Phase 1 planning: existing broad screenshots were not a valid exact-design gate for the reduced Phase 1 field set. A private legacy capture produced eight fixed-reference scenes instead.
- Phase 1 backend: `rusqlite` 0.40's bundled build dependency requires an unstable `cfg_select` on pinned Rust 1.93, so Phase 1 uses `rusqlite` 0.39 with only bundled/cache features. No product behavior is lost.
- Phase 1 lifecycle/CI hardening: default profiles use OS app-data paths (`$XDG_DATA_HOME/junban` or `$HOME/.local/share/junban`, macOS Application Support, Windows LocalAppData) with `./data` only as an env-missing fallback; Unix graceful shutdown selects the first of Ctrl-C or SIGTERM; CI installs checksum-verified prebuilt `cargo-audit`/`cargo-deny` via SHA-pinned `taiki-e/install-action` and runs release-binary Playwright E2E without compiling supply-chain tools from source.
- Phase 1 SSE lifecycle: idle forwarders that only awaited broadcast recv could outlive dropped HTTP bodies and block Axum graceful shutdown; explicit disconnect/shutdown cancellation plus a hard 64-connection cap close that availability gap without configuration surface.
- Phase 1 convergence: unconstrained SSE reloads could apply older list responses after newer ones or duplicate an own-created task; revision-monotonic snapshots, coalesced reloads and task-ID upserts close the race without adding a state library.
- Phase 1 dogfood: opening a complete connection URL worked, but adding its fragment to an already-open connection screen was same-document navigation and skipped mount-only bootstrap. A small `hashchange` listener restored the plausible recovery path.
- Phase 1 CI: screenshot comparisons were deterministic locally but not across Linux font sets; every remote diff covered text rendered with DejaVu instead of the capture host's Noto Sans. Pinning the checksum-verified Noto package in the visual-test job makes the design gate portable without changing production typography.
- Phase 2 persistence: one schema-v2 migration and one dedicated SQLite worker were sufficient for complete task organization; no pool, FTS dependency or event-sourcing layer was required. A 250-page WAL auto-checkpoint removed periodic write-tail outliers while retaining full durability.
- Phase 2 client correctness: view membership, own-response convergence, undo/redo identity and blocking-layer isolation needed explicit authority; focused pure helpers and component regressions closed those races without a state-management dependency.
- Phase 2 scale: the final deterministic 10,000-task run stayed below 15.36 MiB peak and all p95 budgets by wide margins, so the simple indexed SQL query path remains authoritative.
- Phase 3 temporal benchmark: paged full-task analysis made 100 repository calls and hydrated each task and tags individually. One bounded read transaction now loads task rows and tags in two batched queries; the final same-head five-sample rerun passed Stats at 27.356 ms p95 and Nudges at 29.528 ms p95 without relaxing frozen limits.
- Phase 3 closure: coupling ordinary timeblocking loads to destructive replan preview made a bounded preview overflow hide valid schedule data. Preview failure is now isolated, keeps blocks/slots visible, and explains why replan is unavailable.
- Phase 4 recovery: validating an upload is not sufficient if catastrophic state is only in memory. Durable recovery and cutover markers are reconciled while the profile lock is retained before any ordinary SQLite open, and hostile typed rows are rejected before maintenance.
- Phase 4 performance: restore peak was file-cache pressure rather than heap growth. The first authoritative run retained three simultaneous 6.8 MiB SQLite copies and failed at 32.8086 MiB; syncing then advising away only rollback cache pages reduced the accepted maximum peak to 25.2617 MiB while preserving the rollback file.
- Phase 4 dogfood: intentional restart-required cutover could race a terminal SSE callback and show a contradictory retry banner. A synchronous restart-required gate now clears and suppresses realtime errors only after successful restore; failed restores keep ordinary realtime behavior.
- Phase 5 ownership: successful instance-matched discovery does not itself lease a temporary owner. A one-shot owner can exit before the discovered client's first request; one bounded reconnect on a definitive non-timeout connect failure closes that gap without replaying restore or any ambiguous sent write.
- Phase 5 memory: state-creating MCP samples can retain about 1 MiB of new SQLite/WAL file cache after 50 mutations while idle controls remain flat. The protocol keeps the raw relative failure visible and permits the explicit durable-state disposition only when process count, cleanup, no-Node checks, and absolute 24/32 MiB ceilings all pass.
- Phase 6 local voice: immutable Hugging Face `resolve/<commit>` URLs redirect large files to HF-owned content bridges. Junban sends no credentials or query material, validates final HTTPS delivery hosts, and treats exact size plus SHA-256 as the trust anchor before marker-gated OPFS admission. Mutable package download defaults are patched out, and ordinary startup contains no engine/model static graph.
- Phase 6 Wave 1 secrets: provider/speech bytes stay out of SQLite and complete backups by using a private versioned `ai-secrets.json` with receipt-first binding. Failed publication leaves settings unchanged; failed binding leaves only an orphan file entry; startup reconciliation removes unreferenced IDs diagnostically without inventing bindings. Candidate restore clears every credential binding and forces AI/cloud speech disabled before cutover while preserving chat/memory/preferences.
- Phase 6 Wave 5 dogfood: proposal controls must remain usable while the provider run waits on approval; provider cancellation must race the response-header future, not only body streaming; and `@ricky0123/vad-web` overwrites directory-style ORT paths during construction, so Junban must install exact hashed `.mjs` and `.wasm` URLs after that default is applied. Focused regressions and optimized browser reruns close all three boundaries.
- Phase 6 dependency audit: a newly published high-severity `brace-expansion` advisory affected only the development OpenAPI tool chain. Raising the existing exact override from 5.0.8 to 5.0.9 restored a clean audit without changing runtime dependencies.

## Outcome and retrospective

### Phase 0

- **Outcome:** reproducible Rust workspace + frontend toolchain + narrow repo checks + docs skeletons. No product behavior.
- **Evidence:** `goals/rust-rewrite/evidence/phase-0-foundation.md`
- **Local commands passed:** `cargo fmt --all -- --check`; `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`; `cargo test --locked --workspace --all-features`; `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `pnpm check:docs`; `pnpm check:runtime-boundary`; `pnpm check`; `pnpm audit --audit-level high`; `git diff --check`; negative Node-import boundary probe; GitHub API resolution of all Action SHA pins; manual `dist/` inspection (frontend assets only).
- **Review ledger:** `ARCH-001` fixed by making Clippy/tests enforce the committed Cargo dependency graph with `--locked`; canonical commands were aligned. Focused architecture recheck approved the fix with no remaining blocker.
- **Remote verification:** PR #1 required the Rust and frontend/repository checks on its exact final head; both passed before fast-forward merge and again on the main push. The fresh repository was then made public with protected required checks and secret-scanning push protection. A focused policy follow-up grouped routine Dependabot updates and disabled automatic major-version PRs after the first activation exposed that noise.
- **Follow-ups for later phases:** enable `cargo-audit`/`cargo-deny` when Rust production dependencies arrive; begin UI migration and hosted vertical slice in Phase 1.

### Phase 1

- **Outcome:** one optimized Rust server owns one SQLite profile, serves the preserved Today/Inbox shell, and provides authenticated durable create/list/edit/complete/uncomplete/delete plus revisioned live convergence. No shipped Node runtime exists.
- **Evidence:** `goals/rust-rewrite/evidence/phase-1-hosted-vertical-slice.md`; `phase-1-hosted-memory.json`; `phase-1-hosted-memory-budget.md`; `phase-1-tailnet-dogfood/report.md`; eight independent visual authorities under `phase-1-visual-baseline/`.
- **Memory:** five-sample authoritative result passed at 8.79 MiB median / 9.23 MiB maximum warm cgroup memory and 9.41 MiB maximum peak. The final budget is 24 MiB warm / 32 MiB peak.
- **Local commands passed:** Rust format, Clippy with denied warnings, 44 workspace/unit/process tests, release build, `cargo-audit`, `cargo-deny`; `pnpm check` with 41 Vitest tests; 29 Playwright checks including 8 visual and 8 axe/keyboard checks; full and production npm audits; benchmark quick validation and five-sample authoritative run; docs/contract/runtime boundary/diff/privacy checks.
- **Dogfood:** real private Tailscale Serve HTTPS passed create/edit/complete/uncomplete/restart/delete, desktop/mobile rendering and graceful cleanup. `DOGFOOD-001` same-page fragment recovery was fixed and retested.
- **Review:** `P1-FINAL-LIFE-001`, `P1-FINAL-CONV-001`, `P1-FINAL-GATE-001`, and `P1-FINAL-TM-001` are fixed. The focused security recheck found no material named finding remaining.
- **Remote verification:** PR #5 is the protected phase-delivery gate. Rust, Rust supply-chain, frontend/repository, and release-binary E2E checks are all required on its exact merge head; failure screenshots are retained for diagnosis.

### Phase 2

- **Outcome:** complete Rust task and organization domain across the existing four crates and preserved React interface: full task fields, projects, sections, tags, templates, comments, relations, saved filters, search, palette, hierarchy, list/board movement, bulk actions, text/quick-entry parsers, activity, durable operations and conflict-safe undo.
- **Evidence:** `goals/rust-rewrite/evidence/phase-2-outcome.md`; `phase-2-hosted-memory.json`; `phase-2-scale-bench.json`; `phase-2-review-ledger.md`; `dogfood-output/phase-2/report.md`; twelve visual authorities under `phase-2-visual-baseline/`.
- **Memory and scale:** five-sample frozen workload passed at 6.96 MiB median / 7.13 MiB maximum warm and 7.63 MiB maximum peak. Three deterministic 10,000-task samples passed at 14.87–15.18 MiB warm and 15.35 MiB maximum peak; list/view, search/filter, single-mutation and 25-task bulk/reorder p95 were 3.89, 4.25, 3.90 and 8.69 ms respectively.
- **Validation:** 150 Rust tests, 225 frontend tests and 38 Playwright scenarios passed alongside format, Clippy, type, contract, docs, runtime-boundary, npm/Rust audit, benchmark cleanup and no-Node checks.
- **Dogfood and review:** six browser findings plus all API, database, frontend, accessibility and final closure findings are fixed with focused regressions. Targeted re-review confirmed `P2-CLOSE-001`–`P2-CLOSE-003` fixed with no material finding remaining.
- **Follow-up:** Phase 3 activates recurrence occurrence generation, reminders and the planning/time surfaces over the same single worker and SQLite authority.

### Phase 3

- **Outcome:** recurrence, reminders, Calendar, Matrix, planning/review rituals, Focus Mode, motivation features, Stats, Smart Nudges, and first-party timeblocking now run through the Rust authority while preserving the approved React interface.
- **Evidence:** `goals/rust-rewrite/evidence/phase-3-outcome.md`; `phase-3-temporal-bench.json`; `phase-3-phase1-memory-rerun.json`; `phase-3-review-ledger.md`; twelve visual authorities under `phase-3-visual-baseline/`.
- **Memory and temporal scale:** five final same-head 10,000-task samples passed at 16.7812 MiB median / 23.8047 MiB maximum warm and 25.6328 MiB maximum peak. Calendar, timeblocking, Stats, Nudges, recurrence, 500-affected recurrence reversal, and reminder lease/claim p95 budgets all passed. Two preceding high-I/O Calendar-only failures are retained beside the accepted repeat under the frozen variance rule.
- **Validation:** 314 Rust tests, 294 frontend tests, and 77 Playwright scenarios passed alongside release build, format, Clippy, type, contract, docs, runtime-boundary, npm/Rust audit, visual, accessibility, and cleanup checks.
- **Review:** all reminder/storage findings and `P3-FINAL-001`–`P3-FINAL-016` are fixed with focused regressions; narrow final database re-review found no material issue remaining.
- **Follow-up:** Phase 4 adds data portability, complete backup/restore, settings, hosted controls, token rotation, diagnostics, and maintenance barriers without creating a second live store.

### Phase 4

- **Outcome:** typed server-confirmed Settings, import/export, complete backup and fail-closed restore/recovery, hosted policy/token controls, diagnostics, and multi-client epoch recovery now run through the existing Rust authority while preserving the approved Settings modal.
- **Evidence:** `goals/rust-rewrite/evidence/phase-4-outcome.md`; `phase-4-data-bench.json`; retained `phase-4-data-bench-failed.json`; `phase-4-data-benchmark-protocol.md`; `phase-4-review-ledger.md`; `phase-4-dogfood/report.md`; ten immutable visual authorities under `phase-4-visual-authority/`.
- **Memory and data scale:** three final 10,000-task samples passed at 6.6562 MiB median / 6.8516 MiB maximum post-restore warm memory and 25.2617 MiB maximum peak. Timed JSON export, backup and restore evidence plus exact transfer/restore counts, integrity, cleanup, and restart-boundary checks passed; CSV and Markdown behavior remain covered by focused transfer tests. The preceding 32.8086 MiB restore failure is retained with its root-cause correction.
- **Validation:** 389 Rust tests, 345 frontend tests, and 91 Playwright scenarios passed alongside release build, format, denied-warning Clippy, type, contract, docs, runtime-boundary, npm/Rust supply-chain checks, visual and accessibility gates, benchmark self-check, exact backup/restore evidence, and dogfood.
- **Dogfood and review:** the real production build completed connection, settings, feature-gate, task, export, backup, restore, restart and integrity workflows. `P4-UI-DOG-001` was fixed and rechecked. Database, security, and UI specialist gates approved all named findings with no material issue remaining.
- **Follow-up:** Phase 5 adds native CLI and MCP surfaces over the same Rust application/storage authority without direct competing database ownership.

### Phase 5

- **Outcome:** native Rust CLI and persistent stdio MCP expose the Phase 1–4 feature set through one 87-tool OpenAPI-bound catalog, scope-filtered automation principals, and the existing single-owner HTTP/application path. No direct CLI/MCP SQLite path or runtime Node process exists.
- **Evidence:** `goals/rust-rewrite/evidence/phase-5-outcome.md`; `phase-5-conformance.json`; `phase-5-automation-bench.json`; retained `phase-5-automation-owner-delta-raw.json`; `phase-5-review-ledger.md`; `phase-5-dogfood/report.md`; frozen conformance and benchmark protocols.
- **Conformance:** HTTP, attached CLI, no-owner CLI, and MCP completed the same 17 revisions and produced digest `8b511fadf02c066077e124fd7c4fe63b9d2c30df1ad45778b996c84cc7c5ca70` with state, events, errors, exports, backup, cleanup, and secret assertions passing.
- **Performance:** accepted optimized results passed at 22.092 ms active-owner CLI p95, 62.535 ms no-owner CLI p95, 3.729/0.320 ms MCP create/get p95, 20.4648/20.9922 MiB attached MCP maximum warm/peak, and 21.9805/22.7227 MiB local-owner MCP maximum warm/peak. The raw relative owner-delta failure and explicit durable-SQLite-state disposition are both retained; no absolute ceiling was waived.
- **Review and dogfood:** `P5-SEC-001`–`P5-SEC-004`, `P5-API-001`–`P5-API-018`, and `P5-DOG-001` are fixed with focused regressions and exact-delta approval. Manual use found and closed noisy human mutation rendering; authoritative lifecycle then found and closed the post-discovery temporary-owner exit race.
- **Follow-up:** Phase 6 adds optional Rust AI/provider/voice services and preserved UI over the same catalog/application authority, with zero idle initialization when disabled.

### Phase 6

- **Outcome:** optional Rust provider, chat, tool/approval, scheduling, cloud-speech, and private-secret services now back the preserved AI/voice interface. Browser-only Whisper, Kokoro, Piper, and VAD remain dynamically isolated and hash-gated; disabled startup constructs no provider/model/media runtime.
- **Evidence:** `goals/rust-rewrite/evidence/phase-6-outcome.md`; `phase-6-disabled-matched-release.json`; `phase-6-enabled-benchmark.json`; `phase-6-conformance.json`; `phase-6-wave-5-local-voice-acceptance.json`; `phase-6-dogfood/report.md`; `phase-6-review-ledger.md`; sixteen immutable legacy visual authorities.
- **Performance:** five matched disabled pairs passed at 8.3711 MiB median / 8.8477 MiB maximum warm and 8.9727 MiB maximum peak, only 0.2969 MiB above the 8.0742 MiB Phase 5 parent median. Three enabled local-mock profiles passed at 11.0898 MiB maximum post-session warm and 13.3164 MiB maximum cgroup peak; first-event, completed-turn, cancellation, STT/TTS, cleanup, growth, secrecy, and process gates all passed.
- **Validation:** 837 Rust tests, 606 frontend tests, 133 full Playwright tests, and two opt-in real local-voice acceptance tests passed alongside format, denied-warning Clippy, production build, contracts, docs, runtime/local-asset/visual checks, Rust/npm audits, schema-v6 cross-surface conformance, and both authoritative performance protocols.
- **Dogfood:** exact optimized provider setup, chat/history/read tools, mutation approve/reject, withheld-header cancellation, focused Ask AI, preview-bound schedule application into Timeblocking, VAD call cleanup, backup/restore, and disabled-state recovery passed. `P6-DOG-001`–`P6-DOG-004` are closed with focused regressions.
- **Review:** all persistence, architecture, security, API, tool-run, frontend, accessibility, dogfood, and final security findings are closed. `P6-FINAL-SEC-001` made complete exact generic mutation arguments visible before approval; the narrow recheck approved Phase 6 with no remaining blocker.
- **Follow-up:** Phase 7 adds capability-limited portable plugins without weakening the lazy-disabled, secret, restore, network, or no-runtime-Node boundaries established here.
