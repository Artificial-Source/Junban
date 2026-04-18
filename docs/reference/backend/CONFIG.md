# Backend Configuration Reference

This document tracks runtime configuration for Junban’s backend and frontend transport layers.

`loadEnv()` in [`src/config/env.ts`](../../../src/config/env.ts) is the validated configuration entrypoint for the Node-side runtime environment. Junban also has separate server-only and Vite/frontend configuration planes.

---

## Configuration Planes

| Plane | Source | Notes |
| --- | --- | --- |
| Validated Node runtime env | `src/config/env.ts` | Parsed by `loadEnv()` from `process.env` |
| Server process-only env | `src/server.ts` | Read directly from `process.env` outside the shared schema |
| Frontend/build transport env | `vite.config.ts`, `src/ui/api/helpers.ts` | Uses Vite-style `VITE_*` variables |
| Persisted in-app settings | storage-backed settings APIs | Not environment variables |

## How config is loaded

### `loadEnv()` behavior

1. `JUNBAN_PROFILE` is validated as `daily | dev` and defaults to `daily`.
2. `DB_PATH` and `MARKDOWN_PATH` are filled from profile defaults before validation:
   - `daily` → `./data/junban.db`, `./tasks/`
   - `dev` → `./data/dev/junban.db`, `./tasks/dev/`
3. The resulting object is validated against the schema in `src/config/env.ts`.

### Consumers of `loadEnv()`

`loadEnv()` is currently used by:

- `src/server.ts` (server bootstrap; sets log level)
- `src/main.ts` (web/Tauri bootstrap entrypoint)
- `src/bootstrap.ts` (storage and plugin initialization)
- `src/api/settings.ts` (`/api/settings/storage` returns mode/path)
- `src/db/migrate.ts` (standalone migration entrypoint)

---

## Schema-Validated Variables Consumed by the Current Runtime

All schema-based variables are defined in [`src/config/env.ts`](../../../src/config/env.ts).

| Variable | Type / transform | Default | Notes |
|----------|------------------|---------|-------|
| `JUNBAN_PROFILE` | `"daily" \| "dev"` | `daily` | Chooses profile defaults for `DB_PATH` and `MARKDOWN_PATH` |
| `DB_PATH` | non-empty string (no null bytes) | profile default | Path to SQLite DB file. In schema validation, this may be provided directly or filled from profile defaults. |
| `STORAGE_MODE` | `"sqlite" \| "markdown"` | `sqlite` | Storage backend selection |
| `MARKDOWN_PATH` | non-empty string (no null bytes) | profile default | Base path for markdown task files when `STORAGE_MODE=markdown` |
| `LOG_LEVEL` | `"debug" \| "info" \| "warn" \| "error"` | `info` | Controls logger threshold via `setDefaultLogLevel` |
| `PLUGIN_DIR` | non-empty string (no null bytes) | `./plugins/` | Plugin discovery directory |

## Schema-Validated Variables Not Clearly Consumed in Main Runtime Paths

These variables are present in `src/config/env.ts`, but the current repository does not show strong runtime consumers for them in the main app paths documented here.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `5173` | Present in the schema, but not used by `vite.config.ts` or `src/server.ts` as a runtime bind setting |
| `DEFAULT_THEME` | `light` | Validated in the schema; no strong runtime consumer was traced in this pass |
| `NLP_LOCALE` | `en` | Validated in the schema; no strong runtime consumer was traced in this pass |
| `PLUGIN_SANDBOX` | `true` | Parsed in the schema; this page does not treat it as a stable user-facing switch without clearer runtime wiring |
| `PLUGIN_REGISTRY_URL` | unset | Present in the schema; current public registry workflow remains lightly surfaced |
| `PLUGIN_MAX_SIZE_MB` | `10` | Present in the schema; not promoted here as a common runtime workflow |
| `CLI_OUTPUT_FORMAT` | `text` | Present in the schema; explicit `--json` flags are the clearer documented CLI path |

---

## Server-only environment variables (`process.env`)

These are read outside `loadEnv()` and are not part of the validated schema.

| Variable | Where read | Purpose |
|----------|------------|---------|
| `API_PORT` | `src/server.ts` | API bind port, defaults to `4822`, also added to CORS allowed origins |
| `NODE_ENV` | `src/server.ts` | Enables `/api/test-reset` route when `"test"` |
| `E2E_MODE` | `src/server.ts` | Enables `/api/test-reset` route when `"true"` |

`API_PORT` is safest to treat as a standalone `pnpm server` override. The current `pnpm dev:full` proxy and the default Tauri API target still point at `4822` unless you also change the frontend-side target.

---

## Vite/frontend variables (`VITE_*`)

These are consumed by Vite and frontend code, not by the shared config schema.

Frontend variable declarations live in [`src/vite-env.d.ts`](../../../src/vite-env.d.ts).

| Variable | Where read | Purpose |
|----------|------------|---------|
| `VITE_USE_BACKEND` | `vite.config.ts` / `src/ui/api/helpers.ts` | When `"true"`, Vite runs without inline API plugin and proxies `/api` to the backend server; frontend calls backend APIs instead of direct services |
| `VITE_API_URL` | `src/ui/api/helpers.ts` | Optional override for API base URL |

### Note on defaults

If neither `VITE_USE_BACKEND` nor `VITE_API_URL` is set, browser builds use Vite’s default `/api` path (inline API plugin in local dev or `/api` proxy in backend mode).

For command wiring details, see `package.json` scripts (`dev`, `dev:full`, `server`) and [`scripts/run-with-profile.mjs`](../../../scripts/run-with-profile.mjs).
