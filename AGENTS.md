# AGENTS.md

This file is the quick-start for AI coding agents working in ASF Junban. Read this first, then use `CLAUDE.md` for the broader development guide and `docs/README.md` for the canonical docs index.

## First Moves

When you spawn into this repository:

1. Read `AGENTS.md`.
2. Read `CLAUDE.md`.
3. Read `docs/README.md`.
4. If the task is not already tightly scoped, use an explore agent or targeted `Glob`/`Grep` to map the relevant files before editing.

## Repo Snapshot

Junban is a local-first task manager with:

- A React 19 + Tailwind 4 frontend in `src/ui/`
- A Hono API server in `src/server.ts` and `src/api/`
- Core business logic in `src/core/`
- SQLite and Markdown storage backends behind `src/storage/interface.ts`
- AI chat, tool calling, and provider abstractions in `src/ai/`
- Voice/STT/TTS support in `src/ai/voice/`
- An MCP server in `src/mcp/server.ts`
- A plugin system in `src/plugins/` plus user plugins in `plugins/`
- A Tauri desktop shell in `src-tauri/`
- A Commander-based CLI in `src/cli/`

## Where To Look

| You need to...                                    | Start here                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand the whole project                      | `CLAUDE.md`, then `docs/guides/ARCHITECTURE.md`                                                                                                                            |
| Find canonical documentation                      | `docs/README.md`                                                                                                                                                           |
| Navigate technical reference docs                 | `docs/reference/README.md`                                                                                                                                                 |
| Check product docs                                | `docs/product/README.md`                                                                                                                                                   |
| Fix UI behavior                                   | `src/ui/`, `docs/reference/frontend/COMPONENTS.md`, `docs/reference/frontend/VIEWS.md`                                                                                     |
| Fix shared app state or context                   | `src/ui/context/`, `docs/reference/frontend/CONTEXT.md`                                                                                                                    |
| Fix frontend data access                          | `src/ui/api/`, `docs/reference/frontend/API_LAYER.md`                                                                                                                      |
| Fix backend/core behavior                         | `src/core/`, `docs/reference/backend/CORE.md`                                                                                                                              |
| Change database or persistence                    | `src/db/`, `src/storage/`, `docs/reference/backend/DATABASE.md`, `docs/reference/backend/STORAGE.md`                                                                       |
| Work on natural-language input                    | `src/parser/`, `docs/reference/backend/PARSER.md`                                                                                                                          |
| Work on AI chat/tools/providers                   | `src/ai/`, `docs/reference/backend/AI.md`                                                                                                                                  |
| Work on voice features                            | `src/ai/voice/`, `docs/reference/backend/VOICE.md`                                                                                                                         |
| Work on plugins                                   | `src/plugins/`, `plugins/`, `docs/reference/backend/PLUGINS.md`, `docs/reference/plugins/README.md`, `docs/reference/plugins/API.md`, `docs/reference/plugins/EXAMPLES.md` |
| Work on MCP                                       | `src/mcp/`, `docs/reference/backend/MCP.md`                                                                                                                                |
| Work on CLI                                       | `src/cli/`, `docs/reference/backend/CLI.md`                                                                                                                                |
| Understand release/setup/security                 | `docs/guides/RELEASES.md`, `docs/guides/SETUP.md`, `docs/guides/SECURITY.md`                                                                                               |
| Check product roadmap/status or internal planning | `docs/product/README.md`, `docs/internal/README.md`                                                                                                                        |

## Top-Level Layout

```text
src/                 Application source
src/ui/              React frontend
src/api/             Hono route modules
src/core/            Business logic and services
src/db/              Drizzle schema, clients, migrations, persistence
src/storage/         SQLite and Markdown backends
src/ai/              AI chat, providers, tools, voice
src/plugins/         Plugin runtime, loader, sandbox, registries
src/mcp/             MCP server bridge
src/cli/             CLI entry and commands
src-tauri/           Desktop shell
tests/               Unit, integration, UI, e2e coverage
docs/                Canonical documentation
plugins/             User/example plugins
scripts/             Release, profile, docs, plugin scaffolding helpers
```

## Entry Points

- `src/main.ts`: Node entry that bootstraps services and loads plugins
- `src/server.ts`: standalone Hono API server
- `src/bootstrap.ts`: Node service wiring
- `src/bootstrap-web.ts`: web/Tauri browser-side service wiring with sql.js persistence
- `src/bootstrap-web-ai-runtime.ts`: lazy browser AI runtime wiring
- `src/ui/main.tsx`: React entry
- `src/cli/index.ts`: CLI entry
- `src/mcp/server.ts`: MCP stdio server entry

## Data Flow Cheatsheet

### App flow

```text
React UI -> src/ui/api/ -> Hono routes or direct services -> src/core/ -> src/storage/ -> SQLite or Markdown
```

### Web/Tauri flow

```text
src/bootstrap-web.ts -> sql.js database -> debounced persistence -> local app storage
```

### AI flow

```text
UI chat/voice -> AI contexts -> ChatManager / pipeline -> provider registry -> tool registry -> core services
```

### Plugin flow

```text
plugins/ -> loader -> manifest validation -> sandbox -> permission-gated API -> commands / UI / AI extensions
```

### MCP flow

```text
External agent -> stdio MCP server -> tool/resource/prompt adapters -> core services
```

## Commands

```bash
pnpm dev
pnpm dev:full
pnpm server
pnpm build
pnpm start
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
pnpm db:generate
pnpm db:migrate
pnpm cli
pnpm mcp
pnpm tauri:dev
pnpm tauri:build
pnpm docs:check
pnpm plugin:create
```

## Conventions That Matter

- TypeScript strict mode is on.
- Named exports are preferred.
- React function components only.
- Tailwind is the default styling path.
- Zod is used for runtime validation.
- Source imports commonly use the `@/` alias.
- Tests live in `tests/` and are split across unit, UI, plugin-UI, integration, and e2e coverage.
- `plugins/` is excluded from the main TypeScript project; do not assume plugin code is compiled with the main app.

## Documentation Rule

If code changes affect behavior, APIs, workflows, or file organization, update docs in the same PR.

Route through `docs/README.md` first, then use domain indexes (`docs/reference/README.md`,
`docs/product/README.md`, and `docs/internal/README.md`) before editing lower-level docs.

`docs/README.md` is the canonical ownership map and documentation-governance source.

Quick route reminders:

- Frontend source changes typically route through `docs/reference/frontend/`
- Backend/platform changes typically route through `docs/reference/backend/`
- Plugin-author surface changes route through `docs/reference/plugins/`
- Product mission, roadmap, status, or PRD-scope changes route through `docs/product/`
- Cross-cutting workflow or architecture changes may also require updates in `docs/guides/ARCHITECTURE.md` and `CLAUDE.md`

Always verify against `docs/README.md` before deciding no doc update is needed.

## Practical Agent Notes

- Prefer exploring relevant code before proposing architectural changes.
- Check whether the current task runs through the direct-service path, the Hono API path, or both.
- Browser/web code cannot use Node-only modules.
- Markdown storage is Node-only; web bootstrap always uses SQLite/sql.js.
- Repo-run development commands use the `dev` profile by default. Assume the active dev SQLite DB is `./data/dev/junban.db` and the dev Markdown path is `./tasks/dev/` unless the task explicitly overrides `DB_PATH` or `MARKDOWN_PATH`.
- Packaged desktop installs use Tauri AppData, not the repo-local dev database.
- MCP uses stdio, so avoid noisy stdout behavior in MCP-specific code.
- Plugin changes should preserve sandbox and permission boundaries.
- Do not hardcode fragile file counts or feature counts into docs unless they are intentionally tracked.
