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

Phases 1–5 deliver the hosted Rust server through backup/restore plus the native `junban` CLI and `junban-mcp` stdio server over one shared 87-tool automation catalog. Phase 6 adds optional cloud AI chat (tools, approvals, history, memories) and browser-local or cloud speech. AI and voice stay disabled by default and load lazily. Phase 7's production plugin SDK subgate defines package, WIT, trust, component-inspection, capability, and private-protocol authorities without adding schema, runtime, routes, registry, or UI. Plugin runtime and desktop packaging remain later work. There is no packaged product release yet.

Operator docs: [`docs/ai-and-voice.md`](docs/ai-and-voice.md), [`docs/cli.md`](docs/cli.md), [`docs/mcp.md`](docs/mcp.md). Phase 7 evidence starts with the [SDK matched-release protocol](goals/rust-rewrite/evidence/phase-7-sdk-matched-release-protocol.md).

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
