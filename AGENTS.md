# AGENTS.md — AI Agent Quick-Start Guide

This file helps AI agents (Claude, ChatGPT, Copilot, etc.) navigate the Junban codebase quickly. Read this first, then use `docs/README.md` as the canonical documentation index.

## Where to Start

| You want to...           | Read this first                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Understand the project   | [CLAUDE.md](CLAUDE.md) (principles, tech stack, conventions)                                                                 |
| Fix a frontend bug       | [docs/frontend/COMPONENTS.md](docs/frontend/COMPONENTS.md) or use Grep/Glob to find the file                                 |
| Fix a backend bug        | [docs/backend/CORE.md](docs/backend/CORE.md) or use Grep/Glob to find the file                                               |
| Add a UI component       | [docs/frontend/COMPONENTS.md](docs/frontend/COMPONENTS.md) for patterns                                                      |
| Add a new view           | [docs/frontend/VIEWS.md](docs/frontend/VIEWS.md) + CLAUDE.md "Add a UI view" section                                         |
| Modify state/context     | [docs/frontend/CONTEXT.md](docs/frontend/CONTEXT.md) for provider nesting and exposed functions                              |
| Work on AI features      | [docs/backend/AI.md](docs/backend/AI.md) for pipeline, providers, and tools                                                  |
| Work on MCP server       | [docs/backend/MCP.md](docs/backend/MCP.md) for tools, resources, prompts, and external agent integration                     |
| Work on voice            | [docs/backend/VOICE.md](docs/backend/VOICE.md) for STT/TTS adapters                                                          |
| Work on plugins          | [docs/backend/PLUGINS.md](docs/backend/PLUGINS.md) (internals) or [docs/plugins/API.md](docs/plugins/API.md) (author-facing) |
| Change the database      | [docs/backend/DATABASE.md](docs/backend/DATABASE.md) for schema and migrations                                               |
| Work on storage backends | [docs/backend/STORAGE.md](docs/backend/STORAGE.md) for IStorage interface + SQLite/Markdown backends                         |
| Understand the parser    | [docs/backend/PARSER.md](docs/backend/PARSER.md) for NLP pipeline                                                            |
| Understand architecture  | [docs/guides/ARCHITECTURE.md](docs/guides/ARCHITECTURE.md) for high-level design                                             |
| Check security           | [docs/guides/SECURITY.md](docs/guides/SECURITY.md) for threat model                                                          |
| See what's planned       | [docs/planning/ROADMAP.md](docs/planning/ROADMAP.md)                                                                         |

## Documentation Map

```
docs/
├── README.md          Canonical docs index + maintenance policy
├── guides/            Setup, contributing, architecture, security, releases
├── frontend/          UI reference docs for components, views, contexts, hooks, themes
├── backend/           Core system reference for AI, voice, MCP, storage, parser, CLI, plugins
├── plugins/           Plugin author documentation (API + examples)
└── planning/          Public roadmap and project status
```

## Key Conventions

- **TypeScript strict mode** — no `any` types
- **Named exports** preferred over default
- **React function components** only (no classes)
- **Tailwind CSS** for styling — no inline styles, no CSS modules
- **Conventional Commits** — `feat(scope):`, `fix(scope):`, `docs(scope):`
- **Zod** for runtime validation, types derived from schemas
- **SQLite** is source of truth — UI reads from DB via API layer

## Documentation Synchronization Rule

Documentation must be updated in the same PR whenever code changes affect public behavior, exported API, workflow, or file organization.

Required mapping:

- `src/ui/components/**` -> `docs/frontend/COMPONENTS.md`
- `src/ui/views/**` -> `docs/frontend/VIEWS.md`
- `src/ui/context/**` -> `docs/frontend/CONTEXT.md`
- `src/ui/hooks/**` -> `docs/frontend/HOOKS.md`
- `src/ui/themes/**` -> `docs/frontend/THEMES.md`
- `src/ui/api/**` -> `docs/frontend/API_LAYER.md`
- `src/core/**` -> `docs/backend/CORE.md`
- `src/db/**` -> `docs/backend/DATABASE.md`
- `src/storage/**` -> `docs/backend/STORAGE.md`
- `src/parser/**` -> `docs/backend/PARSER.md`
- `src/ai/**` -> `docs/backend/AI.md`
- `src/ai/voice/**` -> `docs/backend/VOICE.md`
- `src/mcp/**` -> `docs/backend/MCP.md`
- `src/plugins/**` internals -> `docs/backend/PLUGINS.md`
- plugin author API changes -> `docs/plugins/API.md` and `docs/plugins/EXAMPLES.md`
- `src/cli/**` -> `docs/backend/CLI.md`
- architecture/startup/roadmap changes -> `docs/guides/ARCHITECTURE.md`, `docs/planning/ROADMAP.md`, and `CLAUDE.md` when needed

Always check `docs/README.md` before deciding that a doc update is unnecessary.

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
