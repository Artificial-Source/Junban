# How to run Junban locally

Use this page when you already have Junban installed and want to run in a specific mode.

## Pick your mode first

| Command | What starts | When to use |
| --- | --- | --- |
| `pnpm dev` | Vite UI with the default local data-access path | Fastest for normal web development |
| `pnpm dev:full` | `node src/server.ts` + Vite UI proxying `/api` to API | Full-stack web run with real Hono API server |
| `pnpm server` | Hono API server only on `API_PORT` (default `4822`) | API/manual HTTP testing |
| `pnpm cli` | Terminal task CLI against the same storage | Automation and quick task CRUD |
| `pnpm mcp` | MCP stdio server (`tool`/`resource`/`prompt` surface) | External AI-agent integrations |
| `pnpm tauri:dev` | Desktop app shell (Tauri) + embedded flow | Testing packaged desktop behavior |

## Standard web local flow

1. Ensure data directory exists:

   ```bash
   mkdir -p data/dev
   ```

2. Migrate schema (first run or after updates):

   ```bash
   pnpm db:migrate
   ```

3. Start the app:

   ```bash
   pnpm dev
   ```

4. Open `http://localhost:5173`.

This run uses the `dev` profile automatically through `scripts/run-with-profile.mjs`.

## Full-stack local API + UI flow

Use this when you want the UI to call the standalone Hono server:

```bash
pnpm dev:full
```

This sets `VITE_USE_BACKEND=true` for Vite and starts:

- `src/server.ts` for APIs
- `vite` for UI

The UI talks to the API on port `4822` by default.

## Desktop/local embedded flow

If you installed the desktop toolchain:

```bash
pnpm tauri:dev
```

Run-time data in desktop debug mode remains separate from packaged installers.

## Run just the API stack (optional)

```bash
pnpm server
```

Use this when validating REST endpoints independently or before attaching another frontend.

## Command surface for verification

- Health check (server mode): `GET /api/health`
- Task/Project/Tag APIs: [`/api/tasks`, `/api/projects`, `/api/tags`] via the service routes in
  `src/server.ts`
- CLI quick validation:

  ```bash
  pnpm cli list
  pnpm cli add "review PR by Friday p2 #work"
  ```

## Useful local debugging commands

- Recreate dev DB if startup migration state is stuck:

  ```bash
  rm -f data/dev/junban.db
  mkdir -p data/dev
  pnpm db:migrate
  ```

- Run checks before sharing a run:

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  ```

## See also

- [How to configure Junban](configure.md)
- [How-to Install](install.md)
- [Local Development Setup](../guides/SETUP.md)
- `package.json` scripts section for the full script list
