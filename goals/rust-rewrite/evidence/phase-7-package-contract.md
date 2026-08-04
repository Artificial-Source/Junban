# Phase 7 JBP1 package and registry contract

Date: 2026-08-04
Status: Wave 0 authority draft; implementation starts only after the host-placement architecture gate
Parent authority: [`phase-7-context-map.md`](phase-7-context-map.md)
Schema authority: [`phase-7-schema-contract.md`](phase-7-schema-contract.md)
WIT authority: [`phase-7-wit-contract.md`](phase-7-wit-contract.md)

## Purpose

JBP1 is the smallest complete portable install unit for one Junban Component Model plugin. It binds one canonical typed manifest, one publisher key/signature, and one WebAssembly component without introducing archive extraction, compression bombs, path traversal, executable sidecars, native code, or runtime Node.

Signature proves control of a key, not safe behavior. Package acceptance still requires trusted bundled-index binding or explicit local signer trust, exact capability approval, dependency and compatibility checks, import validation, Wasmtime containment, and application-service validation.

## Binary envelope

All integers are unsigned big-endian. A parser consumes exactly one envelope and rejects truncation, overflow, noncanonical lengths, or trailing bytes.

```text
offset  size             field
0       8                ASCII magic "JUNBANP1"
8       4                canonical manifest length M
12      M                canonical manifest UTF-8 bytes
12+M    32               Ed25519 publisher public key
44+M    64               Ed25519 signature
108+M   8                component length C
116+M   C                WebAssembly component bytes
```

Frozen ceilings:

- manifest `M`: 1…65,536 bytes;
- component `C`: 1…33,554,432 bytes (32 MiB);
- complete envelope: at most 33 MiB (34,603,008 bytes);
- no second component, README, SBOM, icon/image, script, native library, symlink, path, compression, padding or extension field in JBP1.

A future envelope format uses a new magic/version; v1 parsers never infer optional trailing material.

## Identities and cryptography

- `manifest_sha256 = SHA-256(manifest_bytes)`.
- `component_sha256 = SHA-256(component_bytes)` and exact-matches the manifest field.
- `key_id = SHA-256(public_key)` as 64 lowercase hex and exact-matches the manifest publisher key id.
- signature message is the exact byte concatenation:

```text
ASCII "junban.plugin.package.v1\0"
32 raw manifest_sha256 bytes
32 raw component_sha256 bytes
```

- verification uses `ed25519-dalek` 2.2.0 `verify_strict`; `legacy_compatibility`, `hazmat`, and batch verification are absent;
- package identity is SHA-256 of the complete envelope as 64 lowercase hex;
- all hash/key/signature comparisons use decoded fixed-size bytes; malformed hex/base64 never falls back to text comparison;
- no unsigned product mode exists.

Golden vectors freeze one valid Rust package plus wrong magic/length/trailing byte/noncanonical manifest/component hash/key id/signature/wrong domain/wrong key/weak signature cases. Rust packer and verifier must produce/accept identical bytes on Linux, macOS, and Windows.

## Canonical manifest

Only Junban's Rust packer writes a product manifest. Authors provide a typed source manifest; pack converts it to the canonical runtime manifest before signing. TypeScript/other build tools never implement cryptographic JSON canonicalization.

Canonical runtime bytes are `serde_json::to_vec` of one fixed ordered Rust struct with:

- `deny_unknown_fields` for every record;
- no maps except explicitly sorted vectors; no duplicate IDs/keys/scopes;
- no float/NaN/infinity; numbers are bounded signed/unsigned integers;
- no insignificant whitespace or trailing newline;
- exact reparse + typed reserialization byte equality required;
- canonical lowercase ASCII IDs/semver/hashes/capabilities/origins/methods;
- arbitrary visible text remains exact signed UTF-8, is length/control-character validated, and is later rendered as escaped React text.

Top-level schema version 1 has fixed fields in this order:

```text
schema_version       integer exactly 1
id                   canonical plugin id, 1–64 bytes
name                 visible text, 1–128 bytes
description          visible text, 0–512 bytes
version              canonical SemVer, 1–64 bytes
publisher            { id, name, key_id }
license               SPDX license expression, 1–128 ASCII bytes
junban_compatibility  canonical SemVer requirement
wit                   { package: "junban:plugin", world: "plugin", version: "0.1.0" } (required export world)
runtime_profile       "rust" or "typescript"
component_sha256      64 lowercase hex
permissions          sorted unique permission records
 dependencies         sorted unique dependency records
commands              sorted unique command records
subscriptions         sorted unique event-kind records
surfaces              sorted unique declarative surface records
settings              sorted unique typed setting records
services              sorted unique read-only service records
```

(`dependencies` has no leading whitespace in actual JSON; the alignment above is explanatory.) The WIT triple names the required export world, not an author target-world identity. Canonical `plugin` has no imports and exports the exact guest interface. Each Rust/TypeScript package targets its own build-only world that includes `junban:plugin/plugin@0.1.0` and imports only selected `junban:plugin/host-*` capability interfaces plus the exact runtime-profile baseline. Its local package/world name carries no runtime authority.

Optional repository/homepage/readme/download URLs, arbitrary keywords, install paths, executable entry names, environment, native target, and package-controlled runtime limits are excluded from the runtime manifest. Search tags and release notes belong in the root-signed bundled index and remain non-authoritative presentation metadata.

### IDs and visible text

- plugin/publisher/local contribution/setting/service IDs: `[a-z0-9]+(?:-[a-z0-9]+)*`;
- externally visible contribution identity is `plugin-id:local-id` and cannot collide with first-party IDs;
- name/label/title ≤128 bytes; description/help ≤512; setting option label ≤128;
- reject NUL, bidi override/isolate control characters, and C0/C1 controls other than signed line feed/tab in description/help; React still escapes all text;
- icon is an optional canonical host allowlist ID, never a URL/path/SVG payload.

## Manifest permissions

Permissions are sorted by `(capability, canonical scope)` and are requests, not grants:

- unscoped: `tasks:read`, `tasks:write`, `projects:read`, `projects:write`, `tags:read`, `tags:write`, `settings`, `storage`, `commands`, `ui:view`, `ui:panel`, `ui:status`, `services:provide`, `logging`;
- event scope: `events:subscribe` with 1–32 exact known event kinds, never plugin-internal bookkeeping events;
- dependency scope: `services:consume` with exact declared dependency plugin/service IDs;
- HTTP scope: `http` with 1–16 exact origins and nonempty subset of `GET|POST|PUT|PATCH|DELETE`.

An HTTP origin is canonical `https://host[:nondefault-port]` only: no userinfo, path other than `/`, query, fragment, wildcard, IP literal, mixed-script/Unicode host, or default port spelling. Loopback/private/link-local origins are rejected for community packages; deterministic hostile tests use an explicit test-only authority that cannot ship. DNS resolution and every connection hop are checked against the approved public origin/address policy; redirects are disabled. Headers use a host allowlist and cannot set `authorization`, `cookie`, `host`, forwarding/proxy, connection, content-length, or Junban delivery header.

A dedicated plugin HTTP client resolves every request origin immediately before connect, rejects the request if **any** answer is not globally routable, and pins the connection to one validated answer while preserving the canonical hostname for URL authority, TLS certificate verification/SNI, and Host. It disables environment/system proxies, redirect following, automatic credential/cookie stores, and automatic retries. A later retry performs fresh all-answer validation and a new pinned connection. Request bodies over 1 MiB fail before send. Responses return at most the first 1 MiB and set the typed WIT `truncated` flag when another byte exists; body oversize is never alternatively reported as an error. Post-send uncertainty uses the typed `may-have-been-sent` delivery state.

The non-global predicate covers the IANA IPv4/IPv6 special-purpose registries and fails closed for unspecified, loopback, private/unique-local, link-local, CGNAT, protocol-assignment, documentation, benchmark, multicast, reserved/future-use, broadcast, IPv4-mapped/compatible, NAT64/local translation, 6to4/Teredo/other transition forms, and zone-scoped addresses. Hostnames `localhost`, `.localhost`, `.local`, and noncanonical trailing-dot/IDNA forms are rejected before DNS. Tests freeze representative boundaries, multi-answer public+private sets, rebinding between requests, mapped/translation forms, cloud metadata, proxy environment variables, TLS hostname/SNI and forbidden Host override.

Manifest permission entries and the exact sorted requested set hash bind package generation. Install/update never carries old grants to changed package bytes, signer, manifest, requested scope, or version.

## Dependencies and services

At most 16 unique dependencies:

```text
id            canonical plugin id, not self
requirement   canonical SemVer requirement
services      sorted unique service ids expected from that dependency, max 16
```

Junban installs one version per plugin id and performs no hidden solver/backtracking or automatic package download. Missing/incompatible dependencies return the full bounded closure for explicit operator action. Lock/update/disable/uninstall semantics are frozen in the schema contract.

A service declaration contains id/title and bounded request/response named fields and requires `services:provide`. Calling one requires an exact `services:consume` scope naming the dependency and service. Service data uses the exact WIT `data-value`: string (≤8 KiB), signed integer, boolean, canonical date/timestamp, canonical task/project/tag/plugin/option ID, or one homogeneous ≤100-element/aggregate-64-KiB typed list variant of those scalar kinds. No arbitrary JSON, nested map/tree/list, package bytes, bearer/secret, UI node, mutation, KV patch, HTTP request, or opaque byte payload crosses a dependency service. Runtime service invocation mode is read-only and denies HTTP/effects/UI even if the called plugin otherwise has those grants.

## Capability matrix

Manifest validation and runtime authorization use one exhaustive matrix; an import check alone is never authority:

| Behavior                                         | Required current generation-bound grant                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| task/project/tag query import                    | corresponding `*:read`                                                                       |
| returned task/project/tag AppService effect      | corresponding `*:write` checked again immediately before commit                              |
| command declaration/exposure/invocation          | `commands`                                                                                   |
| event declaration/delivery                       | `events:subscribe` containing that exact kind                                                |
| view/panel/status declaration, render and action | matching `ui:*`                                                                              |
| setting declaration/exposure/read/validation     | `settings`                                                                                   |
| KV read or returned patch                        | `storage`                                                                                    |
| HTTP import                                      | `http` containing exact canonical origin + method                                            |
| log import                                       | `logging`                                                                                    |
| service declaration/exposure/invocation          | `services:provide`                                                                           |
| dependency service call                          | `services:consume` containing exact active dependency + service and matching dependency lock |

Install rejects a declaration/import not represented in the requested permission set. Exposure registers only currently granted declarations. Every host import checks exact package generation + activation epoch + host session + grant and scope. Every returned outcome checks the resource-specific write/storage grant after guest return and again under the parent commit fence. Revocation drains the old epoch before removing contributions/admission; stale guest/UI replies cannot use an old grant. Focused tests omit/revoke/stale every matrix row and attempt a task/project/tag/KV effect without importing any corresponding interface.

## Permission hash preimages

All inspection, confirmation, SQLite, open/restore and runtime paths call one SDK implementation over decoded bytes:

```text
scope_hash = SHA-256(
  "junban.plugin.scope.v1\0" ||
  u32be(capability_utf8_length) || capability_utf8 ||
  u32be(canonical_scope_json_length) || canonical_scope_json
)
```

Permissions sort lexicographically by capability UTF-8 then raw scope hash. The set hash is:

```text
permission_hash = SHA-256(
  "junban.plugin.permissions.v1\0" || u32be(entry_count) ||
  for each entry:
    u32be(capability_utf8_length) || capability_utf8 || raw_32_byte_scope_hash
)
```

Empty/unscoped scope is exact canonical `{}`. Length/count conversion is checked. Golden vectors cover empty, prefix/concatenation ambiguity, reordered entries, changed scope/method/origin/event/service, duplicates and malformed encoding.

## Commands, events, surfaces and settings

### Commands

At most 32 commands: local id, title, description, optional allowlisted icon, and a bounded flat list of typed scalar input fields. Suggested hotkeys are excluded; the host/user owns conflict-free shortcuts. Command execution uses the final WIT typed outcome and caller operation id.

### Event subscriptions

At most 32 exact known task/project/tag/section event kinds, each also present in the event permission scope. Package install rejects unknown/plugin-internal kinds. Event hooks cannot subscribe to plugin lifecycle/KV/cursor/invocation events.

### Surfaces

At most 16 contributions:

- kind `view`, `panel`, or `status`;
- local id/title/optional allowlisted icon;
- view slot `navigation`, `tools`, or `workspace`; panel/status use their host-defined location;
- sorted declaration of at most 32 action IDs accepted from that surface.

Runtime output contains only the final WIT declarative node/index arrays. A node/action not declared for the active surface/package generation is rejected. Manifest contains no React module, HTML, CSS, class, style, URL/image, script or route.

### Settings

At most 64 typed operator-owned settings and 64 KiB aggregate values. Each has id/label/description plus exactly one schema:

- text: default, min/max UTF-8 bytes (max 8 KiB), optional `secret = false` only; regex is excluded;
- integer: default/min/max/step as i64;
- boolean: default;
- select: default option id and 1–32 unique `{id,label}` options.

Phase 7 exposes no plugin secret setting. Existing AI credential authority is not reused. Guest validates/reads current settings but cannot mutate them. Candidate package update must accept every existing setting before authority changes; no silent reset.

## Component validation before install/enable

Package parsing never constructs Wasmtime. A small bounded component parser/validator in the SDK/server:

1. validates WebAssembly Component Model structure and exact component length/hash;
2. requires a Component Model outer encoding, enumerates all component imports/exports, and treats embedded core modules only as component internals; JBP1 cannot carry a separate core module/native/custom executable sidecar;
3. requires exports structurally compatible with exact `junban:plugin/plugin@0.1.0` (the required guest interface) and rejects alternate Junban guest versions/exports;
4. permits the exact type-only `junban:plugin/types@0.1.0` import plus only exact `junban:plugin/host-*@0.1.0` interfaces selected by the package target world, and maps every actual capability import to a requested manifest capability;
5. for `typescript`, permits zero WASI imports; for `rust`, permits exactly `wasi:io/error@0.2.6`, `wasi:io/streams@0.2.6`, `wasi:cli/environment@0.2.6`, `wasi:cli/exit@0.2.6`, and `wasi:cli/stderr@0.2.6`, whose host implementations return empty environment/arguments/cwd, closed or bounded-sink streams and controlled exit termination. It rejects every other WASI import including filesystem/preopens, sockets/network, CLI run, inherited stdio/environment, HTTP, random, clocks, threads and unknown interfaces;
6. caps custom/name/producers metadata and ignores it as authority;
7. records exact sorted import/export fingerprint in install evidence.

`wasmparser`/component metadata dependencies and default-server linkage cost must pass the ordinary no-plugin matched-release budget in Wave 1. Final enable repeats full package hash/signature/manifest/import verification, then asks the optional host to compile/instantiate against a linker containing only known baseline/capability interfaces. A manifest cannot grant an unknown import merely by naming it.

## Local package inspection and trust

The ordinary server body limit is unchanged. Local upload uses the staged-artifact permit, content-length precheck where present, streaming hard cap, private same-filesystem temporary file, and no full-package memory buffer.

Inspection returns a bounded preview only: exact package hash/size, component hash/size, id/name/version/compatibility/runtime profile, signer key id/full fingerprint, whether signer is bundled/locally trusted/unknown/revoked, permissions/scopes, dependencies, contributions/settings/services, and stable validation errors. It returns no package/component bytes or signature.

Confirmation reuploads the file with caller operation id plus exact expected package hash, signer key id, permission hash and compatibility. Junban restages/reverifies every byte; mismatch fails. Unknown local signer additionally requires exact explicit trust confirmation. Trust never grants capabilities or enables the package. Revoked signer fails before publication.

## Bundled registry JRI1

The bundled registry is a release-scoped signed static index and immutable JBP1 files beside Junban. It is not a remote update protocol.

```text
magic "JUNBANR1" (8 bytes)
u32 canonical index length I
canonical index bytes (1…4 MiB)
64-byte Ed25519 root signature
```

The exact envelope length is checked arithmetic `76 + I` and capped at `4 MiB + 76 bytes`; truncation and every trailing byte fail. Index JSON uses the same fixed typed `deny_unknown_fields`, duplicate rejection, bounds, parse-and-reserialize byte equality and integer-only canonical rules as JBP1.

Root public key/key id are compiled into the trusted Junban release. Runtime derives SHA-256 of the compiled key and exact-matches canonical index `root_key_id` before strict Ed25519 `verify_strict`. Signature domain:

```text
"junban.plugin.registry.v1\0" || sha256(index_bytes)
```

Canonical index fields: schema version 1, Junban release/version, generated-at timestamp, root key id, and ≤1,024 sorted package-version entries. Each entry binds plugin id/version, package SHA-256 and byte length, publisher key id, name/description/author/license/search tags, runtime profile, requested capability IDs and relative content-addressed filename `sha256/<digest>.jbp`. Relative filename is derived and exact-checked, never joined from arbitrary package text.

Browse/search metadata is presentation only. Registry install verifies JRI1 root signature, exact entry, JBP1 length/hash, publisher key/signature, manifest identity/version/key/permissions, compatibility and imports. Index/package disagreement fails closed. Bundled package change arrives only through a later trusted Junban release; no network expiry/freeze/update claim is made.

The offline ceremony, external key custody, compromise cancellation and public-only CI verification are frozen in the context map. Runtime/signing tools never log private bytes.

## Filesystem publication

Verified packages publish privately and immutably to `plugins/packages/sha256/<package-digest>.jbp` by same-filesystem atomic rename + file/directory sync. Existing exact file is accepted only after full byte verification. Different bytes cannot share a digest path. No manifest field contributes a filesystem path.

SQLite publication/reconciliation ordering, orphan cleanup, restore behavior and cache non-authority are frozen in the schema contract.

## Required package tests

- every JBP1 length/overflow/truncation/trailing-byte/hash/key/signature/domain/canonical JSON failure;
- invalid/duplicate/bounded IDs/text/semver/license/runtime/WIT/permissions/origins/dependencies/contributions/settings/services;
- signer unknown/trusted/revoked, local explicit trust, package/update signer and permission change, downgrade confirmation;
- JRI1 checked length/truncation/trailing bytes/canonical duplicate+unknown fields/root fingerprint/strict weak signature/domain/index/entry/path/hash/size/publisher/manifest mismatch and index bounds;
- streaming over-limit/short body/cancellation/staging permission/atomic publish/orphan/existing-corrupt file;
- component malformed/core-only/import/export/profile baseline/unknown/undeclared/denied capability and metadata bounds;
- Rust/TypeScript golden package byte/signature/import vectors on Linux/macOS/Windows;
- parser fuzz/property corpus with no panic/unbounded allocation; signature verification always after structural/length bounds and before publication;
- diagnostics/logs/API responses contain no package bytes, signature, private key, bearer, DB path or unrestricted guest metadata.

## Security review gate

Wave 1 package code cannot close until one security specialist reviews JBP1/JRI1 parsing and canonicalization, strict signature/key trust, capability/import binding, local confirmation, streaming/staging/publication, diagnostics, registry agreement and hostile corpus. Material findings receive stable `P7-PKG-*` ledger rows and focused regression.
