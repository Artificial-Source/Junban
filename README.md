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

Phase 1 provides the first source-built hosted vertical slice: the Rust server serves the preserved Today/Inbox interface and supports authenticated task creation, editing, completion, deletion, persistence, and live multi-client updates through one SQLite authority. There is still no packaged product release, and later feature phases remain incomplete.

The optimized server measured 10.13 MiB maximum warm cgroup memory in the Phase 1 five-sample workload, versus 179.25 MiB for the retired implementation on the same host. See the [frozen memory budget](goals/rust-rewrite/evidence/phase-1-hosted-memory-budget.md) and follow the [live ExecPlan](goals/rust-rewrite/execplan.md) for exact scope and progress.

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
