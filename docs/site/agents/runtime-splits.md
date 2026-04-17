# Runtime Splits (Node, Browser, Tauri shell backend, Packaged Tauri/webview)

Canonical source: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)

Junban intentionally splits composition and storage behavior by runtime. Agent changes should preserve these boundaries.

## Runtime matrix

| Concern | Node runtime (`bootstrap.ts`) | Direct-services runtime (`bootstrap-web.ts`) |
| --- | --- | --- |
| Storage backend | `sqlite` or `markdown` based on env | SQLite only (`sql.js`) |
| Filesystem access | Yes (Node APIs available) | No Node filesystem APIs |
| Markdown storage | Supported | Not supported |
| Database migration path | `src/db/migrate.ts` | `src/db/migrate-web.ts` |
| Plugin loading | Loader-based plugin discovery from plugin dirs | Built-in plugin registry path in web bootstrap |
| AI runtime loading | Node registry path in bootstrap | Lazy loaded via `src/bootstrap-web-ai-runtime.ts` |

## Frontend data-access split

The UI can run in four relevant execution modes:

- **Browser inline-backend mode** (`pnpm dev`): Vite uses in-process API plugin (no standalone server).
- **Browser standalone-backend mode** (`pnpm dev:full`): HTTP routes are served by standalone `src/server.ts`.
- **Tauri shell backend mode** (`pnpm tauri:dev`): backend-backed desktop shell runtime using `src/server.ts` + `src/bootstrap.ts` APIs (`VITE_USE_BACKEND=true`).
- **Packaged Tauri/webview direct-services mode**: in-process webview services via `src/ui/api/direct-services.ts` and `src/bootstrap-web.ts` (no backend HTTP from UI).

Plain browser dev (`pnpm dev` / `pnpm dev:full`) does not normally instantiate `bootstrap-web.ts`; that path is specific to direct-services checks.

Agent implication: when changing frontend behavior, verify which path is active (or whether both are expected) before changing contracts.

## Storage and runtime guardrails

- Do not introduce Node-only modules into browser-side code.
- Do not assume markdown storage exists in direct-services flows.
- Keep `src/storage/interface.ts` as the backend-agnostic contract boundary.
- If startup/entrypoint behavior changes, route doc updates through `docs/guides/ARCHITECTURE.md` and the ownership map in `docs/README.md`.
