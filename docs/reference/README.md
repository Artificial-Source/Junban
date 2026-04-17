# Technical Reference

This is the permanent index for Junban's technical-reference library.

Use this page to route into the canonical reference domains under `docs/reference/`.

## Start Here

| You need to...                                       | Read this doc                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Understand UI composition and behavior               | [`frontend/COMPONENTS.md`](frontend/COMPONENTS.md), [`frontend/VIEWS.md`](frontend/VIEWS.md)                                                                                               |
| Understand frontend state and app wiring             | [`frontend/CONTEXT.md`](frontend/CONTEXT.md), [`frontend/HOOKS.md`](frontend/HOOKS.md), [`frontend/API_LAYER.md`](frontend/API_LAYER.md), [`frontend/THEMES.md`](frontend/THEMES.md)       |
| Review keyboard and shortcut behavior                | [`frontend/SHORTCUTS.md`](frontend/SHORTCUTS.md)                                                                                                                                           |
| Understand core backend architecture and persistence | [`backend/CORE.md`](backend/CORE.md), [`backend/API.md`](backend/API.md), [`backend/DATABASE.md`](backend/DATABASE.md), [`backend/STORAGE.md`](backend/STORAGE.md)                         |
| Understand parser, AI, voice, MCP, and CLI internals | [`backend/PARSER.md`](backend/PARSER.md), [`backend/AI.md`](backend/AI.md), [`backend/VOICE.md`](backend/VOICE.md), [`backend/MCP.md`](backend/MCP.md), [`backend/CLI.md`](backend/CLI.md) |
| Review shared backend utility behavior               | [`backend/UTILS.md`](backend/UTILS.md)                                                                                                                                                     |
| Work on plugin runtime internals                     | [`backend/PLUGINS.md`](backend/PLUGINS.md)                                                                                                                                                 |
| Build plugins against the public plugin API          | [`plugins/README.md`](plugins/README.md), [`plugins/API.md`](plugins/API.md), [`plugins/EXAMPLES.md`](plugins/EXAMPLES.md)                                                                 |

## Domains

| Domain   | Location                 | Scope                                                                                               |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| Frontend | [`frontend/`](frontend/) | UI components, views, contexts, hooks, API layer, themes, shortcuts                                 |
| Backend  | [`backend/`](backend/)   | Core services, API transport, persistence, parser, AI, voice, MCP, CLI, plugin internals, utilities |
| Plugins  | [`plugins/`](plugins/)   | Plugin-author onboarding, API reference, and examples                                               |

## Notes

- Canonical docs map: [`../README.md`](../README.md)
- Contributor and maintainer workflows: [`../guides/CONTRIBUTING.md`](../guides/CONTRIBUTING.md), [`../guides/MAINTAINERS.md`](../guides/MAINTAINERS.md)
- Historical IA planning baseline (secondary): [`../guides/DOCS_IA_AUDIT.md`](../guides/DOCS_IA_AUDIT.md)
