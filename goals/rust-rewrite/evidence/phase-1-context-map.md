# Phase 1 context map

Date: 2026-07-28

Active base: `3f3e5fa078606162982a758d57b1dc8f1fa9be76`

Legacy visual/behavior authority: private sibling `Junban-legacy` at `5e2b2b5adc865f401843c5030285293c5fabccc5`

## Smallest complete outcome

One optimized `junban-server` Rust process owns a fresh SQLite profile, serves the built React assets, authenticates API requests, and supports create/list/replace/complete/uncomplete/delete for tasks. Inbox and Today preserve the approved shell and interaction styling for the fields implemented in this phase. Two browser clients converge through a revisioned SSE feed. No release runtime requires Node.

This phase deliberately does not port the full task model, project tree, planning widgets, AI, plugins, desktop lifecycle, or the legacy backend. Those belong to later phases.

## Context map

### Files to modify or create

| File/path                                                                                      | Purpose                               | Phase 1 change                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cargo.toml`, `Cargo.lock`, `deny.toml`                                                        | Workspace dependency/audit policy     | Add only current Phase 1 dependencies, optimized release profile, and license/source policy                                                                                                                                             |
| `crates/junban-domain/**`                                                                      | Pure task/value semantics             | Add validated UUID v7 IDs, task title/status, date-only and instant types, task entity, replacement input, and domain tests                                                                                                             |
| `crates/junban-app/**`                                                                         | Use cases and ports                   | Add async repository port, idempotent task operations, post-commit event sink, errors, and tests with a fake repository                                                                                                                 |
| `crates/junban-storage/**`                                                                     | Sole SQLite authority                 | Add owner lock, private profile files, schema v1/migrations, one dedicated connection worker, transactional receipts/activity/events, restart/lock tests                                                                                |
| `crates/junban-server/**`                                                                      | Hosted runtime and contract authority | Add Axum composition, `/api/v1`, DTO/OpenAPI generation, bearer auth, bounded invalid-auth attempts, exact Host/Origin checks, body limits, SSE, static SPA fallback, runtime metadata, graceful shutdown, and binary/integration tests |
| `openapi/junban-v1.json`                                                                       | Checked public contract               | Generate deterministically from Rust DTOs/routes; never hand-edit                                                                                                                                                                       |
| `src/ui/api/**`                                                                                | Browser-only network boundary         | Add generated OpenAPI types plus a focused fetch/SSE client and operation IDs                                                                                                                                                           |
| `src/ui/themes/**`, `src/index.css`, `index.html`, `public/images/**`                          | Approved visual tokens and assets     | Port deliberately from legacy; use local font assets/packages rather than runtime remote fonts                                                                                                                                          |
| `src/ui/app/**`, `src/ui/components/**`, `src/ui/views/**`, `src/ui/hooks/**`, `src/ui/lib/**` | Preserved Phase 1 interface           | Add slim shell, sidebar/mobile navigation, Inbox, Today, TaskInput, TaskItem/List, minimum detail editor, loading/empty/error/toast behavior, and theme manager                                                                         |
| `src/App.tsx`                                                                                  | Frontend composition                  | Replace the null Phase 0 shell with only the Phase 1 providers and routes                                                                                                                                                               |
| `tests/e2e/**`, `playwright.config.ts`                                                         | Cross-surface acceptance              | Add authenticated task loop, restart, two-client convergence, screenshots, mobile navigation, keyboard, and axe coverage                                                                                                                |
| `scripts/**`, `package.json`, `pnpm-lock.yaml`                                                 | Developer/build gates                 | Add deterministic contract generation/check, E2E commands, theme guard, benchmark/runtime-boundary checks; no shipped Node runtime                                                                                                      |
| `.github/workflows/ci.yml`                                                                     | Exact-head gates                      | Add contract, cargo audit/deny, browser acceptance, and release-build/runtime-boundary jobs with pinned actions                                                                                                                         |
| `docs/{architecture,security,accessibility,performance,setup}.md`                              | Canonical Phase 1 behavior            | Record implemented ownership, HTTP/auth model, UI subset, commands, and measured decisions                                                                                                                                              |
| `goals/rust-rewrite/{execplan.md,evidence/phase-1-*.md}`                                       | Live authority/evidence               | Record progress, SQLite/contract decisions, validation, screenshots, security review, and optimized memory/startup results                                                                                                              |

### Dependencies and direction

| Owner            | May depend on                                                                | Must not depend on                                                 |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `junban-domain`  | `serde`, `thiserror`, `uuid`, `jiff`                                         | SQLite, Tokio, Axum, Tauri, frontend                               |
| `junban-app`     | `junban-domain`, serialization/error support                                 | SQLite/Axum implementation                                         |
| `junban-storage` | `junban-app`, `junban-domain`, `rusqlite`, `fs4`, channel/runtime primitives | Axum/frontend                                                      |
| `junban-server`  | domain/app/storage, Axum/Tokio/Tower, contract/logging/config support        | Node runtime, direct UI internals                                  |
| React components | `src/ui/api`, frontend-owned hooks/lib, browser-safe UI packages             | Rust internals, Node APIs, legacy core/storage/application modules |

The application repository trait is owned by `junban-app`; `junban-storage` implements it. A single long-lived SQLite connection stays on one dedicated OS thread. Async application calls send commands and await one-shot responses; SQLite never blocks Tokio executor threads and no production pool is retained.

### Contract and runtime decisions

- `/api/v1` is fresh and versioned. Mutations use UUID operation identities and return one consistent error envelope with request ID, code, retryability, and optional field details.
- Rust DTOs derive OpenAPI via Utoipa. Checked OpenAPI generates checked TypeScript types with `openapi-typescript`; CI checks both sides for drift. The handwritten fetch facade is small and typed.
- Date-only values remain `YYYY-MM-DD` civil dates and are never timezone-shifted. Audit/completion timestamps are UTC instants. Task/project/tag/operation IDs are validated wrappers; server-generated entity IDs are UUID v7.
- A persistent random bearer token lives in an owner-only profile file. Browser bootstrap accepts it only from the URL fragment, moves it to session storage, and removes the fragment. Secrets never appear in query strings or normal logs.
- All requests—including the shell and assets—validate the exact `Host` and receive browser security headers. Unsafe browser mutations also reject a mismatched `Origin`. Static shell/assets remain unauthenticated so a browser can bootstrap from a URL fragment. Every `/api/v1` endpoint except health requires bearer auth. Invalid-auth attempts have a small bounded in-memory limiter.
- Static UI is built by Node tooling but served by Rust. API routes are registered before the SPA fallback. Live changes use authenticated fetch-based SSE parsing because native `EventSource` cannot attach the bearer header.
- Every committed mutation atomically writes the task change, durable receipt, activity row, global revision, and durable event. In-process SSE publication happens only after commit. Reconnect resumes from the durable revision.

### Preserved UI references

| Legacy reference                                                                                                        | Phase 1 use                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `src/ui/index.css`, `src/ui/themes/{light,dark,nord}.css`, `src/ui/themes/manager.ts`, `public/images/**` | Exact fonts, tokens, themes, app identity, forced-colors/reduced-motion behavior                                                                                       |
| `src/ui/app/AppLayout.tsx`                                                                                              | Skip link, desktop sidebar, `#main-content`, mobile chrome, loading/error structure                                                                                    |
| `src/ui/components/Sidebar.tsx`, `BottomNavBar.tsx`, `MobileDrawer.tsx`, `FAB.tsx`                                      | Navigation appearance and responsive breakpoint                                                                                                                        |
| `src/ui/views/{Inbox,Today}.tsx`, `views/today/**`                                                                      | Headers, list regions, Today/overdue grouping                                                                                                                          |
| `src/ui/components/{TaskInput,TaskItem,TaskList,TaskDetailPanel}.tsx` and focused subcomponents                         | Row/editor appearance and accessible names; wiring is rewritten                                                                                                        |
| `goals/rust-rewrite/evidence/phase-1-visual-baseline/**`                                                                | Frozen legacy-rendered authority for the exact Phase 1 seed across Today/Inbox, 1440×900 and 390×844, light/dark; compare at threshold 0.2 and max 1% differing pixels |
| legacy `screenshots/{today-light,today-dark,task-detail-dark}.png` and `tests/screenshots/**`                           | Broader reference only; Phase 1 does not claim the later full metadata panel                                                                                           |
| legacy UI/a11y tests for Sidebar, TaskItem, Today, Inbox, AppLayout and mobile drawer                                   | Semantics and interaction references                                                                                                                                   |

Never copy legacy `core`, `application`, `storage`, `server`, `desktop-server`, `db`, `bootstrap`, `ui/api`, sql.js, Vite API plugins, sidecars, or compatibility/replay machinery.

### Visible behavior frozen for Phase 1

- Inbox contains pending tasks without a project and recently completed tasks; all Phase 1 tasks have no project. Pending count drives the badge.
- Today contains pending tasks whose civil due date equals the browser's local day. Pending earlier tasks appear in a separate Overdue group. Creating from Today supplies that civil date; creating from Inbox supplies no date.
- Completion records an instant; uncompletion clears it. A completed task leaves Today and moves below pending Inbox tasks. Delete closes the editor and removes the task everywhere.
- Minimum editor fields are title and nullable due date plus complete/uncomplete and delete. Full description, priority, tags, comments, relations, reminders and other metadata remain Phase 2+ work. Phase 1 does not claim full task-detail screenshot parity.
- Full future sidebar chrome may remain visually present but unavailable items are exposed as disabled, not fake links. Phase 1 acceptance tests only Inbox and Today navigation.
- Live SSE convergence is a deliberate improvement over legacy pull-only multi-client refresh and is required by the approved Phase 1 contract.

## Test files and coverage

| Test area                        | Required coverage                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain unit/property tests       | IDs, title validation, civil-date no-shift, instant serialization, state transitions                                                                                                                                                 |
| Storage integration tests        | schema/migrations, WAL/foreign keys/busy timeout, one-owner exclusion, exact idempotent replay/mismatch, atomic mutation/receipt/activity/event, restart durability                                                                  |
| Server integration/process tests | health, auth/limiter, Host/Origin, body limit, error/request IDs, CRUD/complete loop, SPA/API fallback separation, SSE resume, runtime metadata and graceful lock release                                                            |
| Frontend unit tests              | API error mapping, Today/Inbox grouping, task interactions, fragment bootstrap, loading/error states, theme and accessible names                                                                                                     |
| Playwright                       | create/edit/complete/uncomplete/delete, restart persistence, two pages converge/reconnect, desktop/mobile shell, keyboard focus, axe, and all eight frozen visual comparisons using the recorded clock/seed/viewport/theme/tolerance |
| Release evidence                 | no Node process/backend JS, startup-to-health, idle/warm/peak memory, fixed request sequence and operation latency                                                                                                                   |

## Risk assessment

- [x] New public API and generated contract
- [x] New SQLite schema and migration authority
- [x] Authentication and secret handling
- [x] Exact-design and accessibility preservation
- [x] Cross-platform owner lock/runtime files
- [x] Runtime memory/startup budget
- [ ] Legacy compatibility (explicitly not required)

Highest risks are auth/Host mistakes, duplicate effects after retry, a race between SSE catch-up and subscription, SQLite work escaping onto async threads, generated-contract drift, and accidental wholesale UI/backend copying. Tests and specialist review target those risks directly.

## Context-map review decision

Reviewed by the lead before implementation. Planning-gate findings `P1-SEC-001` and `P1-UI-001` were fixed by defining an unauthenticated static bootstrap with authenticated fetch-SSE and by capturing eight deterministic legacy-derived visual authority images with a blocking diff rule. The focused planning recheck approved both fixes with no remaining blocker. The map is complete enough to proceed with one backend wave followed by a dependent frontend/integration wave. It intentionally rejects a pool, generic shared crate, speculative full task model, full router/framework, legacy compatibility layer, and broad UI copy. Material implementation changes to these boundaries require updating this map and the live ExecPlan first.
