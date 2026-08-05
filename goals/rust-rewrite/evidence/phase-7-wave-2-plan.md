# Phase 7 Wave 2 — hostile plugin runtime plan

Status: Slice 2A implemented; Slices 2B–2E and the Wave 2 security gate remain

## Outcome and boundary

Wave 2 creates the production `junban-plugin-host` child, strict private IPC, selective Component Model/WASI P2 linker, resource/cancellation containment, and parent-side capability/effect/dependency/event callback authority. It proves the runtime against hostile Rust and TypeScript components.

Wave 2 does **not** add public plugin HTTP/OpenAPI routes, registry transport/UI, Extensions UI, CLI/MCP tools, reference plugins, or ordinary `ServerState` startup/restore composition. Wave 3 composes the accepted lazy supervisor and event workers into server lifecycle and adds the operator contract. This preserves the frozen wave boundary while making the runtime independently testable end to end.

## Dependency decision

The historical placement spike used Wasmtime 45.0.3. Newly issued `RUSTSEC-2026-0222` affects that line, so it is blocked for production.

Wave 2 keeps Rust 1.93.0 and pins exact `wasmtime`/`wasmtime-wasi` **36.0.13**:

- 36.0.13 is the patched 24-month LTS line and is unaffected by `RUSTSEC-2026-0223`;
- Wasmtime defaults are off; only `runtime`, `cranelift`, `component-model`, and `async` are enabled;
- `wasmtime-wasi` defaults are off; Preview 2 is direct on this line, while Preview 1/P3 remain absent;
- no advisory exception or workspace toolchain bump is allowed;
- 45-era placement evidence remains historical, but active containment and performance evidence must be replaced on 36.0.13.

`P7-DEP-001` closes only after the exact lock/feature tree, clean audit/deny, hostile runtime, Rust/TypeScript imports, and replacement optimized evidence pass.

## Implementation slices

### Slice 2A — isolated child and exact protocol

Implemented by the focused Slice 2A checkpoint. `crates/junban-plugin-host` is the only crate that depends on exact `wasmtime`/`wasmtime-wasi` 36.0.13. Its reusable codec consumes the SDK's canonical u32be JSON/private-protocol types, exact protocol name/version, bounded raw bodies and full fences; the launched child constructs one configured Engine, re-hashes and compiles one parent-selected component, and never instantiates or links it. Process tests launch the absolute sibling binary with an empty environment, prove protocol-only stdout, bounded redacted stderr, compile failure, state/identity fencing, clean EOF/shutdown, and wait/reap cleanup.

The load frame now carries the already SDK-inspected import/export fingerprint that `Loaded` must echo, and hello carries the existing SDK protocol name as its exact magic. These are minimal additions to the SDK-owned authority rather than a second envelope. Unsupported invoke/cancel/unload/callback cases use the frozen fenced `Failed` frame. Slice 2B must replace `Unavailable` with real selective-linker execution; it does not replace the codec, process loop, load identity, or Engine owner.

Acceptance at this checkpoint: focused SDK/host Clippy and tests, exact dependency/features/audit checks, malformed/truncated/oversized/hash/protocol/type/correlation process coverage, absolute sibling-process environment scrubbing and wait cleanup, and an unchanged Wasmtime-free `junban-server` tree. This does not close `P7-DEP-001` or the Wave 2 security gate.

### Slice 2B — selective linker and resource sandbox

Compile and instantiate one exact verified component per loaded generation/epoch/session. Define only the five frozen Rust WASI 0.2.6 imports plus exact granted `junban:plugin` interfaces; do not call broad WASI linker helpers. Use one Engine per host process and one mutable Store owner per loaded plugin. Enforce Store limits, component memory/table/instance/stack bounds, fuel/epoch and wall deadlines, cancellation of async host futures, output/log/hostcall bounds, and serial execution per plugin.

Acceptance: allowed import goldens work; every forbidden WASI/network/filesystem/random/clock import fails before guest execution; trap, spin, bulk memory operation, grow, table/stack/output exhaustion, timeout, cancellation, store discard and clean re-instantiation all remain contained.

### Slice 2C — lazy parent supervisor and verified source bridge

Add parent-side supervisor/bridge modules that are constructible without spawning or touching Wasmtime. Storage yields only a strict opened/capped verified component source; no child message contains its filesystem path. The parent creates a fresh host session, loads dependency-first enabled graphs, fences every frame by plugin ID + package generation + activation epoch + host session + invocation ID, owns one-invocation/plugin and four-process-wide admission, and kills/reaps/clears the child on malformed output, stale identity, timeout, trap, EOF, exit, or resource exhaustion.

Acceptance: zero construction/spawn for empty graph; deterministic dependency order; stale/late reply rejection; in-flight kill and replacement; drain/cancel/shutdown/no-orphan on Linux/macOS/Windows harnesses. Wave 3—not this slice—wires the supervisor into ordinary `ServerState` startup/restore/maintenance.

### Slice 2D — capability, effect, dependency, HTTP, and event callback authority

Translate WIT values to bounded AppService requests only after exact manifest-entry and generation-bound grant checks. Top-level command/surface/event/resync calls reserve accepted Wave 1 invocation authority before dispatch. At most one post-success SQLite effect may commit through `plan_plugin_invocation_commit`; trap/cancel/invalid output commits nothing. Dependency service calls are read-only, effect/HTTP-free, ancestry/depth bounded, and generation fenced.

The sole synchronous HTTPS import is parent-owned, exact-origin/method/header/body granted, redirect- and credential-free, DNS/IP fail-closed, and bound to the stable delivery operation ID. Reservation moves to `DispatchingHttp` before send; ambiguous post-send failure becomes `AmbiguousHttp` and is never guessed successful. Event delivery uses bounded catch-up/resync callback authority and advances the cursor only in the accepted terminal transaction; bookkeeping events cannot recursively invoke plugins.

Acceptance: denial precedes guest input; one-effect atomicity/replay/changed conflict; crash windows; HTTP destination and ambiguity matrix; dependency cycle/depth/effect/egress denial; cursor ordering/history loss/resync; no task mutation on host failure.

### Slice 2E — hostile integrated gate and replacement evidence

Build signed Rust and TypeScript hostile/golden components from pinned authoring toolchains. Run protocol, import, resource, crash, effects, dependency, HTTP, event, cancellation and no-orphan matrices. Build optimized server/host separately; prove server dependency tree contains no Wasmtime and disabled startup launches no host. Replace the selected-path 45.0.3 active-runtime projections with clean 36.0.13 Rust/TypeScript child measurements while retaining separate default/Rust/TypeScript reports. Obtain the Wave 2 security gate and close every named material finding before commit.

## Ownership and lifecycle

- **SQLite/AppService:** durable package/grant/graph/epoch/invocation/receipt/effect/cursor/health authority.
- **Parent supervisor:** child process, host session, admission, cancellation, dependency ancestry, callback authorization, HTTPS transport, event workers and late-reply fencing.
- **Child host:** Wasmtime Engine/Linker/compiled components/Stores and typed guest execution only; no durable or product authority.
- **Guest:** untrusted component memory and returned values only.

Start is profile reconciliation → selected verified active graph → fresh session → child spawn → dependency-order loads → admission. Stop is close admission → cancel callbacks/calls → bounded drain → shutdown frame → kill fallback → wait/reap → clear session. Any partial drain or ambiguous result stays fail-closed.

## Validation sequence

```text
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
cargo audit
cargo deny check
cargo tree --locked -p junban-server -e normal
cargo tree --locked -p junban-plugin-host -e features
cargo build --locked --release -p junban-server -p junban-plugin-host
pnpm check
git diff --check
```

Focused host/component/hostile/benchmark commands are added with the owning slice and become authoritative only when committed in this plan and retained evidence.
