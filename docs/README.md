# Documentation

This is the canonical documentation entry point for Junban contributors and AI agents.

## Start Here

| You want to...             | Read this first                                    |
| -------------------------- | -------------------------------------------------- |
| Understand the project     | [`../CLAUDE.md`](../CLAUDE.md)                     |
| Find the right doc quickly | [`../AGENTS.md`](../AGENTS.md)                     |
| Set up local development   | [`guides/SETUP.md`](guides/SETUP.md)               |
| Contribute safely          | [`guides/CONTRIBUTING.md`](guides/CONTRIBUTING.md) |
| Understand architecture    | [`guides/ARCHITECTURE.md`](guides/ARCHITECTURE.md) |
| Check roadmap and status   | [`planning/ROADMAP.md`](planning/ROADMAP.md)       |
| Review security model      | [`guides/SECURITY.md`](guides/SECURITY.md)         |

## Structure

```text
docs/
├── README.md        Canonical docs index and maintenance policy
├── guides/          Setup, contributing, architecture, security, releases
├── frontend/        UI reference docs for views, components, context, hooks, themes
├── backend/         Core, database, parser, AI, voice, MCP, CLI, storage, plugins
├── plugins/         Plugin-author documentation and examples
└── planning/        Public roadmap and project status
```

## Ownership Map

| If you change...                                | You must update...                                              |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `src/ui/components/**`                          | `docs/frontend/COMPONENTS.md`                                   |
| `src/ui/views/**`                               | `docs/frontend/VIEWS.md`                                        |
| `src/ui/context/**`                             | `docs/frontend/CONTEXT.md`                                      |
| `src/ui/hooks/**`                               | `docs/frontend/HOOKS.md`                                        |
| `src/ui/themes/**` or design tokens             | `docs/frontend/THEMES.md`                                       |
| `src/ui/api/**`                                 | `docs/frontend/API_LAYER.md`                                    |
| `src/core/**`                                   | `docs/backend/CORE.md`                                          |
| `src/db/**`                                     | `docs/backend/DATABASE.md`                                      |
| `src/storage/**`                                | `docs/backend/STORAGE.md`                                       |
| `src/parser/**`                                 | `docs/backend/PARSER.md`                                        |
| `src/ai/**`                                     | `docs/backend/AI.md`                                            |
| `src/ai/voice/**`                               | `docs/backend/VOICE.md`                                         |
| `src/mcp/**`                                    | `docs/backend/MCP.md`                                           |
| `src/plugins/**` internals                      | `docs/backend/PLUGINS.md`                                       |
| Plugin author API surface                       | `docs/plugins/API.md` and `docs/plugins/EXAMPLES.md`            |
| `src/cli/**`                                    | `docs/backend/CLI.md`                                           |
| High-level structure, startup, deployment shape | `guides/ARCHITECTURE.md`, `planning/ROADMAP.md`, `../CLAUDE.md` |

## Documentation Maintenance Policy

Documentation is part of the feature, not follow-up work.

Rules:

1. Any change to public behavior, exported API, file organization, or user-facing workflow must update the corresponding documentation in the same PR.
2. If code changes touch one of the source areas in the ownership map above, the mapped doc must be reviewed and updated or explicitly confirmed unchanged.
3. Keep one canonical source per topic. Link across docs instead of copying the same explanation into multiple files.
4. Prefer durable docs over brittle inventories. When counts/examples drift easily, update wording to describe the system accurately without depending on fragile exact numbers unless the number is intentionally tracked.
5. Remove scratch/debug artifacts from the repo root after debugging sessions.

## Practical Workflow

Before opening a PR:

1. Run `git diff --name-only`.
2. Check whether any changed source path maps to a doc in the ownership table.
3. Update that doc in the same PR.
4. If roadmap/status claims changed, update `docs/planning/ROADMAP.md` too.
5. If contributor or agent workflow changed, update `AGENTS.md` and/or `CLAUDE.md`.

## Open Source Release Notes

For external readers:

- Product overview and downloads live in [`../README.md`](../README.md)
- Security reporting policy lives in [`../.github/SECURITY.md`](../.github/SECURITY.md)
- Full security model lives in [`guides/SECURITY.md`](guides/SECURITY.md)
- Release process lives in [`guides/RELEASES.md`](guides/RELEASES.md)
