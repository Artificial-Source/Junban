# ASF Junban - Development Guide

## What This Repo Is

ASF Junban is a local-first task manager with a React/Tauri UI, a shared TypeScript core, optional AI features, voice support, an MCP server, a CLI, and an Obsidian-style plugin system.

The product goal is consistent across the codebase:

- Local-first and private by default
- Useful without accounts or cloud services
- AI-enhanced, but not AI-dependent
- Extensible through a plugin API that stays approachable for both humans and codegen tools
- Portable data, with SQLite as the main path and Markdown as an alternate backend

## Read This With

- `AGENTS.md` for fast navigation
- `docs/README.md` for the canonical docs map
- `docs/guides/ARCHITECTURE.md` for the full architecture pass

## Current Tech Stack

| Area            | Choice                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Runtime         | Node.js 22+, TypeScript, ES modules                                                                 |
| Frontend        | React 19, Tailwind CSS 4, Vite 6                                                                    |
| Desktop         | Tauri v2                                                                                            |
| API server      | Hono                                                                                                |
| Database        | SQLite via better-sqlite3 on Node, sql.js in web/Tauri browser context                              |
| ORM             | Drizzle ORM                                                                                         |
| Validation      | Zod                                                                                                 |
| AI              | Provider abstraction for OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and compatible providers |
| Voice           | Browser + remote + local STT/TTS adapters                                                           |
| CLI             | Commander.js                                                                                        |
| MCP             | `@modelcontextprotocol/sdk`                                                                         |
| Tests           | Vitest, Testing Library, Playwright                                                                 |
| Package manager | pnpm                                                                                                |

## Project Shape

```text
src/
  main.ts                     Node bootstrap entry
  server.ts                   Hono API server entry
  bootstrap.ts                Node service graph
  bootstrap-web.ts            Browser/Tauri service graph
  bootstrap-web-ai-runtime.ts Lazy AI runtime for browser/Tauri
  ui/                         React app, contexts, hooks, views, components
  api/                        Hono route modules
  core/                       Business logic services
  db/                         Schema, clients, migrations, persistence helpers
  storage/                    SQLite and Markdown backends
  parser/                     Natural-language parsing
  ai/                         Chat, providers, tools, voice
  plugins/                    Plugin runtime and sandbox
  mcp/                        MCP server adapters
  cli/                        CLI commands
  config/                     Env/defaults/themes
  utils/                      Shared helpers
  types/                      Ambient/browser type shims

tests/                        Unit, UI, integration, e2e coverage
docs/                         Canonical project documentation
plugins/                      Example and user plugins
src-tauri/                    Tauri shell and Rust config
scripts/                      Dev/release/docs helper scripts
```

## Architecture Overview

### Core application path

```text
UI or API input -> core services -> storage interface -> SQLite or Markdown
```

Core services in `src/core/` are the center of business logic. UI, API, CLI, MCP, and plugin features should reuse those services rather than duplicate rules.

### Storage model

There are two persistence modes:

- SQLite: the default and most capable path
- Markdown: file-backed storage for users who want portable plain-text data

Both sit behind `src/storage/interface.ts`.

Important constraint:

- `src/bootstrap.ts` can use SQLite or Markdown depending on env
- `src/bootstrap-web.ts` always uses SQLite/sql.js because browser environments do not have the Node file APIs required for Markdown storage

### Frontend model

The frontend lives in `src/ui/` and is split into:

- `components/` for reusable UI pieces
- `views/` for screen-level composition
- `context/` for shared state and feature facades
- `hooks/` for reusable behavior
- `api/` for frontend access to backend or direct-service calls
- `themes/` for design tokens and theme loading

The frontend can run in multiple modes, so always confirm whether a feature is using:

- Direct service access in browser/Tauri mode
- The Hono backend via `src/server.ts`
- A code path that must support both

### AI model

The AI system in `src/ai/` is layered:

- Chat/session management
- Provider registry and adapters
- Tool registry and built-in tools
- Voice providers for STT/TTS

Design intent:

- AI is optional
- Provider integrations are swappable
- Tools operate on shared core services and app data
- Failures should degrade gracefully rather than break task management

### Plugin model

Plugins are a core product surface, not an afterthought.

- Runtime code is in `src/plugins/`
- Installed/example plugins live in `plugins/`
- Plugins load through manifest validation, sandboxing, and a permission-gated API
- Plugins can extend commands, UI, settings, and AI capabilities

When changing plugin infrastructure, preserve sandbox boundaries and explicit permission checks.

### MCP model

`src/mcp/server.ts` exposes Junban capabilities to external agents over stdio.

Important constraint:

- MCP transports JSON-RPC over stdio, so avoid writing incidental output to stdout in MCP server paths.

## Key Files

| File                                               | Why it matters                                     |
| -------------------------------------------------- | -------------------------------------------------- |
| `src/bootstrap.ts`                                 | Builds the Node service graph                      |
| `src/bootstrap-web.ts`                             | Builds the browser/Tauri service graph             |
| `src/server.ts`                                    | Hono API composition and process lifecycle         |
| `src/db/schema.ts`                                 | Database schema source of truth                    |
| `src/storage/interface.ts`                         | Shared storage contract                            |
| `src/core/tasks.ts`                                | Central task logic                                 |
| `src/core/types.ts`                                | Core schemas and shared domain types               |
| `src/parser/task-parser.ts`                        | Natural-language task parsing                      |
| `src/ai/tool-registry.ts`                          | Built-in AI tool registration                      |
| `src/ai/provider.ts` and `src/ai/provider-node.ts` | Browser/node provider setup                        |
| `src/plugins/api.ts`                               | Plugin-facing API surface                          |
| `src/plugins/loader.ts`                            | Plugin discovery/loading                           |
| `src/plugins/sandbox.ts`                           | Plugin isolation                                   |
| `src/ui/App.tsx`                                   | App shell and view composition                     |
| `src/ui/api/direct-services.ts`                    | Frontend direct-service bridge for non-server mode |
| `src/mcp/server.ts`                                | MCP entry point                                    |
| `src/cli/index.ts`                                 | CLI entry point                                    |

## Development Commands

```bash
pnpm dev
pnpm dev:full
pnpm server
pnpm build
pnpm start
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm test:e2e
pnpm db:generate
pnpm db:migrate
pnpm cli
pnpm mcp
pnpm docs:check
pnpm tauri:dev
pnpm tauri:build
pnpm plugin:create
pnpm check
```

## Environment And Profiles

Common environment knobs:

- `STORAGE_MODE=sqlite|markdown`
- `DB_PATH`
- `MARKDOWN_PATH`
- `PLUGIN_DIR`
- `API_PORT`
- `LOG_LEVEL`
- `VITE_USE_BACKEND=true` when the frontend should call the standalone Hono server in development

Source-run dev commands use `scripts/run-with-profile.mjs` to isolate dev data via a profile-specific path. Do not assume source runs and packaged desktop installs use the same storage location.

## Code Conventions

- TypeScript strict mode is enabled.
- `noUnusedLocals` and `noUnusedParameters` are enabled.
- `@/` resolves to `src/`.
- Named exports are preferred.
- React function components only.
- Tailwind is the standard styling path.
- Zod schemas are used heavily for domain validation and type derivation.
- Avoid `any`; ESLint warns on explicit `any` in app code.
- Keep shared behavior in core/services instead of duplicating it across UI, API, CLI, MCP, or plugins.

## Testing Layout

Tests live under `tests/` and cover:

- `tests/core/`, `tests/parser/`, `tests/storage/`, `tests/ai/`, `tests/mcp/`, `tests/cli/`, `tests/plugins/`, `tests/utils/`
- `tests/ui/` for jsdom-based UI coverage
- `tests/integration/` for cross-layer behavior
- `tests/e2e/` for Playwright end-to-end flows

Vitest is configured as multiple projects:

- `unit`
- `ui`
- `plugin-ui`

Run `pnpm check` before considering a change complete unless the task explicitly says otherwise.

## Common Change Paths

### Add or change a task field

1. Update the domain schema/types in `src/core/types.ts`.
2. Update `src/db/schema.ts`.
3. Generate a migration with `pnpm db:generate`.
4. Update storage/core logic as needed.
5. Update parser support if the field is user-enterable.
6. Update UI rendering and editing paths.
7. Update tests.
8. Update docs mapped in `docs/README.md`.

### Add UI functionality

1. Identify the owning view and shared components.
2. Confirm whether state belongs in local component state, a hook, or a context.
3. Check whether data comes through `src/ui/api/` or direct services.
4. Update keyboard/mobile behavior if relevant.
5. Update frontend docs when behavior or structure changes.

### Change storage or schema behavior

1. Confirm whether the change affects SQLite, Markdown, or both.
2. Preserve the `IStorage` contract unless there is a deliberate interface change.
3. Regenerate migrations for schema changes.
4. Review tests across storage and integration layers.
5. Update database/storage docs.

### Change AI or voice behavior

1. Identify whether the change is provider-specific, pipeline-level, tool-level, or UI-level.
2. Preserve optionality; the app must remain useful without AI configuration.
3. Avoid coupling provider specifics into unrelated layers.
4. Update backend/frontend docs when user-visible behavior changes.

### Change plugin infrastructure

1. Preserve sandbox boundaries and permission checks.
2. Consider plugin author ergonomics, not just internal correctness.
3. Update both internal plugin docs and plugin-author docs when the surface changes.

## Documentation Policy

Documentation changes are required when behavior, APIs, workflows, or file organization change.

Start with `docs/README.md`, which contains the ownership map. In practice:

- Frontend source changes usually require updates in `docs/frontend/`
- Backend/platform changes usually require updates in `docs/backend/`
- Plugin API changes require updates in `docs/plugins/`
- Cross-cutting workflow or architecture changes should update `AGENTS.md`, `CLAUDE.md`, and possibly `docs/guides/ARCHITECTURE.md`

Avoid brittle documentation that depends on exact file counts or tool counts unless that number is intentionally maintained.

## Pitfalls

- Do not assume browser code can import Node-only modules.
- Do not assume Markdown storage works in web bootstrap paths.
- Do not assume repo-run dev commands share data with packaged installs; dev defaults to `./data/dev/junban.db` and `./tasks/dev/`, while packaged Tauri builds use AppData.
- Do not bypass core services with duplicated business rules.
- Do not weaken plugin isolation for convenience.
- Do not print stray stdout in MCP paths.
- Do not forget docs when changing public behavior.

## Practical Workflow For Agents

1. Read `AGENTS.md` and `docs/README.md`.
2. Explore the relevant slice of the repo before editing.
3. Trace the full path of the feature: UI, API/direct service, core, storage, docs, tests.
4. Make the smallest correct change.
5. Run the narrowest useful verification first, then broader checks if needed.
6. Update docs in the same change when behavior or structure moved.
