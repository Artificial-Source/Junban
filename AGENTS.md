# AGENTS.md — AI Agent Quick-Start Guide

This file helps AI agents (Claude, ChatGPT, Copilot, etc.) navigate the Saydo codebase quickly. Read this first, then dive into the specific docs you need.

## Where to Start

| You want to... | Read this first |
|-----------------|----------------|
| Understand the project | [CLAUDE.md](CLAUDE.md) (principles, tech stack, conventions) |
| Fix a frontend bug | [docs/frontend/COMPONENTS.md](docs/frontend/COMPONENTS.md) or use Grep/Glob to find the file |
| Fix a backend bug | [docs/backend/CORE.md](docs/backend/CORE.md) or use Grep/Glob to find the file |
| Add a UI component | [docs/frontend/COMPONENTS.md](docs/frontend/COMPONENTS.md) for patterns |
| Add a new view | [docs/frontend/VIEWS.md](docs/frontend/VIEWS.md) + CLAUDE.md "Add a UI view" section |
| Modify state/context | [docs/frontend/CONTEXT.md](docs/frontend/CONTEXT.md) for provider nesting and exposed functions |
| Work on AI features | [docs/backend/AI.md](docs/backend/AI.md) for pipeline, providers, and tools |
| Work on MCP server | [docs/backend/MCP.md](docs/backend/MCP.md) for tools, resources, prompts, and external agent integration |
| Work on voice | [docs/backend/VOICE.md](docs/backend/VOICE.md) for STT/TTS adapters |
| Work on plugins | [docs/backend/PLUGINS.md](docs/backend/PLUGINS.md) (internals) or [docs/plugins/API.md](docs/plugins/API.md) (author-facing) |
| Change the database | [docs/backend/DATABASE.md](docs/backend/DATABASE.md) for schema and migrations |
| Work on storage backends | [docs/backend/STORAGE.md](docs/backend/STORAGE.md) for IStorage interface + SQLite/Markdown backends |
| Understand the parser | [docs/backend/PARSER.md](docs/backend/PARSER.md) for NLP pipeline |
| Understand architecture | [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) for high-level design |
| Check security | [docs/guides/SECURITY.md](docs/guides/SECURITY.md) for threat model |
| See what's planned | [docs/planning/ROADMAP.md](docs/planning/ROADMAP.md) and [docs/planning/BACKLOG.md](docs/planning/BACKLOG.md) |

## Documentation Map

```
docs/
├── guides/            Developer guides (setup, contributing, architecture, security)
├── frontend/          Per-file reference for everything in src/ui/
│   ├── COMPONENTS.md    ~47 components with props, deps, who uses them
│   ├── VIEWS.md         17 views + 12 settings tabs
│   ├── CONTEXT.md       7 React contexts (what state, what functions)
│   ├── HOOKS.md         13 hooks (params, returns, consumers)
│   ├── THEMES.md        Theme system, CSS tokens, how to add themes
│   ├── SHORTCUTS.md     ShortcutManager API, default bindings
│   └── API_LAYER.md     Frontend-to-backend API bridge (11 modules)
│
├── backend/           Per-file reference for everything outside src/ui/
│   ├── CORE.md          TaskService, ProjectService, TagService, events, undo
│   ├── DATABASE.md      11 tables, Drizzle schema, migrations
│   ├── STORAGE.md       IStorage interface, SQLite + Markdown backends
│   ├── PARSER.md        chrono-node NLP, grammar rules, parseTask() pipeline
│   ├── AI.md            Provider registry, middleware pipeline, 28 tools
│   ├── VOICE.md         3 STT + 5 TTS adapters, audio utils, Web Workers
│   ├── MCP.md           MCP server: 28 tools, 8 resources, 3 prompts (external agent bridge)
│   ├── CLI.md           5 CLI commands (add, list, done, edit, delete)
│   ├── PLUGINS.md       Loader, sandbox, API factory, command/UI registries
│   └── UTILS.md         Logger, IDs, dates, sounds, env config
│
├── plugins/           Plugin author documentation (API ref + examples)
└── planning/          Roadmap, backlog, sprint history
```

## Key Conventions

- **TypeScript strict mode** — no `any` types
- **Named exports** preferred over default
- **React function components** only (no classes)
- **Tailwind CSS** for styling — no inline styles, no CSS modules
- **Conventional Commits** — `feat(scope):`, `fix(scope):`, `docs(scope):`
- **Zod** for runtime validation, types derived from schemas
- **SQLite** is source of truth — UI reads from DB via API layer

## Common Patterns

### Finding the right file for a bug
1. Use Grep/Glob to search for the feature keyword in `src/`
2. Read the specific doc for that area (COMPONENTS.md, AI.md, etc.)
3. Check the "Used By" and "Key Dependencies" sections to trace data flow

### Understanding data flow
```
User Input → src/ui/components/ → src/ui/api/ → src/core/ → src/storage/ → SQLite/Markdown
                                                    ↑
                                              src/parser/ (NLP)
```

### Understanding AI flow
```
User Chat → AIChatPanel → AIContext → api/ai.ts → ChatSession → Pipeline → Provider
                                                       ↓
                                                  ToolRegistry → core services
```

### Understanding MCP flow
```
External Agent → stdio → src/mcp/server.ts → ToolRegistry.execute() → core services
                                            → resources (read-only queries)
                                            → prompts (conversation starters)
```

### Understanding plugin flow
```
plugins/ dir → loader.ts → lifecycle.ts → sandbox.ts → api.ts (permission-gated)
                                              ↓
                                    command-registry.ts / ui-registry.ts
```
