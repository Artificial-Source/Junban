# Portable Plugin Runtime Research

Initial research: 2026-07-28
Implementation checkpoint: 2026-08-04

## 2026-08-04 implementation checkpoint

- Junban keeps Rust 1.93.0 and pins `wasmtime`/`wasmtime-wasi` **45.0.3**, the newest supported patch line with MSRV 1.93. Wasmtime 46/47 require Rust 1.94 and do not justify a workspace-wide toolchain change in Phase 7.
- Runtime features start from `default-features = false` and add only the measured Component Model/runtime/compiler/cache/async pieces required by the retained host. `wasmtime-wasi` uses Preview 2 only; Preview 1 and experimental Preview 3 remain off unless a golden component proves an exact Preview-2 baseline need.
- Host limits require `StoreLimits` on the mutable store owner, on-demand memory allocation unless the placement spike disproves it, epoch interruption plus cancellation of host futures, a selective linker, and separate process RSS/cgroup evidence. Store limits are not described as an RSS limit.
- Rust authoring uses stable `wasm32-wasip2` and `wit-bindgen`; `cargo-component` is no longer the primary documented path because Bytecode Alliance is deprecating it.
- TypeScript authoring pins build-only `@bytecodealliance/jco` **1.26.1** and `@bytecodealliance/componentize-js` **0.22.0**. The resulting StarlingMonkey-bearing component receives separate package, cold-start, and active-memory evidence and never launches Node at product runtime.
- Package verification uses SHA-256 plus strict Ed25519 (`ed25519-dalek` **2.2.0**, `verify_strict`, no legacy/hazmat feature). Phase 7 uses a small release-scoped signed static registry rather than full TUF, Sigstore, Warg/OCI, Minisign-as-runtime-ABI, or a nonexistent marketplace service.
- The approved detailed authority, package/signing ceremony, effect model, generations, schema, UI, limits, and wave gates live in [`phase-7-context-map.md`](phase-7-context-map.md). This research note does not override it.

## Decision

Use **Wasmtime, the WebAssembly Component Model, WASI Preview 2, and a narrow versioned Junban WIT world** as the long-term plugin foundation.

The default Junban runtime must not initialize a Wasmtime engine when no plugin is enabled. The implementation phase must benchmark in-process lazy loading against an on-demand Rust plugin-host process; choose the model that preserves low default memory while maintaining fault isolation and acceptable command latency.

## Why this direction

- Wasmtime is the reference Component Model implementation and has first-class Rust embedding and generated WIT bindings.
- WIT provides a typed, versioned, multi-language contract instead of a proprietary JSON/string ABI.
- Host imports define exact capabilities. Junban can grant only declared task, HTTP, filesystem, event, settings, and logging functions.
- WASI filesystem and sockets can remain absent by default and be introduced only through explicit capability policy.
- Per-store memory, instance, table, stack, fuel/epoch, wall-time, response-size, and concurrency limits are available.
- Rust components use the stable `wasm32-wasip2` path. TypeScript can compile through `tsc`/bundling and `jco`/`componentize-js` without a resident Node runtime in Junban.
- Windows, macOS, and Linux are supported.

Extism offers mature plugin-product ergonomics and useful manifest patterns, but its public ABI is not the Component Model and maintainers have not committed to near-term Component Model adoption. Junban should borrow its permission and resource-limit UX rather than establish Extism as a second public ABI.

## TypeScript reality

The supported TypeScript route is real TypeScript transpiled and bundled to JavaScript, then componentized with `jco`/`componentize-js`. This is good authoring DX but embeds a JavaScript engine in the component and may add roughly 8 MiB plus guest heap per active component. Therefore:

- TypeScript plugins load lazily.
- Junban documents their larger memory cost honestly.
- The host bounds active instances and unloads idle plugins where behavior permits.
- AssemblyScript is not marketed as TypeScript; it is a different, TS-like language.
- Javy may later serve narrow function-style plugins, but it is not the primary rich plugin API.

Node may be used by plugin authors at build time. No Junban release process or runtime launches Node to execute plugins.

## Initial package and contract

A plugin package contains:

```text
manifest.json
plugin.wasm
README.md
optional SBOM and signature material
```

The manifest records plugin ID/version, WIT world/version, requested permissions, compatible Junban range, entry points, and hashes. Junban verifies hash and signature before compilation and verifies that actual imports are a subset of declared permissions.

Initial WIT exports should remain synchronous and narrow: registration metadata, commands, event handling, import/export transforms, and settings validation. Host imports should mediate task reads/mutations, scoped settings, bounded HTTP, logging, and selected events. Raw secrets are never exposed. Raw filesystem and sockets are absent by default.

WASI Preview 3 and native async components remain outside the first implementation because their host and guest tooling is still evolving. Host implementations may perform asynchronous work internally behind a bounded synchronous plugin call.

## Resource and security acceptance

Every invocation is subject to:

- per-instance linear-memory and stack ceilings;
- fuel and/or epoch interruption plus a wall-clock deadline;
- bounded concurrent instances and host buffers;
- network hostname/method/size allowlists;
- explicit filesystem preopens, normally none;
- output and log-size limits;
- deterministic failure without partial domain mutation;
- a capability ledger visible to the user;
- cross-platform hostile-plugin tests.

No missing or unknown import is granted implicitly. Plugin domain mutations pass through the same Rust application service and transaction rules as web, CLI, MCP, and desktop actions.

## Evolution

1. Versioned WIT world, Wasmtime host, Rust SDK, TypeScript template, package verification, limits, and two reference plugins.
2. Permission UI, content-addressed/AOT cache, metrics, import-vs-manifest linter, and cross-platform matrix.
3. Additional languages only when their toolchains are mature and demanded.
4. Re-evaluate WASI Preview 3 async and shared JavaScript-engine work only after they are stable and measured.

Do not support dual Extism and WIT public contracts unless a future requirement justifies permanently splitting the ecosystem.

## Primary sources

- https://docs.wasmtime.dev/wasip2-plugins.html
- https://docs.wasmtime.dev/api/wasmtime/component/index.html
- https://docs.wasmtime.dev/api/wasmtime_wasi/index.html
- https://docs.wasmtime.dev/api/wasmtime/struct.Config.html
- https://component-model.bytecodealliance.org/running-components/wasmtime.html
- https://component-model.bytecodealliance.org/language-support/building-a-simple-component/javascript.html
- https://github.com/bytecodealliance/ComponentizeJS
- https://github.com/bytecodealliance/jco
- https://github.com/bytecodealliance/wit-bindgen
- https://github.com/bytecodealliance/javy
- https://extism.org/docs/concepts/manifest/
- https://github.com/extism/js-pdk
- https://www.assemblyscript.org/introduction.html
