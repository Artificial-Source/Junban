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

`src/` is frontend-only. It contains the preserved React interface and communicates with the Rust runtime only through the generated HTTP client.

### Common commands

```bash
pnpm dev                 # Vite dev server
pnpm build               # production frontend build to dist/
pnpm format:check        # Prettier check
pnpm format:write        # Prettier write
pnpm lint                # Oxlint
pnpm typecheck           # tsc project build
pnpm test                # Vitest unit/component tests
pnpm test:e2e            # Playwright functional, accessibility and visual checks
pnpm contract:generate   # regenerate checked OpenAPI and TypeScript types
pnpm contract:check      # non-mutating contract drift check
pnpm check:docs          # local Markdown link check
pnpm check:runtime-boundary
pnpm check               # aggregate frontend/repo and contract checks
pnpm bench:hosted-server:quick   # non-authoritative Phase 1 harness dry-run
pnpm bench:hosted-server         # Phase 1 hosted memory/latency protocol
pnpm bench:scale:quick           # non-authoritative Phase 2 scale smoke (500 tasks)
pnpm bench:scale                 # Phase 2 10_000-task scale protocol
pnpm bench:self-check            # protocol constant / argument checks
```

Hosted-server evidence requires a release binary, production `dist/`, and Linux cgroup v2 with `systemd --user`. Scale mode also needs the dev-only seeder:

```bash
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
```

See [`performance.md`](performance.md), [`../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md), and the Phase 2 ten-thousand-task protocol in [`../goals/rust-rewrite/evidence/phase-2-context-map.md`](../goals/rust-rewrite/evidence/phase-2-context-map.md).

## Rust workspace

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
```

The current backend crates are `junban-domain`, `junban-app`, `junban-storage`, `junban-server`, `junban-cli`, `junban-mcp`, `junban-ai`, and the pure `junban-plugin-sdk`. The plugin SDK has no runtime host, storage, HTTP, or Wasmtime dependency. Focused Phase 7 SDK checks are:

```bash
cargo test --locked -p junban-plugin-sdk
python3 scripts/check-phase7-sdk-consumers.py
# Intentional binding/golden update only:
# python3 scripts/check-phase7-sdk-consumers.py --regenerate
cargo test --locked -p junban-server
cargo test --locked -p junban-server --no-default-features
cargo tree --locked -p junban-server --edges normal,build
cargo tree --locked -p junban-server --no-default-features --edges normal,build
python3 scripts/check-phase7-sdk-matched-release.py --self-check
```

The consumer check requires Rust 1.93 with `wasm32-wasip2`, exact `wit-bindgen-cli 0.51.0`, and `npm ci --ignore-scripts` in `crates/junban-plugin-sdk/consumers/typescript` for exact jco 1.26.1/ComponentizeJS 0.22.0. It compiles/typechecks both target worlds and verifies retained hashes, exact imports/exports, shared bindings, and the TypeScript size ceiling. See the consumer README for the explicit ComponentizeJS byte-reproducibility limitation.

The default server touches the SDK's zero-allocation static product authority, including typed pointers that retain every production parser/validator without executing one. `--no-default-features` provides the matched feature-off benchmark baseline; neither configuration links or initializes Wasmtime. Supply-chain checks are also required:

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

The default listener is `127.0.0.1:4219`. `--bind` changes the listener and repeatable `--host` values add exact raw Host header values (include the port when clients send one). The default private profile directory is OS-appropriate: `$XDG_DATA_HOME/junban` or `$HOME/.local/share/junban` on Linux/BSD, `$HOME/Library/Application Support/Junban` on macOS, and `%LOCALAPPDATA%/Junban` on Windows. When the required environment data is unavailable the server falls back to `./data`. `--data-dir` overrides the default. The server creates a private bearer token at `<profile>/access-token` and private versioned discovery metadata at `<profile>/runtime.json` (`version`, `address`, `pid`, `instance_id` only). Do not paste the token into query strings or logs. To open the browser shell, use one nonempty `#access_token=<token>` fragment; the client stores it in `sessionStorage` and immediately removes it from the URL. API clients can send `Authorization: Bearer <token>` directly. Graceful shutdown accepts Ctrl-C on every platform and also SIGTERM on Unix, then removes runtime metadata and releases the profile lock.

### CLI and MCP (Phase 5)

Release binaries `junban` and `junban-mcp` share the server profile path defaults. Full CLI usage is documented in [`cli.md`](cli.md).

```bash
cargo build --release -p junban-cli -p junban-mcp
junban status
junban --json tools list
junban task add "First task" --due-date 2030-01-15
junban --json task list --view today
junban data backup --output ./profile.junban-backup
```

`junban` discovers a verified local owner or starts a temporary API-only owner for the command lifetime. `--json` emits exactly one JSON value on stdout. Explicit `--server` requires `--credential-file` or `JUNBAN_CREDENTIAL_FILE`, rejects URL userinfo/fragments and non-HTTPS non-loopback targets, and never follows redirects.

Operator credential management:

```bash
junban auth create --name agent --scope read --scope write --write-token ./agent.token
junban auth list
junban auth revoke <credential-id> --confirm revoke
```

`auth create` generates the credential id and high-entropy token locally, writes the token to the private `--write-token` path first (never overwrites), then registers the hash with the server. Success output includes metadata and the file path but never the raw token. Destructive operator commands require an explicit `--confirm` value. Automatic local discovery may use the profile operator token; explicit `--server` always uses the credential-file contract.

`junban-mcp` is a persistent stdio server over the same session/catalog; Wave 3 completes MCP tools/resources/prompts. Stdout is MCP frames only.

Run `cargo run --locked -p junban-server -- --help` for the complete small configuration surface.

## Use over Tailnet

Keep the Rust listener on loopback and let [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) provide the private HTTPS endpoint. Add the exact MagicDNS hostname to Junban's Host allowlist:

Find this machine's MagicDNS name with `tailscale status`, then start the optimized server:

```bash
TAILNET_HOST="your-machine.your-tailnet.ts.net"
target/release/junban-server \
  --bind 127.0.0.1:4219 \
  --host "$TAILNET_HOST"
```

In another terminal, publish that loopback listener only to the tailnet:

```bash
tailscale serve --bg http://127.0.0.1:4219
```

Open `https://<TAILNET_HOST>/#access_token=<TOKEN>` once, replacing `<TOKEN>` with the contents of the private profile's `access-token` file. Junban stores the token only for that browser tab's session and removes it from the visible URL immediately. Never put the token in a query string, shell log, screenshot, or chat message. Use `tailscale serve reset` to remove the temporary Serve configuration.

## Repository invariants

- `pnpm check:runtime-boundary` rejects Node API imports in `src/`, Node package trees, backend Node production packages, and Node executables under native areas (`crates/`, `src-tauri/`), while allowing bundled frontend assets in `dist/`.
- `cargo-audit` and `cargo-deny` are CI-gated now that production Rust dependencies exist.
- Rust DTOs and route annotations own `openapi/junban-v1.json`; never hand-edit it or `src/ui/api/generated.ts`.

## Further reading

- [`engineering-practices.md`](engineering-practices.md)
- [`architecture.md`](architecture.md)
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`../goals/rust-rewrite/execplan.md`](../goals/rust-rewrite/execplan.md)
