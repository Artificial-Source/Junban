# Documentation

This is the canonical documentation entry point for Junban contributors and AI agents.

Product-facing mission, roadmap, status, and PRD-style planning live under `docs/product/`; contributor, engineering, reference, and internal-planning docs live under their canonical domains in this tree.

Website-facing documentation lives under `docs/site/` as a publishing surface, while canonical contributor/reference ownership remains in `docs/guides/`, `docs/reference/`, `docs/product/`, and `docs/internal/`.

## Start Here

| You want to...                    | Read this first                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Understand the project            | [`../CLAUDE.md`](../CLAUDE.md)                                                   |
| Find the right doc quickly        | [`../AGENTS.md`](../AGENTS.md)                                                   |
| Navigate docs by domain           | [Documentation Domains](#documentation-domains)                                  |
| Navigate website-facing docs      | [`site/README.md`](site/README.md)                                               |
| Route website docs by audience    | [`site/users/README.md`](site/users/README.md), [`site/developers/README.md`](site/developers/README.md), [`site/agents/README.md`](site/agents/README.md) |
| Set up local development          | [`guides/SETUP.md`](guides/SETUP.md)                                             |
| Contribute safely                 | [`guides/CONTRIBUTING.md`](guides/CONTRIBUTING.md)                               |
| Understand architecture           | [`guides/ARCHITECTURE.md`](guides/ARCHITECTURE.md)                               |
| Understand performance            | [`guides/PERFORMANCE.md`](guides/PERFORMANCE.md)                                 |
| Understand legacy doc stub policy | [`guides/LEGACY_COMPATIBILITY_POLICY.md`](guides/LEGACY_COMPATIBILITY_POLICY.md) |
| Check product roadmap and status  | [`product/README.md`](product/README.md)                                         |
| Review security model             | [`guides/SECURITY.md`](guides/SECURITY.md)                                       |

## Documentation Domains

Use this taxonomy first; each domain points to its canonical library location.

| Domain              | Audience                                    | Start here                                   | Canonical locations                                                              |
| ------------------- | ------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Guides              | Contributors, maintainers, agents           | [`guides/`](guides/)                         | `docs/guides/`                                                                   |
| Technical reference | Contributors, maintainers, implementers     | [`reference/README.md`](reference/README.md) | `docs/reference/frontend/`, `docs/reference/backend/`, `docs/reference/plugins/` |
| Product docs        | Maintainers, contributors, external readers | [`product/README.md`](product/README.md)     | `docs/product/`, `docs/product/prds/`                                            |
| Internal planning   | Maintainers                                 | [`internal/README.md`](internal/README.md)   | `docs/internal/planning/`, `docs/internal/sprints/`                              |
| Website docs        | External readers                            | [`site/README.md`](site/README.md)           | `docs/site/` (publication surface; each page maps to upstream `docs/guides/`, `docs/reference/`, or `docs/product/`; exception: `site/README.md` points to `docs/README.md`) |

Legacy compatibility note: `docs/frontend/`, `docs/backend/`, `docs/plugins/`, and `docs/planning/` remain as compatibility surfaces for older URLs; route new work through `docs/reference/`, `docs/product/`, and `docs/internal/`. Lifecycle and retirement guidance lives in [`guides/LEGACY_COMPATIBILITY_POLICY.md`](guides/LEGACY_COMPATIBILITY_POLICY.md).

## Structure

```text
docs/
├── README.md         Canonical docs index and maintenance policy
├── guides/           Setup, contributing, architecture, performance, security, releases
├── reference/        Technical-reference library
│   ├── README.md     Technical-reference index
│   ├── frontend/     UI reference docs for views, components, context, hooks, themes
│   ├── backend/      Core, database, parser, AI, voice, MCP, CLI, storage, plugins
│   └── plugins/      Plugin-author onboarding, API docs, and examples
├── product/          Product documentation domain
│   ├── README.md     Product-doc index
│   ├── roadmap.md    Product roadmap
│   ├── status.md     Product status snapshot
│   └── prds/         Lightweight PRD-style planning docs
├── site/             Website-facing documentation surface
│   ├── README.md     Audience hub and publication contract
│   ├── users/        User-facing landing pages
│   ├── developers/   Developer-facing landing pages
│   └── agents/       AI-agent landing pages
├── internal/         Internal planning library
│   ├── README.md     Internal planning index
│   ├── planning/     Backlog, epics, and sprint history
│   └── sprints/      Sprint execution artifacts
└── planning/         Legacy compatibility stubs
```

The structure tree intentionally omits the legacy stub directories under `docs/frontend/`,
`docs/backend/`, and `docs/plugins/`. Those paths remain only as compatibility aliases and
are governed by [`guides/LEGACY_COMPATIBILITY_POLICY.md`](guides/LEGACY_COMPATIBILITY_POLICY.md).

`docs/site/` is a website publication layer. It should route to or derive from the canonical contributor/reference domains above rather than replacing them as the source of truth.
Treat `docs/site/` as outside this ownership table except for its publication contract: most published pages must backlink to one canonical source in `docs/guides/`, `docs/reference/`, or `docs/product/`, with `docs/site/README.md` as the single exception that points to `docs/README.md` as its canonical anchor.

## Planning and product docs

| You want to...                                                | Read this first                                      |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| Understand product mission, roadmap, or PRD docs              | [`product/README.md`](product/README.md)             |
| Find internal execution planning docs                         | [`internal/README.md`](internal/README.md)           |
| See historical documentation IA planning baseline (secondary) | [`guides/DOCS_IA_AUDIT.md`](guides/DOCS_IA_AUDIT.md) |

## Canonical Ownership Map (Single Source of Truth)

This section is the single source of truth for documentation ownership and governance routing.

Audience-specific entrypoint docs (`AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/guides/CONTRIBUTING.md`, and `.github/pull_request_template.md`) may keep quick guidance, but they should link back here instead of maintaining parallel ownership-map copies.

| If you change...                                                                                                                                                                                                                         | You must update...                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/components/**`                                                                                                                                                                                                                   | `docs/reference/frontend/COMPONENTS.md`                                                                                                            |
| `src/ui/views/**`                                                                                                                                                                                                                        | `docs/reference/frontend/VIEWS.md`                                                                                                                 |
| `src/ui/context/**`                                                                                                                                                                                                                      | `docs/reference/frontend/CONTEXT.md`                                                                                                               |
| `src/ui/hooks/**`                                                                                                                                                                                                                        | `docs/reference/frontend/HOOKS.md`                                                                                                                 |
| `src/ui/themes/**` or design tokens                                                                                                                                                                                                      | `docs/reference/frontend/THEMES.md`                                                                                                                |
| `src/ui/api/**`                                                                                                                                                                                                                          | `docs/reference/frontend/API_LAYER.md`                                                                                                             |
| `src/api/**`                                                                                                                                                                                                                             | `docs/reference/backend/API.md`                                                                                                                    |
| `src/core/**`                                                                                                                                                                                                                            | `docs/reference/backend/CORE.md`                                                                                                                   |
| `src/db/**`                                                                                                                                                                                                                              | `docs/reference/backend/DATABASE.md`                                                                                                               |
| `src/storage/**`                                                                                                                                                                                                                         | `docs/reference/backend/STORAGE.md` and `docs/reference/backend/DATABASE.md`                                                                       |
| `src/utils/**`                                                                                                                                                                                                                           | `docs/reference/backend/UTILS.md`                                                                                                                  |
| `src/config/**`                                                                                                                                                                                                                          | `docs/reference/backend/UTILS.md`                                                                                                                  |
| `src/parser/**`                                                                                                                                                                                                                          | `docs/reference/backend/PARSER.md`                                                                                                                 |
| `src/ai/**`                                                                                                                                                                                                                              | `docs/reference/backend/AI.md`                                                                                                                     |
| `src/ai/voice/**`                                                                                                                                                                                                                        | `docs/reference/backend/VOICE.md`                                                                                                                  |
| `src/mcp/**`                                                                                                                                                                                                                             | `docs/reference/backend/MCP.md`                                                                                                                    |
| `src/plugins/loader.ts`, `registry.ts`, `sandbox.ts`, `installer.ts`, `network-policy.ts`, `route-policy.ts`, `command-registry.ts`, `ui-registry.ts`, `compatibility.ts`, `timeblocking-rpc-validation.ts`, and other runtime internals | `docs/reference/backend/PLUGINS.md`                                                                                                                |
| `src/plugins/api.ts`, `lifecycle.ts`, `types.ts`, `settings.ts`, and any `src/plugins/**` change that affects the public author contract                                                                                                 | `docs/reference/backend/PLUGINS.md`, `docs/reference/plugins/README.md`, `docs/reference/plugins/API.md`, and `docs/reference/plugins/EXAMPLES.md` |
| `src/cli/**`                                                                                                                                                                                                                             | `docs/reference/backend/CLI.md`                                                                                                                    |
| `src/server.ts`, `src/main.ts`, `src/bootstrap*.ts`                                                                                                                                                                                      | `docs/guides/ARCHITECTURE.md`                                                                                                                      |
| High-level structure, startup, deployment shape                                                                                                                                                                                          | `guides/ARCHITECTURE.md`, `../CLAUDE.md`                                                                                                           |
| Product mission, roadmap, status, or PRD scope                                                                                                                                                                                           | `product/mission-and-principles.md`, `product/roadmap.md`, `product/status.md`, and/or `product/prds/README.md`                                    |

## Documentation Maintenance Policy

Documentation is part of the feature, not follow-up work.

Rules:

1. Any change to public behavior, exported API, file organization, or user-facing workflow must update the corresponding documentation in the same PR.
2. If code changes touch one of the source areas in the ownership map above, the mapped doc must be reviewed and updated or explicitly confirmed unchanged.
3. Keep one canonical source per topic. Link across docs instead of copying the same explanation into multiple files.
4. Prefer durable docs over brittle inventories. When counts/examples drift easily, update wording to describe the system accurately without depending on fragile exact numbers unless the number is intentionally tracked.
5. Remove scratch/debug artifacts from the repo root after debugging sessions.
6. If website-facing docs in `docs/site/` are updated for behavior or workflow changes, confirm the corresponding canonical docs domain is updated in the same PR.

## Practical Workflow

Before opening a PR:

1. Run `git diff --name-only`.
2. Check whether any changed source path maps to a doc in the ownership table.
3. Update that doc in the same PR.
4. If product mission, roadmap, status, or PRD claims changed, update the affected `docs/product/` docs too.
5. If contributor or agent workflow changed, update `AGENTS.md` and/or `CLAUDE.md`.

## Open Source Release Notes

For external readers:

- Product overview and downloads live in [`../README.md`](../README.md)
- Security reporting policy lives in [`../.github/SECURITY.md`](../.github/SECURITY.md)
- Full security model lives in [`guides/SECURITY.md`](guides/SECURITY.md)
- Release process lives in [`guides/RELEASES.md`](guides/RELEASES.md)
