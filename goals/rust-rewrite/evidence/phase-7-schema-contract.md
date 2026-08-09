# Phase 7 schema-v7 contract

Date: 2026-08-04
Status: frozen schema-v7 authority; accepted Wave 1 persistence remains intact. Narrow Slice 2D planning recheck at exact `073f00d98dac4b9110ec028da01d0fb71eaa3ae3` approved/closed `P7-PLAN-2D-001`–`004`. Delivery persistence recheck at exact `d641d69ac89436eb39624ca3eeca7dd6b90d795d` closed `P7-2D-DB-001`/`003` and accepted the persistence portion of `P7-2D-DB-002`, but that finding remains an open **REMOVAL BLOCKER** until server migration and deletion of every legacy unwrapped API. High schema-neutral `P7-PLAN-2D-005` is fixed in plan with focused recheck pending; query/callback coding alone waits on it while resync and supervisor fixes remain independent. No schema SQL, row, table, version, or migration change is authorized, and no Slice 2D/Wave 2 acceptance is claimed.
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
| `scope_hash`                      | exact domain-separated, length-framed hash from the JBP1 contract; part of primary key                      |
| `permission_hash`                 | exact domain-separated, length-framed requested-set hash from `plugins`                                     |
| `granted_at`                      | canonical timestamp                                                                                         |

The hash preimages and one shared SDK implementation are frozen in [`phase-7-package-contract.md`](phase-7-package-contract.md). A grant is usable only when plugin id, package generation, permission hash, signer, package digest, and requested manifest entry exact-match. Grant/revoke drains current activation epoch and advances it; it does not change package generation. Unknown/extraneous grants make normal open/restore fail closed rather than being ignored.

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

Cursor advance is plugin-local bookkeeping, not a global event. Every delivered retained event reserves the exact retained event content hash, revision, and expected source cursor. Where its delivery mode permits a domain effect, KV patch, or HTTP terminal result, that accepted result and exact cursor advance terminalize in one SQLite transaction; crash cannot expose one without the other. A cursor outside retained history becomes suspended/resync-required.

The exhaustive direct converter admits only Task create/update/complete/uncomplete/cancel/reopen/delete and create/update/delete for Project, Tag, and Section. Every nondelete requires exact agreement between retained event type, typed primary, typed snapshot resource, and identical ID; delete requires its exact typed primary and no snapshot. Task uses the retained snapshot; Project/Tag/Section WIT revision is the enclosing event revision. Malformed direct events fail closed. No live read or affected-ID synthesis repairs event authority.

During resync-tail verification and `StartingCatchUp`, baseline-relevant affected IDs are exactly `AffectedIds.task_ids`, `project_ids`, and `tag_ids`. `Represented` requires a subscribed direct event whose retained snapshot/delete subject completely covers them: Task has exactly its primary task and no project/tag IDs; Project has exactly its primary project and no task/tag IDs; Tag has exactly its primary tag and no task/project IDs; Section has none. `Irrelevant` requires no baseline-relevant IDs and an otherwise valid non-invalidating cursor-only envelope. Every other event is `Invalidating`, including task moved/reordered/bulk/restored, cascade/multi-ID direct complete/delete, Project/Tag/Section deletion cascades, unsubscribed Task/Project/Tag direct mutations, undo/import, and future baseline-ID events.

An `Invalidating` event in final tail verification aborts finalization, discards transcript/staging, and restarts from a fresh sampled head; it is never cursor-skipped. After finalization at `R`, `StartingCatchUp` delivers `Represented`, skips only `Irrelevant`, and restarts resync on `Invalidating`; malformed direct also fails closed. Active ordinary delivery retains subscribed direct dispatch and its existing bounded cursor-only verifier. These stricter starting rules cover rows omitted by Task `revision <= R` and the Project/Tag anti-join.

Resync closes that plugin's event admission and atomically samples global event epoch `E` plus head revision `R`; it does not hold a SQLite read transaction while guest code runs. A fresh runtime-local session is bound to the exact nonserialized `PluginDeliveryAuthority` and one bounded nonpersisted `PluginResyncTranscript`. The transcript starts exactly at `SHA-256("junban.plugin.resync-transcript.v1\0" || raw delivery-authority digest || raw existing plugin_resync_request_hash(session))`. Every private request/outcome passes canonical decode→re-encode equality and folds exactly as `SHA-256("junban.plugin.resync-transcript-step.v1\0" || prior digest || u32be(global step index) || one-byte snapshot=0/flush=1/finalize=2 tag || u32be(request length) || exact request bytes || u32be(outcome length) || exact outcome bytes)`. Only compact per-kind counts/bytes/last IDs/digests plus global page index, flush/finalize, and candidate count/bytes/digest state remain in memory.

Snapshot pages are mandatory in exact Task→Project→Tag order with at least one page per kind, exact kind/`after_id`, and a terminal marker only on an exhausted Tag page. Task selection uses its real `id > last_id AND revision <= R` predicate. Project and Tag keep the existing retained-`> R` event anti-join; they do not gain a false `row_revision` premise. Each acknowledged page may add a noncommitted bounded KV segment. After snapshot exhaustion, flush requests use contiguous indices `0` through at most `9`: each response before the terminal one is `more` with a nonempty segment, exactly one response is `complete` (possibly at index `0`), and no response follows completion. Exactly one finalize chooses leave or replace.

Every resync segment accepts canonical SET operations only; a delete from the unchanged shared WIT patch shape is rejected. Keys are canonical and globally sorted/unique across all segments. The replacement candidate starts empty, omission deletes old keys, and its exact sorted resulting-set digest is `SHA-256("junban.plugin.resync-kv.v1\0" || u32be(entry-count) || sorted canonical entries)`, each entry encoded as `u32be(key-length) || key UTF-8 || u32be(value-length) || value bytes`. Leave discards the candidate and preserves old KV; replace commits exactly it, including zero-entry replacement that empties KV.

One final transaction revalidates transcript/session/delivery authority, matching invocation final request hash/state, candidate digest and bounds, package generation/activation epoch/current host session, classified contiguous retained tail after `R`, and the expected cursor. It applies the final KV choice, CASes the cursor to `(E,R,false)`, and deletes the invocation row atomically. Crash before commit loses runtime transcript/candidate and restarts fresh; crash after commit is recognized by the cursor. Catch-up then follows the exact `Represented`/`Irrelevant`/`Invalidating` rule above, reaches head, and only afterward permits same-epoch activation. No transcript row or schema migration exists. Resync denies HTTP, domain effects, and dependency service calls.

Restore cutover rotates the global event epoch, sets every cursor to that new epoch/current restored revision with `resync_required = 1`, and never replays pre-restore hooks. Explicit enable follows the same snapshot/revision/CAS/catch-up handoff.

### Ordinary plugin queries are schema-neutral

[`phase-7-capability-matrix.md`](phase-7-capability-matrix.md) freezes high `P7-PLAN-2D-005` without adding durable plugin-query state. A new internal AppService/repository path performs each ordinary task/project/tag page in one SQLite read transaction with canonical resource-ID ascending keyset predicates. The first page samples existing global revision and existing event epoch; a continuation authenticates and rechecks both in the same page transaction before reading. No transaction survives across a page or guest call.

The cursor stores no SQLite row. Its fixed binary v1 bytes bind kind, five-minute issue/expiry, sampled revision/event epoch, normalized-query hash, and last canonical resource UUID under a domain-separated profile-private HMAC. The HMAC reuses the existing strict private `ai-secrets.json` verification key through dedicated-worker operations; the file remains outside SQLite, events, receipts, and complete backups. Lazy key creation on first plugin query is a private-file operation only and does not initialize AI/provider runtime. Missing/malformed/private-file failures fail closed as scrubbed unavailable.

Storage greedily forms canonical-ID pages under a 256-KiB ceiling measured over the complete canonical successful SDK reply, including page revision and authenticated next cursor. It never truncates rows. Task replies carry persisted task row revisions. Project and Tag tables do not gain row-revision columns; each item and page present the first-page sampled global revision under the existing WIT field. Ordinary cursors do not replace `plugin_event_cursors`, resync sessions, general task cursors, or retained-event authority.

This authority adds no table, column, index, trigger, schema SQL, schema version, migration, backup content, receipt, event, public DTO/OpenAPI route, WIT/generated body, package hash, or dependency declaration. It awaits focused planning recheck and authorizes no implementation acceptance.

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

This is an **in-flight/ambiguous recovery table**, not a second unbounded terminal receipt history. Reservation is durable before guest execution. One runtime-local nonserialized `PluginDeliveryAuthority` retains its existing exact canonical digest over plugin ID, package generation, activation epoch, current host session, invocation ID, hook payload digest, and `StartingResync | StartingCatchUp | Active` mode. Command/action payload is the SHA-256 of exact canonical validated private invocation-body bytes; retained event is `SHA-256("junban.plugin.retained-event-payload.v1\0" || raw committed-event content hash || u32be(body length) || exact canonical private body)`; resync is the raw existing `plugin_resync_request_hash(session)`. A received body must decode and canonically re-encode to identical bytes before hashing.

The persisted `request_hash` is exactly `SHA-256("junban.plugin.invocation-request.v2\0" || one-byte hook tag command=0/event=1/action=2/resync=3 || u64be(persisted-entry-ID byte length) || canonical UTF-8 persisted entry ID || raw delivery-authority digest)`. The same authority/final hash must match reservation, transition, terminalization, verified cursor-only skip, and resync finalization. No authority field or second hash is added to this table.

`StartingResync` is resync-only. `StartingCatchUp` is retained-`HandleEvent`-only and cannot authorize commands, actions, HTTP, domain/KV effects, or an arbitrary cursor; successful exact-source advancement must reach head before same-epoch activation. On every process/session loss, all non-HTTP `reserved` and `effect_committing` rows are abandoned regardless of Starting or Active mode. Only `dispatching_http` transitions to `ambiguous_http`; existing ambiguity remains. A fresh process gets a fresh session/authority/request hash, and no dead Active non-HTTP row survives.

An Active top-level command, subscribed event, or action has a consume-once HTTP permit. The row transitions durably to `dispatching_http` before send; a second logical callback is rejected without sending. A same-process ambiguous resend may use only the identical in-memory request and existing `delivery_id`, without guest re-execution. Process loss leaves `ambiguous_http` unresolved for the bounded retention horizon: restart never reconstructs the request, reruns the guest, redispatches it after a retry epoch, or guesses success. HTTP use forbids any returned SQLite effect.

On success/failure/cancellation, the required terminal transaction advances the exact source cursor and commits/replays the accepted domain effect, KV patch, or HTTP terminal result as applicable, then deletes this in-flight row. Read-only/render responses need no durable terminal row. Exact operator retries replay ordinary completed receipt authority; they do not recover an unresolved external dispatch. For an AppService outcome, the deterministic child operation receipt remains effect authority within that atomic terminal path.

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
- invocation exact replay/changed conflict; delivery-authority, all-hook payload, and final request-hash exact goldens plus one-field changes and canonical-body mismatch; reserve/transition/terminal/verified-skip/resync-finalize mismatch; starting-mode denial/head-before-active; process-loss Starting+Active non-HTTP abandonment, only dispatching HTTP→ambiguity, existing ambiguity retention, fresh authority and no dead Active survivor; fixed/closed HTTP zero/one callback, no-send, durable dispatch, identical same-memory resend and restart/no-rerun; row/material ceilings/suspension/pruning/backup viability;
- cursor normal catch-up and all sixteen direct converters; malformed type/primary/snapshot/ID/delete/revision failures; exact `Represented`/`Irrelevant`/`Invalidating` concurrent moved/reordered/bulk/restored, multi/cascade complete/delete, Project/Tag/Section delete, subscribed/unsubscribed create/update/delete, undo/import/future baseline-ID, irrelevant-event and restart-then-complete matrix; retained snapshots/revisions, no live synthesis, event hash/revision/cursor reserve, and domain/KV/HTTP terminal-cursor atomicity;
- resync initial and step transcript exact framing/tag/`u32be` index+length/request+outcome bytes and canonical mismatch; empty/multipage mandatory Task→Project→Tag, global indices/after IDs/Tag terminal, Task predicate, Project/Tag anti-join, compact counter tampering, flush `0`/`9` and every missing/duplicate/empty/post-complete/index-`10` failure, SET-only/delete rejection, global key order/uniqueness, exact resulting-map digest, leave/replace/omission/zero-replace, exactly-one finalize, epoch/tail/cursor/session/invocation mismatch, crash before/after final transaction, repeated retention loss, and restore epoch/resync;
- global event count exactly one for operator mutations and zero for cursor/KV/internal invocation/failure-counter updates;
- restore disables/reverify-required and constructs no plugin host;
- private staged publish/orphan cleanup/missing/corrupt package and Windows rename behavior.

## Database review gate

Wave 1 cannot close until one database specialist confirms migration atomicity, integrity, authority normalization, concurrent generation allocation, receipt/cursor crash windows, restore sanitization, file/row ordering, retention, and rollback evidence. Every material finding receives a stable `P7-DB-*` ledger row and focused regression.
