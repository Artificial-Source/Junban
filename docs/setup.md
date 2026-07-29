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
pnpm test                # Vitest (passWithNoTests while no product UI tests exist)
pnpm contract:generate   # regenerate checked OpenAPI and TypeScript types
pnpm contract:check      # non-mutating contract drift check
pnpm check:docs          # local Markdown link check
pnpm check:runtime-boundary
pnpm check               # aggregate frontend/repo and contract checks
```

## Rust workspace

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

The Phase 1 backend crates are `junban-domain`, `junban-app`, `junban-storage`, and `junban-server`. Supply-chain checks are also required:

```bash
cargo deny check
cargo audit
```

## Run the hosted server

Build the frontend first, then start the Rust server:

```bash
pnpm build
cargo run --locked -p junban-server -- \
  --data-dir ./data \
  --web-dir ./dist
```

The default listener is `127.0.0.1:4219`. `--bind` changes the listener and repeatable `--host` values add exact raw Host header values (include the port when clients send one). The default private profile directory is OS-appropriate: `$XDG_DATA_HOME/junban` or `$HOME/.local/share/junban` on Linux/BSD, `$HOME/Library/Application Support/Junban` on macOS, and `%LOCALAPPDATA%/Junban` on Windows. When the required environment data is unavailable the server falls back to `./data`. `--data-dir` overrides the default. The server creates a private bearer token at `<profile>/access-token` and private token-free discovery metadata at `<profile>/runtime.json`. Do not paste the token into query strings or logs. Browser clients bootstrap from a URL-fragment token; API clients can send `Authorization: Bearer <token>` directly. Graceful shutdown accepts Ctrl-C on every platform and also SIGTERM on Unix, then removes runtime metadata and releases the profile lock.

Run `cargo run --locked -p junban-server -- --help` for the complete small configuration surface.

## Repository invariants

- `pnpm check:runtime-boundary` rejects Node API imports in `src/`, Node package trees, backend Node production packages, and Node executables under native areas (`crates/`, `src-tauri/`), while allowing bundled frontend assets in `dist/`.
- `cargo-audit` and `cargo-deny` are CI-gated now that production Rust dependencies exist.
- Rust DTOs and route annotations own `openapi/junban-v1.json`; never hand-edit it or `src/ui/api/generated.ts`.

## Further reading

- [`engineering-practices.md`](engineering-practices.md)
- [`architecture.md`](architecture.md)
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`../goals/rust-rewrite/execplan.md`](../goals/rust-rewrite/execplan.md)
