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

Phase 0 foundation is in place: a Rust 2024 workspace, React/Vite/Tailwind frontend tooling, CI, and contributor docs. No usable product release yet. The hosted/Tailnet server is the first delivery priority. Follow [`goals/rust-rewrite/execplan.md`](goals/rust-rewrite/execplan.md) for scope and progress.

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
