# Storage model and persistence boundaries

Junban’s storage layer is a narrow, explicit boundary: domain services operate on a storage contract, while concrete persistence implementations are selected at composition time.

The result is that UI, API, CLI, AI tooling, and MCP all read/write against the same contract instead of backend-specific behaviors.

## Boundary model

The contract is `IStorage` in `src/storage/interface.ts`.

- Domain services and plugin/API adapters depend on this interface.
- `IStorage` groups operations by domain concern (tasks, tags, projects, sections, comments, activity, relations, stats, templates, chat, app settings, plugin settings, and AI memory).
- Because service code consumes `IStorage`, transport/runtime changes do not require duplicating core domain behavior.

This boundary is intentionally strict: new runtime features should be composed through the contract instead of bypassing it.

## Why two backends exist

The repository supports two backends because it is serving two different goals at once:

- SQLite is the default operational path.
- Markdown exists for users who want file-oriented, git-friendly storage.

The `IStorage` surface stays the same so services do not have to know which one is active.

### Practical differences

| Dimension | SQLite | Markdown |
|---|---|---|
| Read/write behavior | Database-native query performance | File-based persistence with index hydration |
| Primary user objective | Fast operational queries and structured filters | Human-readable artifacts and Git-friendly edits |
| Runtime requirement | SQL-backed runtime (Node path or sql.js in web mode) | Node filesystem access |
| Typical risk | Fewer accidental merge conflicts in concurrent mutation paths | Higher coupling to disk schema/path conventions |

### Web vs Node selection

- `src/bootstrap.ts` selects backend from `STORAGE_MODE` (`"sqlite"` default, `"markdown"` optional).
- `src/bootstrap-web.ts` always uses SQLite, because browser/Tauri execution path uses sql.js and has no direct markdown filesystem I/O in the same way.

This keeps the backend choice outside the core domain layer.

## Storage as a cross-cutting invariant

Many parts of Junban depend on storage, including core services, plugin metadata, chat history, and app settings. Because they still pass through one storage contract, the app can preserve consistent behavior across UI, API, CLI, and MCP entrypoints.

## Security boundary: sensitive app settings

`src/storage/encrypted-settings.ts` is a small, focused wrapper around `storage.getAppSetting`/`storage.setAppSetting`.

It handles sensitive keys (for example `ai_api_key`, `ai_oauth_token`, `ai_base_url_override`) with encryption/decryption at the storage boundary.

This keeps secret handling close to the persistence boundary rather than spreading it through feature code.

## Why storage methods are synchronous

The storage contract is synchronous. That keeps the service-facing API simple and consistent across backends.

In the current repository, that is a practical fit for the implementation choices as well: Node SQLite uses `better-sqlite3`, and the Markdown backend maintains in-memory indexes for reads.

## Tradeoffs and constraints

1. **Backend flexibility vs parity burden**

   Supporting two implementations increases flexibility but requires strict method parity and consistent row shapes.

2. **Operational portability vs performance predictability**

   Markdown mode is readable and portable, while SQLite mode is typically better for heavier query patterns.

3. **Runtime availability vs feature parity**

   Web/Tauri intentionally pins SQLite usage to avoid filesystem-dependent assumptions outside Node.

4. **Security-by-default data handling**

   Sensitive settings are protected only at the boundary that owns persistence details; higher layers should treat those settings as opaque values.

## What must stay true

- Domain code should depend on the storage contract, not a backend-specific implementation.
- Browser-side runtime must keep using the SQLite/sql.js path.
- Sensitive settings should remain handled at the persistence boundary rather than in unrelated feature code.

## See also

- [`architecture.md`](./architecture.md)
- [`../reference/backend/STORAGE.md`](../reference/backend/STORAGE.md)
- [`../reference/backend/DATABASE.md`](../reference/backend/DATABASE.md)
- [`../reference/backend/CORE.md`](../reference/backend/CORE.md)
