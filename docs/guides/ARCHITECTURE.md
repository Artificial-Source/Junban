# Architecture

## Overview

Junban is a local-first TypeScript application built around a shared domain core. The same business logic powers the React UI, the Hono API server, the CLI, the MCP server, and most plugin integrations.

The architecture is organized around a few stable ideas:

- Core rules live in services, not in UI or transport layers.
- Persistence is abstracted behind a storage interface.
- Browser/Tauri and Node runtimes have different bootstrap paths.
- AI, voice, plugins, and MCP are first-class subsystems, but they all integrate through the same app data model.

## Quick Routes

- Contributor/agent navigation: [`../../AGENTS.md`](../../AGENTS.md)
- Canonical docs map: [`../README.md`](../README.md)
- CLI usage + command examples: [`../how-to/use-cli.md`](../how-to/use-cli.md)
- CLI technical reference: [`../reference/backend/CLI.md`](../reference/backend/CLI.md)

## Top-Level Shape

```text
src/
  main.ts                     Node bootstrap entry
  server.ts                   Hono API entry
  bootstrap.ts                Stable Node bootstrap facade
  backend/                    Backend composition kernel, Node factories, and runtime owner
  bootstrap-web.ts            Browser/Tauri service graph
  bootstrap-web-ai-runtime.ts Lazy browser AI runtime

  core/                       Business logic services
  storage/                    Storage abstraction and backends
  db/                         SQLite schema, clients, migrations, persistence
  parser/                     Natural-language parsing
  ui/                         React app
  api/                        Hono route modules
  ai/                         Providers, chat, tools, voice
  plugins/                    Plugin runtime and sandbox
  mcp/                        MCP adapters
  cli/                        CLI commands
  config/                     Env, defaults, themes
  utils/                      Shared helpers
```

## Runtime Modes

### Node mode

Used by:

- `src/main.ts`
- `src/server.ts`
- `src/cli/index.ts`
- `src/mcp/server.ts`

Node mode still enters through `src/bootstrap.ts`.

`src/bootstrap.ts` is now a thin compatibility facade that delegates to the Node factory in
`src/backend/node-factory.ts`, which prepares runtime-specific dependencies and then composes the
shared backend service graph via `src/backend/kernel.ts`.

When a Node entrypoint also needs plugin lifecycle management, it can use
`src/backend/node-runtime.ts` as a thin owner around those services instead of open-coding plugin
startup/shutdown logic. Runtime initialization errors are surfaced to callers so each entrypoint can
choose fail-fast behavior or catch-and-continue behavior while still retrying through the runtime.
Long-lived Node entrypoints (`src/server.ts` and `src/main.ts`) own signal-driven shutdown and call
`runtime.dispose()` exactly once per termination sequence; the API server closes its listener before
awaiting runtime disposal so it stops accepting new work before teardown.

This path can use either:

- SQLite storage
- Markdown storage

depending on environment configuration.

### Browser and Tauri WebView mode

Used by the React app when running in the browser or inside the Tauri webview.

This path now has two local-runtime variants:

- Plain browser still builds services through `src/bootstrap-web.ts` when it owns persistence in-browser.
- Packaged desktop now starts the existing Node backend as a localhost sidecar and routes the UI through the Hono API.
- The packaged desktop webview now receives an explicit runtime descriptor from Tauri before the app imports API helpers; that descriptor carries the actual sidecar API base, readiness contract, and failure reason instead of relying on a hardcoded localhost port in the frontend.

Important constraint:

- Browser-side code always uses SQLite via `sql.js`
- Markdown storage is Node-only because it requires filesystem access
- Packaged desktop uses the backend-owned SQLite/API path instead of the browser-owned sql.js persistence path
- The packaged desktop sidecar binds an available localhost port at startup, and the frontend learns that dynamic port only through the runtime-descriptor handshake from Tauri
- Readiness validation requires the backend health payload to identify Junban rather than accepting any HTTP 200 responder on that port; if startup fails, Tauri now leaves the app bootable and exposes an unready desktop runtime descriptor so the frontend can render a controlled error state
- If the sidecar later exits, subsequent runtime-descriptor reads report the desktop backend as unready instead of leaving stale ready metadata behind
- Existing packaged-desktop upgrades keep the same AppData-backed SQLite file, so the desktop-backend shift should not require export/import or manual database relocation for normal upgrades
- Existing desktop compatibility/grandfathering behavior for legacy built-in plugins is unchanged by the backend shift; keep that note with the packaged-desktop/frontend transport docs rather than treating it as a storage migration

Desktop remote-access note:

- Packaged Tauri builds can also host a lightweight Rust web server that serves the compiled frontend and brokers authenticated remote access for personal trusted-network use.
- The remote browser path now keeps the existing Rust-owned password/session gate, then proxies authenticated `/api/*` calls to the same localhost Node sidecar backend used by the packaged desktop window.
- Remote browsers no longer bootstrap `src/bootstrap-web.ts` or synchronize the raw SQLite file over HTTP for normal app traffic; the backend remains the owner of API, storage, and plugin/runtime behavior, and the legacy raw `/_junban/db` path is removed.
- The local packaged desktop window is no longer on that browser-owned path; it talks to the bundled Node sidecar over localhost so it uses the same backend API/storage ownership model as source-run server mode.
- Remote access settings are persisted by the Tauri runtime so the desktop app can auto-start the server on launch.
- The desktop window applies an app-level local mutation guard while remote access is active, and the Rust host only authorizes one remote browser session at a time.
- Optional password protection is enforced by the Rust host before the remote browser can reach the proxied backend API. `GET /_junban/session` is now read-only, and both passwordless and passworded remote browsers must perform an explicit `POST` claim/login action before they become the active session. Those POST actions now require same-origin browser headers (`Origin` with `Referer` fallback), and passworded login attempts apply temporary lockout (`429` + `Retry-After`) after repeated failures.
- Remote server startup now fails fast when the packaged desktop sidecar backend is missing or marked unready, so the remote server never advertises a broken API proxy.

The browser/Tauri path also lazy-loads AI runtime code through `src/bootstrap-web-ai-runtime.ts` so the base UI does not pay that startup cost until needed.

## Service Graph

`src/bootstrap-web.ts` remains the browser/Tauri composition root.

For Node paths, the composition boundary is now split into:

- `src/backend/kernel.ts` for runtime-agnostic backend service composition
- `src/backend/node-factory.ts` for Node-specific env, storage, plugin-path, and default AI/tool setup
- `src/backend/node-runtime.ts` for thin plugin lifecycle ownership in long-lived Node entrypoints
- `src/bootstrap.ts` as the stable compatibility entry used by current callers

They assemble:

- Storage
- Core services
- Event bus
- Plugin infrastructure
- Command and UI registries
- AI provider and tool registries supplied by the runtime factory
- Chat manager supplied by the runtime factory

This keeps the rest of the codebase working against explicit services instead of creating hidden global dependencies.

## Core Domain Layer

The core domain lives in `src/core/`.

This layer is responsible for task, project, tag, section, template, stats, and related domain behavior. It should remain the single place where business rules are enforced.

Design rules:

- UI code should not duplicate task rules.
- API routes should delegate to services.
- CLI and MCP should reuse the same core behavior.
- Plugins should extend the app through approved APIs, not by bypassing core rules.

Related domain schemas and shared types live in `src/core/types.ts`.

## Storage Layer

The storage boundary is `src/storage/interface.ts`.

Current backends:

- `src/storage/sqlite-backend.ts`
- `src/storage/markdown-backend.ts`

The purpose of the interface is to let the rest of the application work in terms of capabilities rather than backend details.

### SQLite path

SQLite is the default path and the only storage mode available in browser-side execution.

Supporting files live in `src/db/`:

- `schema.ts` for the Drizzle schema
- `client.ts` for Node SQLite access
- `client-web.ts` for `sql.js`
- `migrate.ts` and `migrate-web.ts` for migrations (both now track applied migrations instead of replaying the whole journal on every run)
- `persistence.ts` for browser/Tauri persistence helpers

### Markdown path

Markdown mode stores data in files and exists for users who want a more human-readable, git-friendly format.

It is supported only in Node runtime paths.

## Frontend Architecture

The React application lives in `src/ui/`.

Main areas:

- `app/` for shell-level composition helpers
- `components/` for reusable UI pieces
- `views/` for screen-level features
- `context/` for shared app state and facades
- `hooks/` for reusable behavior
- `api/` for frontend data access
- `themes/` for theme management and tokens

### Frontend data access

The UI can talk to data in two ways:

- Through the standalone Hono backend
- Through direct service access via `src/ui/api/direct-services.ts`

That means frontend changes should verify which execution path is active before making assumptions.

### Frontend composition

`src/ui/App.tsx` is the top-level orchestration layer. It brings together:

- Routing
- App state
- task handlers
- keyboard shortcuts
- reminders
- modals and overlays
- layout composition

State is intentionally split across hooks and contexts instead of using a global third-party state library.

## API Layer

The standalone backend is `src/server.ts`, built on Hono.

Route modules live in `src/api/`.

The server is responsible for:

- Wiring request handling to core services
- CORS and security headers
- request body limits
- route-specific transport concerns
- mapping domain errors to HTTP responses

The API layer should remain thin. Domain logic belongs in `src/core/`.

## AI Architecture

The AI subsystem lives in `src/ai/` and is separated into a few parts:

- Provider registry and adapters
- Chat/session orchestration
- Tool registration and execution
- Voice provider support

### Provider model

Providers are registered through registry factories for Node and browser contexts.

This allows:

- Multiple built-in providers
- Different loading strategies between runtimes
- Plugin or extension-based provider growth without rewriting the app core

### Tool model

Built-in AI capabilities are registered through `src/ai/tool-registry.ts`.

Tools act on shared Junban services and data rather than owning separate state. This keeps AI actions aligned with normal app behavior.

### Design intent

- AI is optional
- Provider failures should degrade gracefully
- Tool calls should reuse existing domain services
- Browser startup should avoid eagerly loading unnecessary AI code

## Voice Architecture

Voice support lives under `src/ai/voice/`.

The voice subsystem uses provider abstractions similar to the text AI subsystem. The codebase supports browser-native, hosted, and local model paths.

Voice-related UI logic lives in the frontend, but provider/runtime logic stays in the AI voice layer.

## Plugin Architecture

Plugins are implemented through `src/plugins/` and loaded from the `plugins/` directory.

Key pieces:

- Manifest parsing and validation
- Sandboxed execution
- Permission-gated API surface
- Command, UI, and settings registration
- AI extension hooks where allowed

### Plugin design rules

- Plugins should not get unrestricted access to internals.
- Capabilities should be explicit through permissions.
- The plugin API should stay understandable enough for plugin authors and code generation tools.
- Internal plugin infrastructure and author-facing APIs must evolve together.

## MCP Architecture

The MCP server lives in `src/mcp/` with `src/mcp/server.ts` as the entry point.

It exposes Junban functionality to external AI clients over stdio by adapting:

- tools
- resources
- prompts

Critical constraint:

- Because MCP uses stdio for protocol traffic, code in this path must avoid incidental stdout logging.

## CLI Architecture

The CLI lives in `src/cli/` and reuses the same application core as the rest of the system.

Its role is to provide a lightweight terminal interface without forking business logic.

## Eventing And Cross-Cutting Behavior

The app uses an internal event bus for cross-cutting reactions such as persistence hooks, plugin notifications, and feature-level updates.

This allows subsystems to respond to domain changes without forcing tight coupling between every layer.

## Data Flow Examples

### Task creation

```text
User input -> parser -> core task service -> storage backend -> event bus -> UI refresh / plugin reactions
```

### Frontend request path

```text
React component -> src/ui/api/ -> Hono route or direct service -> core service -> storage
```

### AI action path

```text
Chat UI or voice UI -> AI pipeline/provider -> tool registry -> core service -> storage
```

### Plugin load path

```text
Plugin discovery -> manifest validation -> sandbox setup -> permission-gated API injection -> onLoad
```

### MCP path

```text
External agent -> MCP stdio server -> MCP adapter -> core service/tool registry -> storage
```

## Testing Strategy

The test suite mirrors the architecture:

- Unit tests for core logic and helpers
- UI tests for frontend behavior
- integration tests for cross-layer flows
- end-to-end tests for user-facing scenarios

The goal is to verify behavior at the layer where a change actually lives while still covering the high-value end-to-end paths.

## Documentation Map

Use these docs alongside this architecture overview:

- `docs/reference/frontend/COMPONENTS.md`
- `docs/reference/frontend/VIEWS.md`
- `docs/reference/frontend/CONTEXT.md`
- `docs/reference/frontend/API_LAYER.md`
- `docs/reference/backend/CORE.md`
- `docs/reference/backend/DATABASE.md`
- `docs/reference/backend/STORAGE.md`
- `docs/reference/backend/AI.md`
- `docs/reference/backend/VOICE.md`
- `docs/reference/backend/MCP.md`
- `docs/reference/backend/PLUGINS.md`
- `docs/reference/backend/CLI.md`

`docs/README.md` is the canonical documentation index and ownership map.

## Practical Guidance

When changing this codebase:

1. Identify the owning layer first.
2. Confirm which runtime path is active.
3. Keep business rules in core services.
4. Keep transport/UI layers thin.
5. Preserve storage and plugin boundaries.
6. Update the mapped docs in the same change.
