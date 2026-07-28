# AGENTS.md

This repository is the active ground-up implementation of Junban. Read this file, `CLAUDE.md`, `docs/README.md`, and `goals/rust-rewrite/execplan.md` before making material changes.

## Product direction

Junban is a local-first task manager with an unchanged React interface and a new Rust application core. The Tailnet/web server is the first delivery priority, followed by desktop, CLI, and MCP surfaces over the same core.

The retired implementation is private and archived at `Artificial-Source/Junban-legacy`. Treat it only as a visual and behavioral reference. Do not copy its backend architecture into this repository.

## Non-negotiable rules

- Preserve the approved interface design. Rendering and internals may improve, but visible changes require explicit user approval.
- All shipped backend, domain, storage, server, CLI, MCP, AI orchestration, reminder, backup, and plugin-host runtime code is Rust.
- Node.js is development/build tooling for the React frontend only; no release may require or launch a Node runtime.
- SQLite is the only live database. Markdown compatibility is import/export, not a second live backend.
- Existing legacy data, command, API, MCP, and plugin contracts do not require compatibility.
- Preserve the legacy product's supported feature set unless the ExecPlan records an explicit user decision otherwise.
- Plugins use a capability-limited portable package model. Do not add an unrestricted in-process native plugin API.
- Windows, macOS, and Linux remain supported.
- Work in explicit phases. Each phase ends with focused validation, memory/performance evidence when runnable, documentation, review, and a clean commit.
- Delete superseded scaffolding and temporary compatibility code after its phase; do not accumulate parallel implementations.
- Follow Google's code-health standard: improve the codebase while still making progress; require good, functional code rather than theoretical perfection.
- Prefer the simplest complete design for the current requirement. Do not add speculative abstractions, future-proofing, configuration, dependencies, or generalized frameworks without a demonstrated need.
- Keep changes focused and reviewable, name things clearly, test behavior proportionately, and comment why—not what. Fix root causes instead of layering workarounds.

## Planning and evidence

The live plan is `goals/rust-rewrite/execplan.md`. Keep its progress, decisions, findings, commands, and outcomes current. Baselines and phase evidence live under `goals/rust-rewrite/evidence/`.

Use `PLANS.md` for plan and review requirements. Security/plugin, storage, public-contract, accessibility, performance, release, and broad architecture work require the relevant specialist checkpoint before completion.

## Expected top-level shape

The exact workspace is finalized by the live plan. Keep these boundaries stable:

- `crates/`: reusable Rust core, persistence, server, CLI/MCP, plugin host, and shared contracts
- `src/`: React frontend only
- `src-tauri/`: thin Rust desktop shell and integration
- `tests/`: cross-surface and acceptance coverage that does not belong beside a crate
- `docs/`: canonical architecture, contributor, security, and product documentation
- `goals/`: live execution plans and evidence

## Validation posture

Run the nearest relevant checks first. Before a phase commit, run all checks named by that phase's acceptance contract. Never claim checks that were not run. Optimized release binaries—not development servers—are authoritative for runtime memory comparisons.
