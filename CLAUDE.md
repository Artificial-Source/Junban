# Junban Development Guide

## What this repository is

This is the active, fresh-history implementation of Junban: a local-first task manager with a React interface and a Rust application core.

The interface is intentionally preserved from the retired implementation while the server, domain, persistence, desktop integration, CLI, MCP, AI orchestration, reminders, backup/restore, and plugin runtime are redesigned around one Rust workspace. The web/Tailnet server is the first delivery priority, but desktop and automation surfaces are first-class outcomes.

## Why the rewrite exists

The retired hosted runtime kept two Node processes resident and measured 179.25 MiB of warm cgroup memory on the baseline host. A comparable optimized Rust web process measured 13.45 MiB. Junban has a broader feature set and is not expected to match that comparison automatically, but eliminating the shipped Node runtime creates the largest credible memory improvement.

See `goals/rust-rewrite/evidence/baseline-memory.md` for methodology and exact measurements.

## Product constraints

- The approved React design does not change without explicit approval.
- SQLite is the sole authoritative live store.
- Markdown is a portable import/export format.
- No compatibility layer is required for legacy databases, commands, API shapes, MCP tools, or plugins.
- All release runtime logic outside the React webview is Rust.
- Node and pnpm may be used to build and test the frontend, but they are not shipped runtime dependencies.
- Plugin packages are sandboxed and capability-limited, with TypeScript and Rust authoring experience as initial design goals.
- AI and voice remain optional product features and should not inflate default startup when unused.
- The same domain rules must power web, desktop, CLI, MCP, and plugin actions.

## Working method

1. Read `AGENTS.md`, `docs/README.md`, and the live ExecPlan.
2. Work only on the current approved phase.
3. Add the smallest complete vertical behavior for that phase. Prefer simple, readable, functional code over speculative flexibility or theoretical perfection.
4. Validate correctness, design fidelity, accessibility, memory, and performance as applicable.
5. Update canonical documentation and the ExecPlan.
6. Obtain the required review checkpoint.
7. Commit the completed phase with a clean working tree.

The archived repository is a specification source, not an implementation dependency. Copy approved frontend assets and behavior deliberately; do not import backend code, build history, release machinery, or compatibility complexity by default.
