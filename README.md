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

The new implementation is being built in validated phases and has not released a usable version yet. The hosted/Tailnet server is the first delivery priority. Follow [`goals/rust-rewrite/execplan.md`](goals/rust-rewrite/execplan.md) for current scope and progress.

The retired implementation is private and archived. It is not a supported download or compatibility target.

## Development

Start with [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), and [`docs/README.md`](docs/README.md). Commands will be documented as the initial workspace foundation is committed.

## License

[MIT](LICENSE)
