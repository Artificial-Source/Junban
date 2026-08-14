# Portable plugins

Junban plugins are signed JBP1 packages containing WebAssembly Component Model guests for the checked-in `junban:plugin@0.1.0` world. They run in the adjacent, on-demand `junban-plugin-host` process. With no enabled plugin, Junban starts no host, constructs no Wasmtime engine, and starts no plugin event worker.

Signing establishes package and registry **integrity**, not plugin safety. Before enabling a plugin, review its publisher fingerprint, exact package digest, requested capabilities, scopes, dependencies, and declarative contributions. Junban still enforces grants, import validation, application validation, runtime limits, and generation/epoch/session fences.

## Shipped offline references

Junban bundles a signature-verified JRI1 registry and three content-addressed JBP1 references. Browsing and installing these references requires no network access:

- [`pomodoro-rust`](../plugins/reference/pomodoro-rust/README.md): Rust settings, isolated KV, host clock, commands, and declarative view/status surfaces;
- [`automation-rust`](../plugins/reference/automation-rust/README.md): Rust event subscription and one deterministic existing task mutation with receipt replay;
- [`import-typescript`](../plugins/reference/import-typescript/README.md): TypeScript typed-list bindings and one bounded bulk-task command, with no runtime Node or WASI.

The bundled registry, packages, public keys, source manifests, components, and generated server include table are checked together by:

```sh
python3 scripts/check-phase7-plugin-artifacts.py
```

This checker is public-only and does not need a signing key.

## Install and operate a plugin

Bundled browsing and installed-plugin management are in **Settings → Extensions**. Local package admission is an operator HTTP workflow for trusted tooling; it is not an automation, CLI, or MCP surface.

### Local package

1. Send the exact `.jbp` bytes as `application/octet-stream` to `POST /api/v1/plugins/packages/inspect` with operator authentication. Inspection does not install, trust, grant, or enable anything.
2. Review the returned plugin identity and version, publisher key fingerprint, package SHA-256, permission hash and scopes, compatibility, dependencies, and contributions.
3. If the publisher is unknown, compare its public key to an independently obtained publisher key, then explicitly trust that exact `key_id` and `public_key_base64` through `PUT /api/v1/plugins/publishers/{key_id}`. Restricted Mode still controls whether a community plugin may be enabled.
4. Send the same bytes to `POST /api/v1/plugins/packages/install` with a fresh `Idempotency-Key` and all exact preview confirmations: `expected_plugin_id`, `expected_version`, `expected_package_sha256`, `expected_publisher_key_id`, `expected_permission_hash`, and `expected_compatibility`. Changed bytes, signer, manifest, permissions, compatibility, or confirmation are rejected.
5. Installation is disabled by default. Review and replace the exact grants, then enable the plugin. Grant authority is bound to the exact package generation, signer, digest, and permission hash.

### Bundled registry

Open the offline browser, search or filter the shipped entries, review an entry, and install its exact index-bound package. Junban verifies the signed index, content-addressed package name and digest, publisher identity, and generated include authority before admission. A registry label alone cannot grant bundled trust.

### Restricted Mode

Restricted Mode is on by default and allows only bundled extensions to be enabled. Turning it off requires the explicit safety confirmation in Settings. It permits community plugins to proceed through normal trust and grant review; it does not trust a publisher, grant a capability, or enable a plugin automatically. Turning Restricted Mode back on drains and disables community runtime authority.

### Dependencies, grants, settings, and contributions

- Dependencies activate dependency-first. Missing, incompatible, cyclic, or over-limit graphs fail closed. A dependency cannot be disabled while an enabled dependent needs it, and cannot be uninstalled while any installed dependent declares it.
- Replacing or revoking grants drains current work and advances the activation fence. Re-enable only after reviewing the newly confirmed authority.
- Settings are declared and typed by the package. The server validates setting keys, values, package generation, and plugin validation output before committing them.
- Commands, sidebar/view/status contributions, and actions are declarative and rendered by Junban. Plugins do not load React or arbitrary HTML/JavaScript into the page. Every render, command, and action carries the server-confirmed package generation, activation epoch, runtime session, and contribution identity; stale work is rejected.
- Plugin callbacks receive only capabilities linked and granted by the server. Task queries/effects, KV, settings, logs, HTTPS, clock, and other host calls remain bounded typed authorities; guests do not receive SQLite, profile paths, operator credentials, or ambient filesystem/network access.

### Disable, retry, and uninstall

Disabling drains the plugin and removes its live contributions but preserves its package metadata, grants, settings, and KV. Retry starts a fresh activation attempt after a runtime failure.

Uninstall uses an accessible in-page confirmation. Dependents are checked first. A successful uninstall removes plugin metadata, grants, settings, KV, dependency locks, and contribution authority, then deletes only package/cache objects no longer referenced by another installed plugin. Cleanup failure may leave an inert orphan for bounded reconciliation; it cannot restore plugin authority.

## Backup, restore, and startup recovery

Complete backups include schema-v7 plugin metadata, inactive grants, settings, KV, dependency declarations, publisher trust, package generations, and cursors. They exclude JBP1 package files, disposable compiled caches, private signing material, and the profile-private cursor verifier key.

Restore drains and reaps the host, disables every restored plugin, advances activation epochs, marks packages `reverify_required`, and requires resync. It never replays pre-restore hooks and never starts a plugin host during cutover. Before an operator can explicitly enable a restored plugin, Junban re-reads and verifies the entire local JBP1 envelope. Missing or corrupt package objects remain quarantined. An unchanged, exactly reverified package may reuse its generation-bound inactive grant only after permissions are shown again; changed bytes, signer, or manifest require a new package generation and grant.

At ordinary startup, Junban revalidates plugin rows and package objects, fences stale in-flight work, removes bounded old unreferenced objects, and reconstructs only verified desired state. Malformed durable authority fails closed rather than being silently truncated.

## HTTP operator boundary

All plugin routes are below `/api/v1/plugins` and are operator-only, including read, inspection, registry, trust, grant, setting, lifecycle, contribution, render, command, and action routes. An automation bearer is rejected with `403 operator_required` even when it has `read`, `write`, and `data` scopes. Plugin routes are intentionally absent from the frozen CLI/MCP automation catalog.

Mutations require an `Idempotency-Key` UUID and use Junban's normal receipt/event authority. Local package uploads use `application/octet-stream`, are streamed to private bounded staging, and are verified before atomic publication. The generated contract at [`../openapi/junban-v1.json`](../openapi/junban-v1.json) is the exact route and schema reference. Do not place a bearer, signing key, or private path in commands, screenshots, issue reports, or evidence.

## Authoring

The author inputs are the public WIT under `crates/junban-plugin-sdk/wit/`, a component, and a versioned `plugin-source.json`. The Rust artifact tool is the only source-manifest-to-canonical-runtime-manifest and JBP1/JRI1 construction authority. Do not hand-maintain a runtime manifest or add derived `component_sha256` or `publisher.key_id` fields to the source manifest.

### Rust component path

Use Rust 1.93.0, `wasm32-wasip2`, and the package-local locked dependencies. The shipped examples build exactly as follows:

```sh
rustup target add wasm32-wasip2

cargo test --manifest-path plugins/reference/pomodoro-rust/Cargo.toml --locked
cargo build --manifest-path plugins/reference/pomodoro-rust/Cargo.toml \
  --locked --release --target wasm32-wasip2

cargo test --manifest-path plugins/reference/automation-rust/Cargo.toml --locked
cargo build --manifest-path plugins/reference/automation-rust/Cargo.toml \
  --locked --release --target wasm32-wasip2
```

The reference READMEs document the exact retained artifact copy and reproducibility checks. A Rust guest may import only the frozen five-interface WASI baseline plus Junban interfaces justified by its manifest and runtime profile.

### TypeScript component path

The TypeScript reference uses exact Node.js 24.13.1, npm 11.18.0, TypeScript 6.0.3, JCO 1.26.1, and ComponentizeJS 0.22.0:

```sh
cd plugins/reference/import-typescript
npm ci
npm run check
```

After an intentional source change, run `npm run build` and then `npm run check`. Node, npm, JCO, and ComponentizeJS are author/build/test tools only; Junban never launches them to inspect, install, enable, or run a plugin. TypeScript components have zero WASI imports.

The package-local audit currently reports the `componentize-js → weval → decompress@4.2.1` advisory and **does not pass**. The bounded build-host disposition, reopening conditions, and unchanged root `pnpm audit --audit-level high` gate are documented in [`security.md`](security.md#typescript-plugin-authoring-audit-disposition).

## Artifact tool

Build the permanent CLI with:

```sh
cargo build --locked --release -p junban-plugin-sdk \
  --features artifact-cli --bin junban-plugin-artifact
```

Use `target/release/junban-plugin-artifact` (append `.exe` on Windows) for public operations:

```sh
target/release/junban-plugin-artifact source-manifest check "$SOURCE_MANIFEST"
target/release/junban-plugin-artifact package verify \
  --source "$SOURCE_MANIFEST" --component "$COMPONENT" --package "$PACKAGE"
target/release/junban-plugin-artifact registry verify \
  --references plugins/reference \
  --metadata plugins/registry/registry-source.json \
  --root-public-key plugins/registry/root-public-key.bin \
  --publisher-public-key plugins/registry/publisher-public-key.bin \
  --index plugins/registry/index.jri \
  --packages plugins/registry/sha256 \
  --include-table crates/junban-server/src/bundled_registry_include.rs
target/release/junban-plugin-artifact registry include-table \
  --root-public-key plugins/registry/root-public-key.bin \
  --publisher-public-key plugins/registry/publisher-public-key.bin \
  --index plugins/registry/index.jri \
  --packages plugins/registry/sha256 \
  --output crates/junban-server/src/bundled_registry_include.rs --check
```

### Signing commands and key custody

Signing reads an external file containing exactly one raw 32-byte Ed25519 seed. It never accepts key bytes through arguments or environment variables and never overwrites outputs. On Unix, the seed must be a single-link, non-symlink regular file with an owner-read bit and no executable, special, group, or other permission bits; mode `0600` is the normal choice. The tool rejects keys beneath any Git checkout or path component such as `target`, evidence/dogfood output, and common package-manager caches/stores. Ceremony policy additionally forbids profiles, build roots, logs, CI, and release output even when a path would otherwise pass the tool's metadata checks.

Set shell variables only to external paths; do not record their values:

```sh
target/release/junban-plugin-artifact key public \
  --key-file "$EXTERNAL_PUBLISHER_SEED" \
  --output plugins/registry/publisher-public-key.bin

target/release/junban-plugin-artifact package sign \
  --source "$SOURCE_MANIFEST" --component "$COMPONENT" \
  --key-file "$EXTERNAL_PUBLISHER_SEED" --output "$NEW_PACKAGE"

target/release/junban-plugin-artifact index sign \
  --packages plugins/registry/sha256 \
  --metadata plugins/registry/registry-source.json \
  --publisher-public-key plugins/registry/publisher-public-key.bin \
  --key-file "$EXTERNAL_ROOT_SEED" \
  --root-public-key-output plugins/registry/root-public-key.bin \
  --output plugins/registry/index.jri
```

Package signing derives the canonical runtime manifest, signs JBP1, and immediately public-verifies it. Index signing derives entries from already verified packages, signs JRI1, publishes the public root, and immediately verifies it.

Windows public verification, component builds, product runtime, and the reference matrix are supported. Private signing intentionally fails closed on Windows because no reviewed owner-only DACL verifier exists in this tool. Perform a signing ceremony on a supported Unix host; this custody restriction does not reduce Windows runtime support.

The complete ceremony and clean-candidate evidence protocol is [`phase-7-wave-5-protocol.md`](../goals/rust-rewrite/evidence/phase-7-wave-5-protocol.md). Never commit, copy into a profile, upload, log, or retain a release ceremony's private seeds.
