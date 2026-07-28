# Ground-up Rust Rewrite of Junban

This ExecPlan is the live authority for rebuilding Junban around a Rust application core while preserving the approved React interface. It follows `PLANS.md` and must remain current as implementation proceeds.

**Status:** approved by the user on 2026-07-28. Phase 0 is active.

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

No arbitrary final RAM promise is frozen before implementation evidence exists. Phase 1 establishes the first native Junban budget from an optimized implementation. **Before Phase 2 begins**, that evidence must produce a numeric final hosted-server ceiling, exact idle/warm workload protocol, allowed measurement variance, and per-phase regression rule. Phase 9 must pass that same protocol and ceiling; explaining individual deltas cannot waive the final bound. Every later phase records its memory delta, and an unexplained material regression blocks that phase. Final acceptance also requires no resident Node process.

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

### Tasks and organization — Phases 1–2

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
- recurring tasks with exact undo/reversal semantics

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

### Product posture and release — Phase 9

- no account, telemetry or mandatory cloud service
- local-first defaults and private data paths
- accessibility and keyboard-only acceptance
- cross-platform source and package documentation
- checksums, SBOM and provenance/attestation for releases
- clear OS-signing truth
- clean fresh `0.1.x` release history

## Phase graph and acceptance contracts

The dependency chain is `0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9`. Small independent documentation or test work may run in parallel within a phase, but implementation phases do not overlap across an uncommitted boundary.

### Phase 0 — Repository and toolchain foundation

**Outcome:** a public, coherent fresh repository whose empty workspace is reproducible and whose rules prevent old architecture from returning.

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
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `cargo test --workspace --all-features`
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
- implement loopback default, auth, exact host allowlist, body limits and static asset serving;
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
- desktop/mobile screenshot and axe checks pass for the implemented shell;
- Rust unit/integration tests, frontend checks, Playwright task smoke and security review pass;
- decision records cover SQLite worker and contract generation;
- one clean commit: `feat: deliver Rust hosted task vertical slice`.

After evidence, freeze the first native memory regression budget instead of inventing it in advance.

### Phase 2 — Complete task and organization domain

**Outcome:** the Rust server and preserved UI provide complete day-to-day task management without AI, plugins or native desktop dependencies.

Work:

- all task fields, projects, sections, tags, templates, hierarchy, relations, comments and activity;
- bulk actions, ordering, drag/drop contracts and undoable mutations;
- natural-language quick entry and search/query/filter engine;
- saved filters and Inbox/Today/Upcoming/Someday/Completed/Cancelled/Project/Task views;
- Markdown description rendering and import parsing boundaries;
- command palette and relevant keyboard interactions;
- frontend DTO cleanup so components import no legacy domain/runtime modules.

Acceptance:

- feature checklist rows owned by Phase 2 are automated;
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

### Phase 9 — Integrated parity, hardening and first release

**Outcome:** every in-scope feature row is closed with evidence and the fresh Junban can publish its first honest release.

Work:

- close the feature inventory and remove all superseded scaffolding;
- full cross-surface, accessibility, security, performance, recovery and portability pass;
- dogfood Tailnet/web first, then desktop, CLI, MCP, AI/voice and plugins;
- release packaging, checksums, SBOM, provenance and updater-signature policy;
- public setup, security, plugin-author, CLI/MCP and recovery docs;
- create a release only after target-native evidence is complete.

Acceptance:

- no unchecked in-scope inventory row or unresolved severe finding;
- optimized hosted server passes the exact numeric final memory ceiling and workload protocol frozen after Phase 1;
- no release path launches/requires Node;
- target-native package, install and launch smoke evidence is complete for Linux x64, macOS Intel, macOS ARM64, Windows x64 and Windows ARM64; any missing target requires the explicit user-approved release exception defined in Phase 8;
- full screenshot/a11y set demonstrates approved design preservation;
- long-run and crash/recovery tests show no owner/process leaks;
- working tree is clean and all canonical docs match behavior;
- integrated final review passes;
- one clean commit before the separately approved release tag: `chore: complete Junban Rust rewrite`.

## Phase-level validation policy

Run nearest checks first. The expected mature command families are:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
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
- [ ] Phase 0 implementation.
- [ ] Phase 1 implementation.
- [ ] Phase 2 implementation.
- [ ] Phase 3 implementation.
- [ ] Phase 4 implementation.
- [ ] Phase 5 implementation.
- [ ] Phase 6 implementation.
- [ ] Phase 7 implementation.
- [ ] Phase 8 implementation.
- [ ] Phase 9 implementation.

## Plan review ledger

- `PLAN-001` — **fixed**. Added all five Smart Nudge behaviors and session dismissal semantics to the inventory, Phase 3 implementation and acceptance. Added plugin dependency constraints, dependency-first activation, dependent-aware disable/removal, missing/incompatible failures and cycle rejection to the inventory, Phase 7 work and acceptance.
- `PLAN-002` — **fixed**. Phase 1 must freeze a numeric final hosted-memory ceiling and exact protocol before Phase 2; Phase 9 must pass it and cannot waive it by explaining cumulative deltas.
- `PLAN-003` — **fixed**. Phase 8 and Phase 9 now require target-native package/install/launch evidence for Linux x64, macOS Intel/ARM64 and Windows x64/ARM64. Only an explicit recorded user exception can permit a missing target.
- Focused recheck — **approved**. The planning reviewer found no remaining blocker in `PLAN-001`–`PLAN-003`.

## Decision log

- 2026-07-28: chose a fresh repository because there are no active users or compatibility obligations and the existing architecture would make a clean Rust runtime harder to achieve.
- 2026-07-28: preserved the React design as a non-negotiable product contract.
- 2026-07-28: chose SQLite as the only live store and Markdown as import/export.
- 2026-07-28: chose Wasmtime + Component Model + WASI P2 as the plugin direction; TypeScript authoring is compiled ahead of time and does not imply runtime Node.
- 2026-07-28: made `Junban-legacy` private, archived and read-only; created the new `Junban` repository privately until its initial foundation is approved and coherent.
- 2026-07-28: declined a guessed RAM promise; Phase 1 evidence will establish the numeric final hosted-memory ceiling, exact protocol, variance and regression rule that Phase 9 must pass.
- 2026-07-28: user approved the plan and required Google's code-health posture: good functional progress, small focused changes and no speculative overengineering.

## Discoveries and risks

- The legacy Tailnet memory reading is reproducible: the launcher plus TypeScript/Node server measured 179.25 MiB warm on this host.
- The legacy UI is fetch-first in active behavior, so removing dormant direct/sql.js branches is feasible without redesigning components.
- The UI still imports many legacy domain helpers and types. Copying `src/ui` wholesale would import the old architecture; migration must be vertical and contract-led.
- Real TypeScript plugins through `componentize-js` carry a JavaScript-engine memory cost. They must load lazily and be measured separately.
- Arbitrary React plugin rendering conflicts with a capability-limited portable package model. Declarative host-rendered plugin UI is the safe replacement.
- One database authority is easy for web and desktop but needs deliberate CLI/MCP ownership behavior.
- AI provider APIs and local voice tooling change quickly; implementation must verify current official contracts rather than port old adapters blindly.
- The most likely way to lose the memory benefit is eager initialization or dependency aggregation. Per-phase release-memory evidence is therefore part of correctness, not optional optimization.

## Outcome and retrospective

Not yet applicable. Update this section at each completed phase with the commit, commands, evidence, material review decisions and any adjustment to later phases.
