# Phase 7 WIT consumers

These are build/test authorities for `junban:plugin@0.1.0`, not shipped runtime code or reference plugins. Both target worlds include canonical `plugin` and select only `host-tasks`, `host-settings`, `host-storage`, and `host-log`. Their copied `wit/deps` package must byte-match `../../wit/plugin.wit`; the check script enforces that single authority.

- `rust/`: Rust 1.93.0, `wasm32-wasip2`, exact `wit-bindgen`/CLI 0.51.0. Checked-in generated Rust bindings compile directly. The retained component imports the selected Junban interfaces plus exactly the frozen five WASI 0.2.6 interfaces.
- `typescript/`: build-only Node with exact jco 1.26.1 and ComponentizeJS 0.22.0 (the package override pins jco's componentizer edge), `--disable all`. Checked-in strict guest `.d.ts` bindings and the retained component have zero WASI imports.

Both source consumers implement all required guest exports and compile exercises for public types, including P1–P4 nullable priority, every unchanged/clear/set form, bulk priority clear/set, all project views, closed resync snapshots, and exact `TaskDraft::new` defaults.

## Regenerate and check

Install the TypeScript build-only lock first, then use the cross-platform Python driver (it uses Python hashing, not `sha256sum`):

```text
cd crates/junban-plugin-sdk/consumers/typescript
npm ci --ignore-scripts
cd ../../../..
python3 scripts/check-phase7-sdk-consumers.py --regenerate
python3 scripts/check-phase7-sdk-consumers.py
cargo test --locked -p junban-plugin-sdk
```

`--regenerate` intentionally updates generated bindings, retained components, and `artifact-provenance.json`. Check mode is nonmutating: it checks Rust binding/artifact reproducibility, regenerates and compares TypeScript bindings, typechecks when the repository compiler is installed, builds a fresh TypeScript component, validates exact retained hashes/imports/exports, and enforces the 32 MiB component ceiling.

ComponentizeJS/Wizer 0.22.0 output is not byte reproducible between invocations. Therefore check mode does not pretend a fresh TypeScript build must byte-match; ordinary Rust tests structurally inspect the exact retained hash-pinned artifact. Provenance records this limitation explicitly. No private signing material or JBP1 signature is involved in these SDK fixtures.
