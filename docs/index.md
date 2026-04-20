# Junban Documentation

Junban is a local-first task manager with a React desktop/web UI, a Hono API server, a Commander-based CLI, an MCP server, optional AI and voice features, and an Obsidian-style plugin system. The current repository shows a shared TypeScript core reused across those entrypoints, with SQLite as the default storage mode and a Markdown backend available in Node runtimes.

This page is the public-facing entry point for the documentation set. For the canonical maintenance map and documentation ownership rules, see [`README.md`](README.md).

## What Junban Does

- Helps individuals manage tasks locally without requiring an account or hosted backend.
- Supports natural-language task capture such as dates, priorities, tags, and projects.
- Exposes the same task data through the UI, CLI, API server, and MCP server.
- Supports optional AI, voice, and plugin workflows when configured.

## Who These Docs Are For

- New users who want to get Junban running and complete a first task workflow.
- Contributors who need a clear path into the project before reading the deeper reference docs.
- Plugin authors and automation users who need links into the technical reference.

## Read by Goal

| Goal | Start here |
| --- | --- |
| Learn Junban step by step | [`tutorials/README.md`](tutorials/README.md) |
| Solve one concrete task | [`how-to/README.md`](how-to/README.md) |
| Understand how the system works | [`explanation/README.md`](explanation/README.md) |
| Look up technical details | [`reference/README.md`](reference/README.md) |

## The Four Diataxis Areas

| Area | Purpose | Current scope |
| --- | --- | --- |
| Tutorials | Guided learning by doing | First run and first plugin workflows grounded in `docs/guides/SETUP.md`, `package.json`, and `scripts/create-plugin.ts` |
| How-to guides | Task-focused instructions | Installation, local run, remote access, storage selection, CLI, MCP, and testing workflows supported by the repo today |
| Reference | Factual technical lookup | Existing canonical docs under [`reference/`](reference/) |
| Explanation | Concepts and rationale | Architecture, storage choices, plugin model, and AI/MCP relationships grounded in `src/` and `docs/guides/ARCHITECTURE.md` |

## Recommended Reading Order

1. Start with [`tutorials/README.md`](tutorials/README.md).
2. Use the relevant page in [`how-to/README.md`](how-to/README.md) for your next task.
3. Read [`explanation/architecture.md`](explanation/architecture.md) for the public architecture overview.
4. Use [`reference/README.md`](reference/README.md) when you need exact commands, APIs, schemas, or module details.

## Related Documentation

- Contributor and maintainer routing: [`README.md`](README.md)
- Technical reference index: [`reference/README.md`](reference/README.md)
- Product docs and roadmap: [`product/README.md`](product/README.md)
- Internal planning docs: [`internal/README.md`](internal/README.md)
- Documentation surface manifest: [`manifest.md`](manifest.md)
