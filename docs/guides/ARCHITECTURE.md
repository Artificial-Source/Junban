# Architecture

## Overview

Junban is a local-first TypeScript application built around a shared domain core. The same business logic powers the React UI, the Hono API server, the CLI, the MCP server, and most plugin integrations.

The architecture is organized around a few stable ideas:

- Core rules live in services, not in UI or transport layers.
- Persistence is abstracted behind a storage interface.
- Browser/Tauri and Node runtimes have different bootstrap paths.
- AI, voice, plugins, and MCP are first-class subsystems, but they all integrate through the same app data model.

## Top-Level Shape

```text
src/
  main.ts                     Node bootstrap entry
  server.ts                   Hono API entry
  bootstrap.ts                Node service graph
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

Node mode builds services through `src/bootstrap.ts`.

This path can use either:

- SQLite storage
- Markdown storage

depending on environment configuration.

### Browser and Tauri WebView mode

Used by the React app when running in the browser or inside the Tauri webview.

This path builds services through `src/bootstrap-web.ts`.

Important constraint:

- Browser-side code always uses SQLite via `sql.js`
- Markdown storage is Node-only because it requires filesystem access

The browser/Tauri path also lazy-loads AI runtime code through `src/bootstrap-web-ai-runtime.ts` so the base UI does not pay that startup cost until needed.

## Service Graph

`src/bootstrap.ts` and `src/bootstrap-web.ts` are the main composition roots.

They assemble:

- Storage
- Core services
- Event bus
- Plugin infrastructure
- Command and UI registries
- AI provider and tool registries
- Chat manager where relevant

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
- `migrate.ts` and `migrate-web.ts` for migrations
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

- `docs/frontend/COMPONENTS.md`
- `docs/frontend/VIEWS.md`
- `docs/frontend/CONTEXT.md`
- `docs/frontend/API_LAYER.md`
- `docs/backend/CORE.md`
- `docs/backend/DATABASE.md`
- `docs/backend/STORAGE.md`
- `docs/backend/AI.md`
- `docs/backend/VOICE.md`
- `docs/backend/MCP.md`
- `docs/backend/PLUGINS.md`
- `docs/backend/CLI.md`

`docs/README.md` is the canonical documentation index and ownership map.

## Practical Guidance

When changing this codebase:

1. Identify the owning layer first.
2. Confirm which runtime path is active.
3. Keep business rules in core services.
4. Keep transport/UI layers thin.
5. Preserve storage and plugin boundaries.
6. Update the mapped docs in the same change.
