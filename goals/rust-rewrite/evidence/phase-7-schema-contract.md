# Phase 7 schema-v7 contract

Date: 2026-08-04
Status: Wave 0 authority draft; implementation starts only after the host-placement architecture gate
Parent authority: [`phase-7-context-map.md`](phase-7-context-map.md)

## Purpose

Schema v7 owns portable-plugin metadata, privilege and runtime fencing, isolated settings/KV, durable event delivery, and idempotent invocation state while keeping immutable package/component/cache files outside SQLite.

This document freezes ownership and invariants. Exact SQL names may change during Wave 1 only if the database reviewer receives an equivalent or stronger normalized authority; no JSON blob may quietly replace the validated columns/relations below.

## Migration boundary

- `CURRENT_SCHEMA_VERSION` advances from 6 to 7 once.
- An existing v6 profile receives a verified private pre-v7 SQLite snapshot before `apply_v7` begins. Only the existing WAL checkpoint/SQLite backup/reopen/integrity helpers are generalized from the old pre-v3 path; its post-commit fallible finalizer is **not** copied.
- Fresh profiles that apply v1…v7 in one open do not create a redundant pre-v7 snapshot.
- `apply_v7`, canonical-schema/semantic/FK/integrity checks against the transactional connection, migration receipt, and schema-version record are one immediate transaction. Any error before commit rolls back to v6.
- Commit is the only point of no return and must be the last fallible operation reported as migration. Once commit succeeds, migration returns success. Backup retention/pruning and other housekeeping are best-effort diagnostics and can never turn a committed v7 database into a reported migration failure.
- A process/OS failure at commit leaves SQLite's atomic v6 or prevalidated v7 state. The verified pre-v7 snapshot is retained until a later successful v7 open and is never deleted by the migration transaction. A later canonical-open failure enters existing recovery with that snapshot available rather than pretending v6 is still live.
- Future schema versions fail before mutation. Failure-injection covers snapshot verification, transaction checks, commit, reopened v7 validation, and non-fatal pruning.
- The canonical backup schema and scale/conformance fixtures advance to v7. There is no v7→v6 downgrade.

## Authority tables

### `plugin_profile_state`

One profile-global monotonic allocator prevents package-authority reuse without unbounded per-plugin tombstones:

| Column                    | Invariant                                                               |
| ------------------------- | ----------------------------------------------------------------------- |
| `singleton`               | primary key exactly 1                                                   |
| `next_package_generation` | integer 1…i64::MAX; allocated transactionally, never decremented/reused |
| `updated_at`              | canonical timestamp                                                     |

Every first install, update, signer/manifest/requested-permission change, uninstall/reinstall, or explicit replacement atomically consumes the next profile-global generation and increments the singleton. Uninstall deletes no allocator authority. Exhaustion fails closed; wrapping/reseeding is forbidden. Plugin id + globally unique package generation can therefore never collide with an old action even after every operation receipt has expired.

### `plugins`

One installed plugin authority:

| Column                       | Invariant                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `plugin_id`                  | primary canonical lowercase ASCII `[a-z0-9]+(?:-[a-z0-9]+)*`, 1–64 bytes                    |
| `package_generation`         | unique profile-global allocated value `< next_package_generation`                           |
| `activation_epoch`           | monotonic integer ≥0; transition rules from context map                                     |
| `package_sha256`             | canonical 64 lowercase hex, unique content identity                                         |
| `component_sha256`           | canonical 64 lowercase hex                                                                  |
| `publisher_key_id`           | canonical 64 lowercase hex                                                                  |
| `version`                    | canonical semver text                                                                       |
| `manifest_json`              | exact canonical typed manifest, ≤64 KiB UTF-8                                               |
| `permission_hash`            | SHA-256 of exact sorted requested permission/scope set                                      |
| `compatibility`              | validated host-world/Junban range material needed for diagnostics                           |
| `desired_enabled`            | strict boolean                                                                              |
| `runtime_state`              | `disabled`, `starting`, `active`, `degraded`, `failed`, `suspended`, or `reverify_required` |
| `failure_count`              | bounded nonnegative integer                                                                 |
| `last_error_code`            | nullable stable allowlisted code; no raw guest/package/secret text                          |
| `next_retry_at`              | nullable canonical timestamp                                                                |
| `installed_at`, `updated_at` | canonical timestamps                                                                        |

Database checks enforce scalar shape; open/restore validation reparses manifest, semver, IDs, hashes, permission hash, generation relationships, and cross-table graph. `runtime_state = active` is never trusted directly on process start: startup advances activation epoch and reconstructs only verified desired state.

### `plugin_grants`

One exact granted capability/scope:

| Column                            | Invariant                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `plugin_id`, `package_generation` | foreign authority; package generation must be current when active                                           |
| `capability`                      | known canonical capability ID                                                                               |
| `scope_json`                      | canonical bounded typed scope for event kinds or HTTP origins/methods; empty object for unscoped capability |
| `scope_hash`                      | SHA-256 of capability + canonical scope; part of primary key                                                |
| `permission_hash`                 | exact requested-set hash from `plugins`                                                                     |
| `granted_at`                      | canonical timestamp                                                                                         |

A grant is usable only when plugin id, package generation, permission hash, signer, package digest, and requested manifest entry exact-match. Grant/revoke drains current activation epoch and advances it; it does not change package generation. Unknown/extraneous grants make normal open/restore fail closed rather than being ignored.

### `plugin_publisher_trust`

Local-publisher trust only; bundled release-scoped keys remain compiled/signed artifact authority:

| Column                     | Invariant                                               |
| -------------------------- | ------------------------------------------------------- |
| `key_id`                   | primary key, SHA-256 of public key                      |
| `public_key`               | exactly 32 bytes                                        |
| `status`                   | `active` or `revoked`                                   |
| `trusted_at`, `revoked_at` | canonical timestamps with status-consistent nullability |

Trust never enables a plugin or grants capability. Revocation first drains and disables every current package signed by the key, then advances epochs and changes this row in the same application mutation.

### `plugin_policy`

Singleton operator policy for preserved Restricted Mode:

| Column              | Invariant                     |
| ------------------- | ----------------------------- |
| `singleton`         | exactly 1                     |
| `community_enabled` | strict boolean, default false |
| `updated_at`        | canonical timestamp           |

Bundled reference packages remain browsable in Restricted Mode. Local/community package inspection remains available, but install confirmation is blocked until the operator explicitly enables community plugins through the preserved safety dialog.

### `plugin_settings`

Typed user configuration generated from the signed manifest:

| Column                     | Invariant                                                                         |
| -------------------------- | --------------------------------------------------------------------------------- |
| `plugin_id`, `setting_key` | composite primary key; key declared exactly once in current manifest              |
| `value_json`               | canonical scalar/value accepted by the declared text/number/boolean/select schema |
| `updated_at`               | canonical timestamp                                                               |

At most 64 settings and 64 KiB aggregate/plugin. Guests may read and validate settings but cannot mutate them. Operator setting updates are ordinary global plugin resource mutations with operation receipt/event. Package update prevalidates existing settings against the candidate schema before package authority changes; incompatible values require explicit operator correction, never silent reset.

### `plugin_kv`

Guest-owned isolated state:

| Column             | Invariant                                              |
| ------------------ | ------------------------------------------------------ |
| `plugin_id`, `key` | composite primary key; canonical UTF-8 key 1–128 bytes |
| `value`            | opaque bytes ≤64 KiB/value                             |
| `updated_at`       | canonical timestamp                                    |

Aggregate cap is 2 MiB/plugin and 256 keys. A successful invocation may commit one bounded patch (set/delete list) plus its plugin-local receipt/cursor in one transaction. KV never publishes a global event or consumes global revision. Uninstall confirmation deletes KV/settings after dependent checks; disable/package update preserves them unless a signed migration path is later explicitly designed (not Phase 7).

### `plugin_event_cursors`

Durable event consumer position:

| Column            | Invariant                                          |
| ----------------- | -------------------------------------------------- |
| `plugin_id`       | primary/foreign key                                |
| `event_epoch`     | canonical global event epoch UUID                  |
| `revision`        | nonnegative and not beyond current global revision |
| `resync_required` | strict boolean                                     |
| `updated_at`      | canonical timestamp                                |

Cursor advance is plugin-local bookkeeping, not a global event. On ordinary catch-up, a SQLite-effect hook executes/exact-replays its deterministic AppService receipt before cursor advance; a KV patch and cursor may commit together; HTTP-only hook advances only after guest success. A cursor outside retained history becomes suspended/resync-required.

Resync closes that plugin's event admission. One serialized repository read transaction returns the bounded read-only snapshot together with exact global event epoch `E` and head revision `R`. The guest's resync export cannot use HTTP or return any effect. After guest success, one CAS requires the cursor still be resync-required at its expected old identity and global epoch still equal `E`, then sets cursor to `(E, R, false)`. Events committed after the snapshot have revisions `> R`; catch-up processes them before live admission reopens. Epoch change or retention loss before catch-up completion restarts bounded resync; repeated inability suspends rather than skipping.

Restore cutover rotates the global event epoch, sets every cursor to that new epoch/current restored revision with `resync_required = 1`, and never replays pre-restore hooks. Explicit enable follows the same snapshot/revision/CAS/catch-up handoff.

### `plugin_dependency_locks`

Exact offline activation graph:

| Column                          | Invariant                                               |
| ------------------------------- | ------------------------------------------------------- |
| `plugin_id`, `dependency_id`    | composite primary key, distinct canonical IDs           |
| `version_requirement`           | canonical manifest semver requirement                   |
| `resolved_version`              | exact installed canonical semver satisfying requirement |
| `dependency_package_generation` | exact current dependency generation                     |
| `dependency_package_sha256`     | exact dependency package digest                         |
| `updated_at`                    | canonical timestamp                                     |

The full graph is validated before any activation/update/disable/uninstall. It is acyclic, ≤64 nodes, ≤16 dependencies/plugin, depth ≤16. Activation is dependency-first with deterministic plugin-id tie break.

- disabling a dependency blocks while any dependent is enabled;
- uninstalling a dependency blocks while **any installed dependent** declares it, even if disabled;
- updating/downgrading/replacing a dependency prevalidates every installed dependent requirement. An incompatible candidate blocks with the full bounded closure. A compatible candidate drains every enabled dependent, allocates the dependency's new package generation, and transactionally rewrites every dependent lock to the new exact version/generation/hash before dependency-first reactivation;
- updating a dependent rebuilds its own lock set in the same package-authority transaction.

No committed normal lifecycle leaves a stale/missing dependency lock, so normal open need not accept an “unresolved” exception. Phase 7 v1 does not guess a cascade uninstall.

### `plugin_invocations`

Bounded plugin-local operation/HTTP/cursor recovery authority:

| Column                                                | Invariant                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `operation_id`                                        | primary key, caller-provided or deterministic event identity                          |
| `plugin_id`, `package_generation`, `activation_epoch` | exact invocation authority                                                            |
| `hook_kind`, `entry_id`                               | known manifest-bound entry                                                            |
| `request_hash`                                        | SHA-256 of canonical bounded request/context identity, never raw package/token/secret |
| `delivery_id`                                         | stable HTTP delivery identity derived from operation/event identity                   |
| `state`                                               | `reserved`, `dispatching_http`, `effect_committing`, or `ambiguous_http`              |
| `error_code`                                          | nullable stable allowlisted code                                                      |
| `created_at`, `updated_at`, `retain_until`            | canonical timestamps                                                                  |

This is an **in-flight/ambiguous recovery table**, not a second unbounded terminal receipt history. Reservation is durable before guest execution. HTTP transition is durable before network send and remains honestly ambiguous/at-least-once after crash, always reusing `delivery_id`. HTTP use forbids any returned SQLite effect. For an AppService outcome, the deterministic child operation receipt remains effect authority.

On success/failure/cancellation, the same transaction advances cursor or stores the ordinary bounded operation receipt as applicable and deletes this in-flight row. Read-only/render responses need no durable terminal row. Exact operator retries replay the ordinary operation receipt; event retries use cursor plus deterministic child receipt. Only unresolved HTTP ambiguity may survive process restart, for at most the existing 30-day horizon and always with the same delivery id.

Hard ceilings are 64 in-flight/ambiguous rows and 1 MiB indexed/material bytes per plugin, 256 rows and 4 MiB per profile. The row contains hashes/IDs/error code only—no response/package/token/guest log. Before reserving, storage transactionally prunes terminally resolved orphan rows; if a ceiling remains reached it rejects/suspends that plugin before inserting. Cursor/recovery-referenced or ambiguous HTTP rows are never pruned merely to make room. Startup/open and complete-backup validation enforce both row and aggregate-byte ceilings.

## Global events and revisions

Operator-visible mutations consume exactly one global revision/event/receipt:

- install/uninstall;
- enable/disable/retry/suspension transition;
- grant/revoke and local publisher trust/revoke;
- Restricted Mode policy change;
- typed user settings change;
- package update/downgrade/replacement;
- one transition to degraded/failed/suspended when runtime health materially changes.

The event primary resource is `ResourceType::Plugin` with canonical plugin id. Snapshot/event material is a bounded public summary only: id, display name, version, desired/runtime state, package/activation generations, granted/requested capability IDs, dependency status, and stable error code. It excludes component/package bytes, public-key bytes beyond fingerprint, full manifests, KV, setting values, guest logs, URLs with query data, and signatures.

Runtime invocation reservation/terminalization, KV writes, cursor movement, failure counters below a state transition, retry timestamps, heartbeat/status refresh, and cache cleanup never consume global revision and never appear in the subscribable global event stream. This prevents recursive plugin events and retention pressure.

## Open, restore, and recovery validation

Normal open and restore preflight validate all rows without truncation:

- IDs, semver, hashes, canonical JSON, timestamps, booleans/enums, counts and byte aggregates;
- public-key fingerprint and strict key length;
- current manifest ↔ package generation/digest/signer/permission hash;
- grants requested by current manifest only;
- settings declared/type-valid and KV bounded;
- dependency locks exact, compatible, acyclic, bounded and current;
- cursor epoch/revision shape and invocation transition consistency;
- runtime states, profile-global generation monotonicity, and allocator relationship.

Malformed authority fails closed on normal open and backup restore; it is not silently dropped. Recovery mode still opens only its existing minimal router and never constructs plugin application/runtime state.

After a valid complete-backup cutover:

1. rotate global event epoch as already required;
2. disable every plugin and advance activation epoch;
3. set `runtime_state = reverify_required`;
4. preserve exact package generations, profile-global next-generation allocator, inactive grants, settings, KV, dependency declarations and publisher trust;
5. reset runtime failure/backoff/invocation-in-progress rows to bounded terminal recovery states;
6. set cursor to new epoch/current revision/resync-required;
7. start no host and inspect no component file.

A later exact package re-verification may reuse a generation-bound inactive grant only after explicit operator enable displays permissions again. Changed bytes/signer/manifest allocate a new package generation and require a new grant.

## Package filesystem reconciliation

SQLite stores package SHA authority, not paths. Files are private immutable `plugins/packages/sha256/<digest>.jbp`; compiled artifacts under `plugins/cache/` are disposable.

- install stages under a private same-filesystem temporary path while holding the existing server-wide staged-artifact permit, verifies JBP1/hash/signature/manifest/imports/compatibility, fsyncs, atomically publishes by digest, then commits disabled metadata;
- crash before row commit may leave one unreferenced verified blob; bounded startup cleanup removes it after grace;
- row without exact verified blob becomes `reverify_required`, never active;
- uninstall commits metadata/grant/settings/KV/dependency removal first, then removes only now-unreferenced package/cache files; failure leaves a harmless orphan;
- no manifest-controlled path, archive extraction, symlink, hardlink, device file, executable bit, or cross-volume rename exists.

Complete backup excludes package/cache files. Restore never assumes a same-digest file already present is safe: later re-verification reads and verifies the entire envelope before enable.

## Required Wave 1 tests

- fresh v7, v6→v7, failed migration, verified pre-v7 backup, future schema, canonical schema equality;
- all scalar/aggregate bounds and malformed normal-open/restore rows fail closed without truncation;
- profile-global package-generation allocation across uninstall/reinstall/pruning/retry/concurrency and stale actions after receipt expiry;
- grant exactness and package/requested-permission invalidation; grant/revoke epoch only;
- settings type/update/package incompatibility; KV key/value/aggregate/atomic patch;
- graph missing/incompatible/cycle/depth/fanout/order, enabled disable blocking, any-dependent uninstall blocking, compatible atomic lock rewrite, and incompatible update closure;
- invocation exact replay, changed conflict, HTTP dispatch ambiguity/stable delivery, in-flight row/material ceilings/suspension/pruning/backup viability, and AppService child receipt crash window;
- cursor normal catch-up, concurrent snapshot mutation, resync snapshot/revision/CAS handoff, repeated retention loss, domain-effect crash replay, KV atomic cursor, HTTP-only retry, and restore epoch/resync;
- global event count exactly one for operator mutations and zero for cursor/KV/internal invocation/failure-counter updates;
- restore disables/reverify-required and constructs no plugin host;
- private staged publish/orphan cleanup/missing/corrupt package and Windows rename behavior.

## Database review gate

Wave 1 cannot close until one database specialist confirms migration atomicity, integrity, authority normalization, concurrent generation allocation, receipt/cursor crash windows, restore sanitization, file/row ordering, retention, and rollback evidence. Every material finding receives a stable `P7-DB-*` ledger row and focused regression.
