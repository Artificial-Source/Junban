# Phase 7 Wave 2 — hostile plugin runtime plan

Status: Slice 2B implemented but security-blocked on native-memory amplification; process ceiling/recheck precede Slices 2C–2E

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

### Slice 2A.1 — generated typed private body authority

Generate checked-in pure serde body types from the one `plugin.wit` authority and byte-compare regeneration in check mode. Freeze canonical child-private JSON, exhaustive `InvocationKind` and `HostCallKind` request/success/error mappings, invocation-context construction, typed-only size/hash helpers, and malformed/cross-kind/result-branch rejection. Options are explicit value-or-null, variants/results are closed tagged forms, byte lists are canonical unpadded base64url, and parse-then-reserialize equality rejects noncanonical material. This is private transport only; WIT remains the sole public guest ABI.

Implemented on 2026-08-05: the SDK now checks in WIT-parser-generated neutral serde types and generated function argument/result adapters, owns closed request/outcome/host-call envelopes and kind/branch-derived frame/body constructors, derives invocation context from the header fence plus body entry ID, and makes the protocol validator perform one bounded parse-then-reserialize canonical check after raw hash validation. The same generator emits exhaustive neutral↔Wasmtime binding adapters in the child, where compile-time bindgen types and bounded byte conversion round trips are tested without constructing a linker or executing a guest. `ChildFrame::Outcome` now carries its invocation kind. Load bytes remain raw and cancellation remains the only empty callback reply. See [`phase-7-wave-2-slice-2a1.md`](phase-7-wave-2-slice-2a1.md).

Accepted: every request/outcome/callback branch has exact byte/hash goldens; omitted option, unknown/duplicate field, noncanonical bytes, numeric boundary, wrong kind/result and over-limit fixtures fail; generated neutral and Wasmtime binding types have compile-time/round-trip adapters and WIT drift checks. Focused API-contract recheck marked `P7-API-001` fixed and authorized Slice 2B guest execution.

### Slice 2B.1 — selective linker and serial guest execution

Implemented on 2026-08-05 as the bounded first half of Slice 2B. The child re-inspects the exact component against the runtime profile and canonical grants before compilation, constructs a linker containing only actual Junban imports with grants required for every capability-bearing interface, and adds only Rust's five exact frozen WASI 0.2.6 interfaces individually. TypeScript receives no WASI. Rust environment/arguments are empty, stdin is closed, stdout is absent, stderr is a bounded sink, and ambient WASI random, clocks, network, filesystem, processes and broad linker helpers are absent.

One Engine and one load attempt remain process-owned. A dedicated serial runtime thread owns one mutable Store/instance for the loaded activation, applies profile-specific memory/table/instance limits, a 2-MiB Wasm stack, exact per-invocation fuel and epoch-interruption configuration, and retains guest state across successful calls. `Loaded` is emitted only after import/grant/fingerprint validation, selective linking and instantiation. All nine exports use generated neutral↔Wasmtime adapters. A bounded callback rendezvous emits canonical `CapabilityRequest`, routes only the exact pending fence/kind reply, and keeps protocol input live for busy/stale/wrong/duplicate rejection. Guest WIT errors remain `Outcome`; traps/runtime failures remain fenced `Failed` and discard the Store. Idle unload drops the Store/instance.

Retained zero-WASI TypeScript executes every export, separates guest error from trap, retains activation state and unloads cleanly. Retained Rust executes legal settings/storage/log/task callbacks across lifecycle/effect invocations and proves success/error/cancel replies, stale/wrong/duplicate rejection, busy rejection, active cancel/unload/shutdown fail-closed behavior, exact grant denial before load, and idle cleanup. See [`phase-7-wave-2-slice-2b1.md`](phase-7-wave-2-slice-2b1.md).

This checkpoint does **not** complete Slice 2B, the hostile runtime gate, Wave 2 or `P7-DEP-001`.

### Slice 2B.2 — hostile exhaustion, interruption and recovery

Finish wall-deadline epoch interruption, cancellation of blocked host futures, active cancel/drain ownership, bounded host-resource-table behavior, and deterministic Store discard/re-instantiation. Exercise trap, spin, bulk memory operation, grow, table/stack/output exhaustion, timeout, cancellation, EOF/child failure during callbacks, recovery and clean replacement against signed Rust and TypeScript hostile fixtures.

Acceptance: every forbidden WASI/network/filesystem/random/clock import fails before guest execution; all hostile resource/cancellation cases remain contained; no failed or cancelled Store is reused; bounded clean re-instantiation and process cleanup pass on the required platforms. This matrix is explicitly not claimed by Slice 2B.1.

Implemented on 2026-08-05 at the child-only boundary. One watchdog now owns exact 1,000/250-ms invocation deadlines, epoch interruption, callback cancellation, and active control/EOF draining without correctness sleeps. Failed/stopped Stores enter a completion fence, are destroyed before terminal/control acknowledgement, and are replaced from the retained compiled Component; successful Stores retain state. Finite host-resource, guest-log, stderr, output, memory, table, instance, stack, fuel, and frame/callback bounds have launched hostile Rust/TypeScript coverage, as do forbidden imports, malformed/EOF/kill callback races, late replies, replacement, and process reap. CI adds the required Linux/macOS/Windows Rust containment matrix. See [`phase-7-wave-2-slice-2b2.md`](phase-7-wave-2-slice-2b2.md).

The protocol's exact 10-second compile/load authority is unchanged. It is deliberately enforced by the Slice 2C parent through child kill/reap because child-local Wasmtime compilation/initial instantiation is synchronous and not safely epoch-interruptible; Slice 2B.2 makes no false child-local timeout claim. Package signature verification and the opened verified-source bridge likewise remain parent-owned Slice 2C admission before these component bytes reach the child.

Independent security review found `P7-RUNTIME-SEC-001`: typed canonical ABI lifting can allocate native Rust strings/lists/results from 64/128-MiB guest memory before post-lift 4-MiB callback and 256-KiB output serialization bounds run. Exact cross-platform calibration subsequently rejected the macOS `RLIMIT_AS` remedy: a valid process reserves roughly 415 GiB, so its mechanical 519-GiB minimum is not a meaningful backstop. The approved minimal correction instead configures Wasmtime 36.0.13 `Store::set_hostcall_fuel` to **4,464,640 bytes** before every initial and replacement instantiation, with readback asserted. This guest-to-host canonical-lift authority is separate from wasm execution fuel and does not meter host-to-guest values. The bound derives from the 4-MiB callback body plus the largest 139,264-byte valid nested ABI structure and an explicit 128-KiB margin; generated-adapter coverage spans all 11 imports and 9 exports. Rust maximum-valid/oversized imports and the TypeScript oversized-result-string output prove pre-adapter/pre-allocation failure, normalized `resource-limit`, failed-Store destruction and same-process replacement. `P7-PLAN-RUNTIME-001`, `P7-RUNTIME-SEC-001`, and `P7-DEP-001` remain open pending focused recheck; Slice 2C remains unauthorized.

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
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
cargo audit
cargo deny check
cargo tree --locked -p junban-server -e normal
cargo tree --locked -p junban-plugin-host -e features
cargo build --locked --release -p junban-server -p junban-plugin-host
pnpm check
git diff --check
```

Focused host/component/hostile/benchmark commands are added with the owning slice and become authoritative only when committed in this plan and retained evidence.
