# TypeScript bulk-complete reference plugin

This shipped reference demonstrates Junban's TypeScript component authoring path and typed list bindings. Its only command, `bulk-complete`, returns the existing `domain-mutation/bulk-tasks` effect with action `complete` for 1–500 unique canonical task IDs. It declares no events, surfaces, settings, dependencies, or services and imports no host capability interface.

## Author build and checks

Node.js is author-only build and test tooling. It is not required by Junban, `junban-plugin-host`, the retained WebAssembly component, or a packaged plugin at runtime.

Use exactly Node.js 24.13.1 and npm 11.18.0 with the package-local npm lock. The build actively checks those versions plus TypeScript 6.0.3, JCO 1.26.1, and ComponentizeJS 0.22.0 before component generation:

```sh
cd plugins/reference/import-typescript
npm ci
npm run check
```

`npm run check` regenerates strict JCO guest bindings in a temporary directory, checks the retained bindings, typechecks the TypeScript source and source-level command tests, builds a fresh component with `--disable all`, and inspects both fresh and retained components. The only permitted component import is the type-only `junban:plugin/types@0.1.0`; the only export is `junban:plugin/guest@0.1.0`. No WASI or Junban host interface is imported.

After an intentional source change, refresh the checked-in bindings, component, and provenance with:

```sh
npm run build
npm run check
```

The retained source-package artifact is `artifacts/import-typescript.wasm`. ComponentizeJS/Wizer output is not byte reproducible, so checks do not compare a fresh component byte-for-byte. `component-provenance.json` records the retained artifact identity, exact frozen/local WIT hashes, exact Node.js/npm/TypeScript/JCO/ComponentizeJS versions, disabled WASI profile, and expected import/export structure; `npm run check` verifies that structural authority for fresh and retained components.

## Build-host security disposition

The package-local `npm audit` currently reports an advisory through the exact build-only chain `componentize-js → weval → decompress@4.2.1`; it does **not** pass and is not considered fixed. The authoritative ComponentizeJS invocation omits AOT, JCO invokes componentization with `enableAot:false`, every build dependency is exactly pinned, and the build accepts no untrusted archive input. Node and this graph are absent from Junban's product runtime.

Reassess before enabling AOT, accepting any untrusted archive/build input, changing Node/npm/JCO/ComponentizeJS/weval/decompress versions or invocation paths, or when the advisory or an applicable patch changes. This bounded disposition does not suppress or weaken the repository's mandatory root `pnpm audit --audit-level high` gate. See the full [TypeScript plugin authoring audit threat model](../../../docs/security.md#typescript-plugin-authoring-audit-disposition).

`plugin-source.json` is author input for Junban's Rust SDK-owned manifest derivation and package tool. This source package does not sign or package artifacts, generate keys, or contain private/public signing material.
