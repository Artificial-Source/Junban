# Wave 1 dependency refresh

Branch: `wave-1-refresh`, based on `phase-7-plugins` (`b19608248a`). [Stacked PR #34](https://github.com/Artificial-Source/Junban/pull/34) targets the work branch, not `main`. No release, tag, signing-key change or merge is part of this refresh.

## Security and compatibility

The baseline lock contained 34 vulnerabilities. The first refreshed-lock `cargo audit --json` reported **zero vulnerabilities**, with one informational warning. No vulnerability is ignored. The resolved fixes include:

| Dependency                                        | RustSec advisories closed (2026 IDs)                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| cap-primitives                                    | 0482                                                 |
| libsqlite3-sys (bundled SQLite via rusqlite 0.43) | 0459                                                 |
| quinn-proto / quinn-udp                           | 0523, 0338, 0524, 0339, 0341, 0342, 0340, 0538       |
| rmcp 3.11.0                                       | 0462, 0457, 0461                                     |
| rustls / rustls-webpki                            | 0285, 0348, 0346, 0349, 0382                         |
| url                                               | 0592                                                 |
| Wasmtime 36.0.23                                  | 0424, 0379, 0569, 0380, 0566, 0571, 0269, 0363, 0316 |
| wasmtime-wasi 36.0.23                             | 0352, 0323, 0587, 0321, 0314, 0322                   |

The rustix and Tokio unsoundness warnings (0486 and 0386) and the yanked chacha20 release are gone. The sole policy exception is [RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543.html): **unmaintained**, not vulnerable. Released rmcp 3.11.0 and its schemars feature require chrono; there is no patched chrono version. The orchestrator approved this ID only rather than vendoring the MCP SDK. Remove it from `deny.toml` when [upstream #1469](https://github.com/modelcontextprotocol/rust-sdk/issues/1469) lands in a release. `cargo audit` deliberately continues to display the warning. Cargo-deny checks unmaintained and unsound dependencies throughout the graph, not only in the workspace.

The workspace and CI use Rust 1.100.0. Wasmtime/WASI intentionally stay on the latest patched 36.x LTS rather than 51, as requested. The retained `.wasm` components are portable guest bytecode, not serialized Wasmtime machine code: they do not need re-signing after a host patch. The signed guest examples and fixture lockfiles retain their original Rust 1.93.0 / `wit-bindgen` 0.51.0 and separate TypeScript guest compiler/runtime inputs for independent, byte-exact (Rust) or structural (TypeScript) verification. The host continues to freeze the previously accepted set of decoder features; a parser upgrade is not approval for new WASM proposals.

## Frontend and build tools

Node 26.13.1 and pnpm 12.23.0 build React 19.3.1 with Vite 8.3.8, Tailwind 4.3.5 and TypeScript 7.0.2. Vitest 5.1.1, Playwright 1.65.1 (Chromium 159), axe 4.14.1, jsdom 31 and refreshed local voice libraries run against the production frontend. The OpenAPI generator still uses the TypeScript 5 JavaScript compiler API and has its own exact 5.9.3 dependency. Icon patches preserve previously approved paths; baseline PNGs and image-diff thresholds were not updated. GitHub Actions remain pinned by full commit digest. Existing Dependabot PRs were not merged or closed.

The only product frontend updates deferred at resolution were releases inside pnpm's 24-hour supply-chain quarantine: lucide-react 1.80.0, Vitest 5.1.2, @types/node 26.6.11 and @types/react 19.3.3. Their locked versions are 1.79.0, 5.1.1, 26.6.7 and 19.3.1 respectively. No direct Rust major was deferred other than the requested Wasmtime/WASI LTS line.

## Local verification

- `cargo fmt --all -- --check` and strict workspace/all-targets/all-features Clippy passed with Rust 1.100.0. `cargo audit` 0.23.0 returned success with only the chrono notice above; `cargo deny check` 0.22.1 passed all four gates. `pnpm audit:dependencies` reported no known vulnerabilities.
- `cargo test --locked --workspace --all-features` passed 1,273 tests with four Rust test threads. Cargo and rustc used disk-backed build scratch. The test processes used a disposable owner-only disk directory outside `.cache`, because the signing-key safety policy correctly rejects keys in cache directories. An earlier concurrent run had two child-process fixture failures; the final run kept all assertions and test cases intact.
- All seven launched-child containment cases and the retained TypeScript oversized-import test passed on Linux after the Wasmtime bump. The finish/cancel race test now enforces the existing single-terminal protocol even when a natural outcome wins before the exact cancel.
- `pnpm check` passed, including 651 unit tests in 133 files, TypeScript, build, generated contract drift, local-only voice assets, signed registry/artifact checks and baseline integrity. The opt-in real Chromium voice suite also passed both tests: user-consented download, hash-verified Whisper transcription and playable Kokoro/Piper synthesis. It ran in an isolated evidence directory and port, without overwriting Phase 6 evidence.
- Release-binary Playwright: `pnpm test:e2e --update-snapshots=none` passed all 146 tests, including 65 visual and 44 axe scenarios. The build and browser suites ran sequentially so the server never served partially rebuilt assets. No snapshot was created or changed.
- The official Python MCP SDK 2.3.0 connected to the built `junban-mcp --data-dir <fresh-profile>` via stdio, using its default `Client` auto-handshake. It negotiated `2026-07-28`, validated `tools/list` (77 tools, `cacheScope: private`, `ttlMs: 0`), and successfully called `list_tasks` (empty `tasks`). rmcp 3.11.0 supplies the formerly missing cache metadata; no Junban wire-format workaround is needed.

## Hosted memory

Linux x86_64, Rust 1.100.0, optimized server SHA-256 `35f041c5ee092cf201248ecb6f396a9ee8af367eb4917e7e6989b4116f9242dd` (42,911,224 bytes). `python3 scripts/bench-hosted-server.py --server target/release/junban-server --web-dir dist --output <scratch>/wave1-memory.json` used the full frozen Phase 1 workload: five independent server cgroups, 100 tasks, 20 mutation cycles, no Node in measured processes. The recorded commit was `937da9c791`; uncommitted evidence documents were present, so this is a local budget check, not a clean-build release attestation.

| Same host, same protocol             | Warm median | Maximum warm | Maximum peak |
| ------------------------------------ | ----------: | -----------: | -----------: |
| Phase 7 QA worktree optimized server |   10.62 MiB |    11.87 MiB |    12.29 MiB |
| Refreshed optimized server           |   10.20 MiB |    10.60 MiB |    11.18 MiB |
| Frozen ceiling                       |           — |       24 MiB |       32 MiB |

The refreshed median was 0.42 MiB lower. All five samples had one warm server process; the harness marked the budget passed. Neither the host nor the refreshed dependency graph showed a regression against the same-host comparator. This measures the hosted server, not the future desktop process tree.

## CI evidence

[Integration run 45758552338](https://github.com/Artificial-Source/Junban/actions/runs/45758552338) caught a clean-room failure: the server composition tests assumed the pre-1.100 Cargo test executable layout. The fix locates the workspace-built plugin host under the profile, without changing production executable discovery. [Candidate run 45759587520](https://github.com/Artificial-Source/Junban/actions/runs/45759587520) exercises the fix. The [PR checks](https://github.com/Artificial-Source/Junban/pull/34/checks) are the authority for the latest pushed head. Draft work was not merged into `main`.
