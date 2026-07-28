# Contributing to Junban

Thanks for helping build Junban. This repository is a ground-up Rust rewrite with a preserved React interface. Read this file together with [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), [`docs/setup.md`](docs/setup.md), and [`docs/engineering-practices.md`](docs/engineering-practices.md) before opening a change.

## Before you start

1. Confirm the active phase in [`goals/rust-rewrite/execplan.md`](goals/rust-rewrite/execplan.md).
2. Keep changes focused on that phase’s acceptance contract.
3. Prefer the simplest complete design. Do not add speculative crates, config frameworks, or abstractions “for later.”
4. Do not redesign the approved React interface without explicit approval.

## Development requirements

- Rust **1.93.0** via `rust-toolchain.toml` (includes `rustfmt` and `clippy`)
- **Node.js** `>= 22.12` and **pnpm** `10.29.1` for frontend build and checks only
- Node is never a shipped runtime dependency

See [`docs/setup.md`](docs/setup.md) for install and day-to-day commands.

## Checks to run

Rust:

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

Frontend and repository:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs format, lint, typecheck, unit tests (pass-with-no-tests until product tests exist), production build, docs link checks, and the runtime-boundary check.

Also run `git diff --check` before committing.

## Pull requests

- One focused outcome per PR when practical.
- Update the live ExecPlan and any phase evidence the change affects.
- Do not claim checks you did not run.
- Mention any intentional acceptance-contract gaps.

## Security reports

See [`SECURITY.md`](SECURITY.md).
