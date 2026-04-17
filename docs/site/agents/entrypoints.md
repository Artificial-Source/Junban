# Agent Entrypoints

Canonical source: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)

Use this page to identify where a change should start, based on how Junban is being executed.

## Composition roots by execution surface

| Surface | Entrypoint(s) | Composition root | Why it matters for agent work |
| --- | --- | --- | --- |
| Browser inline dev (`pnpm dev`) | `src/ui/main.tsx`, `vite.config.ts`, `vite-api-plugin.ts` | `src/bootstrap.ts` via Vite `apiPlugin` | Vite serves frontend and API routes through in-process middleware. |
| Browser standalone-backend dev (`pnpm dev:full`) | `src/ui/main.tsx`, `src/server.ts` | `src/server.ts` + `src/bootstrap.ts` | Hono is the HTTP transport; route modules live in `src/api/`. |
| Node app runtime | `src/main.ts` | `src/bootstrap.ts` | Initializes full Node service graph and plugin loader. |
| Standalone API server | `src/server.ts` | `src/bootstrap.ts` | Thin transport layer for non-browser consumers; `src/api/` contains route-module implementation, not an entrypoint. |
| CLI runtime | `src/cli/index.ts` | `src/bootstrap.ts` | Reuses core/storage path; CLI changes should not fork business rules. |
| MCP runtime | `src/mcp/server.ts` | `src/bootstrap.ts` | Stdio transport for external agents; avoid incidental stdout noise in this path. |
| Direct-services webview UI | `src/ui/main.tsx` | `src/bootstrap-web.ts` | **Packaged Tauri/webview** runtime using direct services + `sql.js` persistence and no backend HTTP from UI. |
| Tauri shell (backend-backed) | `pnpm tauri:dev` | `src/server.ts` + `src/bootstrap.ts` | Desktop shell development flow that uses backend HTTP APIs, explicitly distinct from packaged `bootstrap-web.ts` direct-services mode. |
| Browser AI lazy runtime | `src/bootstrap-web-ai-runtime.ts` | Called from `bootstrap-web.ts` | Defers AI provider/tool startup cost until needed in direct-services mode. |

## Fast path for common tasks

- **UI behavior change**: start in `src/ui/` and verify whether data flows through direct services or backend API.
- **Backend behavior change**: start in `src/core/`; wire transport concerns in `src/api/` only if needed.
- **Storage behavior change**: start at `src/storage/interface.ts`, then adjust backend implementation(s).
- **AI tool/provider change**: start in `src/ai/`; verify both Node and browser runtime registration paths.

## Routing to canonical docs

- Architecture map: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
- Ownership and doc update policy: [`../../README.md`](../../README.md)
- Backend reference index: [`../../reference/backend/API.md`](../../reference/backend/API.md)
- Frontend data-access reference: [`../../reference/frontend/API_LAYER.md`](../../reference/frontend/API_LAYER.md)
