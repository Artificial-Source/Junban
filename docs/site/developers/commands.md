# Developer Commands

Canonical source: [`../../guides/SETUP.md`](../../guides/SETUP.md)

This page groups the most-used project commands. Use it as a practical quick reference.

## Development

```bash
pnpm dev
pnpm dev:full
pnpm server
pnpm build
pnpm start
```

- `dev`: browser UI with inline API plugin in Vite (`apiPlugin`) mode.
- `dev:full`: browser UI + standalone Hono server (`VITE_USE_BACKEND=true`).
- `server`: standalone Hono API server.
- `tauri:dev`: Tauri desktop-shell dev flow with backend-backed API transport (`VITE_USE_BACKEND=true`) via `src/server.ts` + `src/bootstrap.ts`.
- `build` / `start`: production build and preview.

- `bootstrap-web.ts`/direct-services is the packaged Tauri/webview direct-services path and is **not** its own `pnpm` command; use targeted checks when touching direct-service/UI paths.

## Quality and tests

```bash
pnpm lint
pnpm lint:fix
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
```

- `check` is the broad pre-PR quality gate (lint + format + typecheck + tests).

## Database and storage workflow

```bash
pnpm db:generate
pnpm db:migrate
```

- `db:generate`: create migrations after schema changes
- `db:migrate`: apply migrations to the active profile database

## CLI and MCP entrypoints

```bash
pnpm cli
pnpm mcp
```

These run against the same dev profile wiring as the main local workflow.

## Desktop and plugins

```bash
pnpm tauri:dev
pnpm tauri:build
pnpm plugin:create
```

- `tauri:dev`: backend-backed Tauri desktop shell runtime (`VITE_USE_BACKEND=true`) using the same `src/server.ts` + `src/bootstrap.ts` path.

## Documentation validation

```bash
pnpm docs:check
```

Run this when changing docs structures, canonical links, or publication-layer pages.

## Notes on profiles

Repo dev commands run through a profile wrapper that isolates development data (typically under `./data/dev/` and `./tasks/dev/` for markdown mode).

For exact environment controls and setup behavior, use the canonical setup guide: [`../../guides/SETUP.md`](../../guides/SETUP.md).
