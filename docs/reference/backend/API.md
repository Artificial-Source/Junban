# Backend API Reference

This page covers `src/api/` as the canonical transport layer for Junban's server-facing routes.

Boundary note: keep high-level runtime/startup wiring in [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md). Keep frontend request helpers in [`../frontend/API_LAYER.md`](../frontend/API_LAYER.md).

## What Lives Here

The backend API layer defines route modules, request/response handling, and transport-facing boundaries for:

- tasks, tags, projects, sections, comments, templates, and stats
- AI and voice endpoints
- plugin and settings endpoints

## Canonical Source Files

| File                   | Responsibility                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| `src/api/tasks.ts`     | Task CRUD, bulk operations, hierarchy, and reminder-related routes |
| `src/api/projects.ts`  | Project CRUD and project-level route behavior                      |
| `src/api/tags.ts`      | Tag management endpoints                                           |
| `src/api/sections.ts`  | Section CRUD endpoints                                             |
| `src/api/comments.ts`  | Task-comment endpoints                                             |
| `src/api/templates.ts` | Template CRUD endpoints                                            |
| `src/api/stats.ts`     | Statistics and reporting endpoints                                 |
| `src/api/settings.ts`  | App-setting endpoints                                              |
| `src/api/ai.ts`        | AI transport endpoints and chat/config flows                       |
| `src/api/voice.ts`     | Voice/STT/TTS transport endpoints                                  |
| `src/api/plugins.ts`   | Plugin runtime / plugin-management transport endpoints             |

## Responsibilities

- Validate request shape at the route boundary
- Translate transport requests into core-service operations
- Keep HTTP / route semantics separate from frontend client helpers
- Preserve compatibility expectations for request and response behavior

## Related Docs

- [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
- [`CORE.md`](CORE.md)
- [`AI.md`](AI.md)
- [`VOICE.md`](VOICE.md)
- [`PLUGINS.md`](PLUGINS.md)
- [`../frontend/API_LAYER.md`](../frontend/API_LAYER.md)
