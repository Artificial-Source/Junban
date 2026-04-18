# How to configure Junban

Use this page for stable, task-oriented configuration changes.

## 1) Choose how you want to set variables

Junban ships `.env.example` as a configuration template, but the current Node entrypoints still read `process.env` directly through `loadEnv()` in `src/config/env.ts`.

For browser-side work, you may still keep a local `.env` file:

```bash
cp .env.example .env
```

For Node-based commands, pass overrides inline or export them in your shell. Example:

```bash
STORAGE_MODE=markdown JUNBAN_PROFILE=dev pnpm server
```

### Storage mode and paths

| Variable | Purpose | Default behavior |
| --- | --- | --- |
| `JUNBAN_PROFILE` | Chooses `daily` or `dev` profile defaults | `daily` |
| `DB_PATH` | SQLite DB file path for server mode | `./data/junban.db` (`daily`) / `./data/dev/junban.db` (`dev`) |
| `STORAGE_MODE` | Backend engine: `sqlite` or `markdown` | `sqlite` |
| `MARKDOWN_PATH` | Base path for markdown files when `STORAGE_MODE=markdown` | `./tasks/` (`daily`) / `./tasks/dev/` (`dev`) |
| `PLUGIN_DIR` | Plugin discovery directory | `./plugins/` |

Validation and defaults come from `src/config/env.ts`, and backend selection is implemented in `src/bootstrap.ts`.

### App and diagnostics

| Variable | Purpose |
| --- | --- |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `DEFAULT_THEME` | Validated in the schema, but no confirmed runtime consumer was traced in the current app paths |
| `NLP_LOCALE` | Validated in the schema, but no confirmed runtime consumer was traced in the current app paths |

For the standalone API server specifically, `src/server.ts` also reads `process.env.API_PORT` directly and falls back to `4822`. Treat that as a standalone-server override: the current `pnpm dev:full` proxy setup and the default Tauri-side API target still assume port `4822` unless you also change the frontend target.

### CLI and optional sync

| Variable | Purpose |
| --- | --- |
| `CLI_OUTPUT_FORMAT` | `text` or `json` |
| `PLUGIN_REGISTRY_URL` | Optional external plugin registry URL |
| `PLUGIN_MAX_SIZE_MB` | Maximum plugin download/zip size |

`CLI_OUTPUT_FORMAT` is part of the current environment schema. `PLUGIN_REGISTRY_URL` and `PLUGIN_MAX_SIZE_MB` are present in the schema, but this guide avoids treating them as a fully documented end-user workflow because the repository does not expose a stable public plugin-registry flow yet. The sync block in `.env.example` is explicitly marked future-facing and should not be treated as a stable feature.

## 2) Runtime mode and transport

Junban supports both direct service usage (local/Tauri-style mode) and HTTP API mode.
To force the frontend onto the standalone API path, set the variable when starting Vite, or use the built-in command that already does it:

```bash
VITE_USE_BACKEND=true pnpm dev
# or simply
pnpm dev:full
```

If you need the UI to talk to another server URL, `src/ui/api/helpers.ts` also checks `VITE_API_URL`.

These flags are used in [`src/ui/api/helpers.ts`](../reference/frontend/API_LAYER.md).

## 3) App-level settings (in-app)

Use the Settings screens in the UI for runtime behavior that is not purely environment-driven:

- AI provider + auth details in **Settings → AI**
- Voice provider keys under voice settings
- Feature flags and appearance in **Settings**

Use **Settings → Plugins** when you need to enable community plugins or approve a plugin's requested permissions.

For API/CLI surface details, see:

- [`docs/reference/frontend/API_LAYER.md`](../reference/frontend/API_LAYER.md)
- [`docs/reference/backend/AI.md`](../reference/backend/AI.md)
- [`docs/reference/backend/STORAGE.md`](../reference/backend/STORAGE.md)

## 4) Validation and restart

- After changing SQLite-backed storage settings such as `DB_PATH` or a profile that changes the SQLite path, rerun:

  ```bash
  pnpm db:migrate
  ```

- Restart the chosen run mode so the relevant process picks up updates:

  ```bash
  pnpm dev
  # or
  pnpm dev:full
  ```

## Quick checks

- Confirm storage mode and path from the app settings screen or by running:

  ```bash
  pnpm cli list --today
  ```

- For CLI output style, add `--json` to verify structured responses while testing changes.
