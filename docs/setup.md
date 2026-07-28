# Developer setup

## Prerequisites

| Tool    | Requirement                                          |
| ------- | ---------------------------------------------------- |
| Rust    | **1.93.0** pinned by `rust-toolchain.toml`           |
| Node.js | **>= 22.12** (frontend build and checks only)        |
| pnpm    | **10.29.1** (`packageManager` field in package.json) |

Install Rust from [rustup](https://rustup.rs/). The workspace toolchain file installs `rustfmt` and `clippy` automatically.

Node and pnpm are **not** runtime dependencies. Releases must not require or launch Node. The root `pnpm-workspace.yaml` intentionally keeps this checkout isolated if its parent directory is also a pnpm workspace.

## Clone and install

```bash
git clone https://github.com/Artificial-Source/Junban.git
cd Junban
pnpm install
```

## Frontend toolchain

The frontend uses:

- React 19
- TypeScript (strict)
- Vite 8 with `@vitejs/plugin-react`
- Tailwind CSS 4 via `@tailwindcss/vite` and `@import "tailwindcss";` (build-time, zero runtime)
- Oxlint, Prettier, and Vitest

`src/` is frontend-only. Product UI migration begins in Phase 1; the Phase 0 entry may render no product chrome.

### Common commands

```bash
pnpm dev                 # Vite dev server
pnpm build               # production frontend build to dist/
pnpm format:check        # Prettier check
pnpm format:write        # Prettier write
pnpm lint                # Oxlint
pnpm typecheck           # tsc project build
pnpm test                # Vitest (passWithNoTests while no product tests exist)
pnpm check:docs          # local Markdown link check
pnpm check:runtime-boundary
pnpm check               # aggregate frontend/repo checks
```

## Rust workspace

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

Phase 0 contains one library crate, `junban-domain`, so workspace commands operate on a real target.

## Repository invariants

- `pnpm check:runtime-boundary` rejects Node API imports in `src/`, Node package trees, backend Node production packages, and Node executables under native areas (`crates/`, `src-tauri/`), while allowing bundled frontend assets in `dist/`.
- `cargo-audit` / `cargo-deny` are documented for Phase 1 when production Rust dependencies arrive; they are not CI-gated on the empty Phase 0 graph.

## Further reading

- [`engineering-practices.md`](engineering-practices.md)
- [`architecture.md`](architecture.md)
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`../goals/rust-rewrite/execplan.md`](../goals/rust-rewrite/execplan.md)
