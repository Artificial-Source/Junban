# Phase 0 foundation evidence

Recorded from the Phase 0 implementation, lead integration, architecture gate, and exact-head GitHub checks.

## Environment

| Item        | Value                            |
| ----------- | -------------------------------- |
| Host OS     | Linux (worktree validation host) |
| rustc       | 1.93.0 (254b59607 2026-01-19)    |
| cargo       | 1.93.0 (083ac5135 2025-12-15)    |
| Node.js     | v24.13.1                         |
| pnpm        | 10.29.1                          |
| Base commit | `d0a3ba5` (approved plan)        |

## What Phase 0 produced

- Rust 2024 virtual workspace at `0.1.0`, resolver 3, MIT, toolchain pin `1.93.0` with rustfmt/clippy
- Long-lived dependency-free `crates/junban-domain` library target
- React 19 + TypeScript + Vite 8 + Tailwind CSS 4 frontend tooling under `src/`, with a root `pnpm-workspace.yaml` preventing accidental enrollment in an ancestor workspace
- Package scripts for format, lint, typecheck, test (`--passWithNoTests`), build, docs links, runtime boundary, and aggregate `pnpm check`; the runtime check rejects Node APIs in frontend source and Node/backend artifacts in native or built-output boundaries
- Minimal GitHub Actions CI (Rust job + frontend/repo job), Dependabot for cargo/npm/actions
- Contributor docs: `CONTRIBUTING.md`, `SECURITY.md`, and focused docs under `docs/`

No product feature behavior is claimed.

## Commands run (all passed)

```bash
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:docs
pnpm check:runtime-boundary
pnpm check
pnpm audit --audit-level high
git diff --check
```

`pnpm install --frozen-lockfile` was re-run after the lockfile existed to confirm reproducibility. `pnpm audit --audit-level high` reported no known vulnerabilities after the root workspace-isolation file was added.

## `dist/` inspection

After `pnpm build`, `dist/` contained only:

- `dist/index.html`
- `dist/assets/index-*.css`
- `dist/assets/index-*.js`

No `node_modules`, `package.json`, Node executable, or backend package tree was present. `pnpm check:runtime-boundary` passed against this tree. A temporary frontend file importing `node:fs` was rejected by the check and removed, proving the browser-only source guard is active.

## Review

The Phase 0 architecture gate reported `ARCH-001`: Clippy and test CI did not yet enforce the committed Cargo graph. CI and all canonical commands gained `--locked`; locked local checks passed. A focused architecture recheck approved the fix with no remaining blocker.

## Remote verification

PR #1 required the `Rust` and `Frontend and repository` checks on its exact final head; both passed before fast-forward merge to `main`. The same exact SHA passed both jobs again on the main push. The fresh repository was then made public with protected required checks and secret-scanning push protection. The four distinct Actions references were also resolved through GitHub's API, and all five `uses:` entries are full 40-character SHA pins.

Dependabot's first public-repository run immediately proposed incompatible TypeScript 7 and Node 26 type majors. The policy was corrected to group routine patch/minor updates and ignore majors until an explicit migration is planned; those automatic major PRs were closed.

## Intentionally deferred

- `cargo-audit` / `cargo-deny` CI (mandatory when production Rust dependencies arrive in Phase 1)
- Product UI, server binary, and runtime memory measurements (Phase 1+)
