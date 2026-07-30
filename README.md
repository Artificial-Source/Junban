# Junban

Junban is a local-first task manager for web/Tailnet access, desktop, command-line workflows, and AI-agent integrations.

This repository contains a ground-up implementation with:

- an unchanged React interface;
- a shared Rust application core;
- one SQLite source of truth;
- native Rust web, desktop, CLI, and MCP surfaces;
- optional AI, voice, and portable sandboxed plugins;
- explicit memory, startup, correctness, accessibility, and cross-platform validation.

## Status

Phase 2 provides complete day-to-day task management on the Rust server: task organization and search, projects and sections, tags, templates, hierarchy, relations, comments, activity, saved filters, bulk actions, undo, live multi-client convergence, and the preserved React views. Planning/time, data portability, CLI/MCP, AI/voice, plugins, and desktop packaging remain later phases. There is no packaged product release yet.

The optimized Phase 2 server measured 6.89 MiB median / 7.17 MiB maximum warm cgroup memory in the frozen five-sample workload, versus 179.25 MiB for the retired implementation on the same host. The 10,000-task scale run remained below the 24 MiB warm / 32 MiB peak budget. See the [performance evidence](docs/performance.md) and follow the [live ExecPlan](goals/rust-rewrite/execplan.md) for exact scope and progress.

The retired implementation is private and archived. It is not a supported download or compatibility target.

## Development

Requirements:

- Rust **1.93.0** (see `rust-toolchain.toml`)
- Node.js **>= 22.12** and pnpm **10.29.1** for frontend build/test only

```bash
pnpm install
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
pnpm check
```

Node is not a shipped runtime. Details: [`docs/setup.md`](docs/setup.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and [`CLAUDE.md`](CLAUDE.md).

## License

[MIT](LICENSE)
