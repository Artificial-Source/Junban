# Phase 7 ordinary plugin-query capability contract

Date: 2026-08-09
Status: focused planning recheck **APPROVED** at exact `dbf63a58f38df245b0b62337b29c644b8054984c` — `P7-PLAN-2D-005` and `P7-PLAN-2D-005-UUID` are fixed/closed and authorize app/storage coding only
Parent authorities: [`phase-7-context-map.md`](phase-7-context-map.md), [`phase-7-wit-contract.md`](phase-7-wit-contract.md), [`phase-7-schema-contract.md`](phase-7-schema-contract.md)

## Finding and implementation gate

`P7-PLAN-2D-005` found that the frozen WIT described ordinary task/project/tag reads broadly but did not specify the internal AppService/SQLite query authority strongly enough to implement the server callback safely. The server-only callback implementation correctly stopped rather than inventing a cursor, snapshot, secret, or byte-limit contract. Query-authority review of exact `b4905b1d7afdd0ef8f95b6739eb8f5bebe34d1d1` then raised subsidiary high `P7-PLAN-2D-005-UUID`: the cursor plan incorrectly rejected non-RFC UUID variants even though existing Junban authority accepts every UUID that parses and canonical lowercase round-trips, and schema-v7 `TEXT` resource IDs and `event_epoch` impose no variant or version constraint.

This document freezes the smallest implementation authority that satisfies the existing WIT and corrects that UUID rule. The focused recheck at exact `dbf63a58f38df245b0b62337b29c644b8054984c` **APPROVED** it, closing `P7-PLAN-2D-005` and `P7-PLAN-2D-005-UUID` and authorizing app/storage coding. It preserves every UUID octet, nil/non-RFC/version-bit semantics, the fixed 122-byte envelope, MAC, and error mapping. It changes no WIT or generated body, JBP1/JRI1/package hash, schema SQL/version/migration, public DTO/OpenAPI route, or dependency package. This planning approval does not accept an implementation or callback composition, nor Slice 2D, Slice 2C, Wave 2, supervisor, or resync.

## Capability and ownership matrix

| Host call        | Required current grant | Internal entry point                         | SQLite authority                        | Filters                        | Result revision                    |
| ---------------- | ---------------------- | -------------------------------------------- | --------------------------------------- | ------------------------------ | ---------------------------------- |
| `query-tasks`    | `tasks:read`           | new ordinary plugin-task AppService query    | one read transaction for the whole page | exact frozen task filter below | each task's persisted row revision |
| `query-projects` | `projects:read`        | new ordinary plugin-project AppService query | one read transaction for the whole page | cursor and limit only          | first-page sampled global revision |
| `query-tags`     | `tags:read`            | new ordinary plugin-tag AppService query     | one read transaction for the whole page | cursor and limit only          | first-page sampled global revision |

The parent rechecks the exact generation/epoch/session/invocation/mode and current read grant before calling the AppService API and before publishing the reply. The AppService API is internal and ordinary-plugin-specific. It is not a public route, a public DTO, the existing general `TaskQuery`/`TaskCursor`, or resync's fixed-head query protocol. The repository owns the transaction and SQL; the server callback cannot query SQLite directly.

Every page is selected in canonical resource-ID ascending order with an exclusive `id > last_id` keyset. Offset pagination is forbidden. The first page has no cursor and starts before the first ID. A continuation supplies only the authenticated cursor described below.

## Exact ordinary query semantics

### Task query validation and normalization

The existing WIT fields have only these meanings:

- `task-id`, `project-id`, `section-id`, and `parent-id`, when present, are exact canonical IDs and apply as equality predicates;
- `tag-ids` has at most 16 input entries and means **all-of**: every returned task has every normalized tag ID;
- `statuses` has at most three input entries and matches any normalized status;
- `priorities` has at most four input entries and matches any normalized priority;
- `due-from` is inclusive and `due-before` is exclusive, producing the half-open civil-date interval `[due-from, due-before)`; when both are present, `due-from < due-before` is required;
- `search`, when present, is a nonempty literal of at most 10,000 Unicode scalar values matched against title or description. SQL `LIKE` metacharacters `%`, `_`, and the escape character `\` are escaped before the surrounding `%…%` search pattern is formed. Guest text is never SQL syntax;
- `limit` is required and must be `1..=100`;
- `cursor`, when absent, requests the first page; when present, it is the exact continuation authority below.

Input collection ceilings are enforced **before** normalization, so duplicates cannot bypass the 16/3/4 limits. After admission, tag IDs, statuses, and priorities are sorted by their canonical encodings and deduplicated. No other trimming, case folding, date widening, implicit view, unresolved name lookup, sort choice, or task filter exists. All predicates combine with logical AND, except statuses/priorities use membership within their own set and title/description are the two alternatives for one literal search.

### Catalog query validation

Project and tag queries accept exactly `cursor` plus `limit`. Their limits are also `1..=100`. They have no text, visibility, archive, color, name, or other hidden filter. The canonical kind and limit are still bound into the normalized-query hash.

## Snapshot and cursor authority

### Per-page transaction

Each page uses one SQLite read transaction on the dedicated profile worker. On a first page, that transaction samples the exact current global revision and global `event_epoch` before selecting rows. The sampled pair is returned as page authority and is bound into every continuation cursor.

A continuation is decoded and authenticated before its row query. In the same page transaction, storage requires both the current global revision and current event epoch to equal the sampled values in the cursor before selecting any row. A mismatch returns `cursor-stale`; no mixed page is returned. No read transaction is held across guest execution or across pages.

### Normalized-query hash

The normalized query hash is:

```text
SHA-256(
  ASCII "junban.plugin.ordinary-query.v1\0" ||
  one-byte query kind (task=0x01, project=0x02, tag=0x03) ||
  u32be(canonical normalized SDK host-call request byte length) ||
  canonical normalized SDK host-call request bytes
)
```

The canonical request is the existing SDK `HostCallRequest::QueryTasks`, `QueryProjects`, or `QueryTags` body after the validation and set normalization above, with `cursor = null`. It includes the requested limit and every normalized filter. Thus continuation cursor text is excluded, while kind, limit, and the complete semantic query are included. Existing SDK canonical serialization remains the only body encoding; no second query JSON contract is introduced.

### Fixed cursor-v1 binary envelope

The opaque cursor is strict unpadded base64url of exactly this 122-byte big-endian binary envelope:

```text
offset  size  field
0       1     version = 0x01
1       1     kind: task=0x01, project=0x02, tag=0x03
2       8     issued_at: unsigned Unix seconds
10      8     expires_at: unsigned Unix seconds
18      8     sampled global revision
26      16    sampled event_epoch exact UUID bytes
42      32    normalized-query SHA-256 bytes
74      16    last_id exact resource UUID bytes
90      32    HMAC-SHA256 tag over the first 90 bytes
```

Both 16-byte UUID fields use the exact UUID bytes for any value accepted by Junban's existing canonical parse/round-trip authority. Encoding parses the already-authorized canonical lowercase UUID text and copies, with no integer or field endianness swap, the 16 octets represented left-to-right after removing the hyphens (two hex digits per octet). Decoding constructs the UUID from those exact 16 octets and renders canonical lowercase text. Nil UUIDs, non-RFC UUID variants, and every version-bit pattern accepted by that existing authority are valid in both `sampled event_epoch` and `last_id`; the cursor codec adds no variant or version restriction. Schema-v7 `TEXT` resource IDs and `event_epoch` add none either.

Malformed or noncanonical external UUID text still fails at its existing request, persistence-open, or other owning authority boundary, before cursor creation. A malformed cursor envelope length still fails at the cursor boundary. The encoded cursor remains exactly 163 ASCII bytes and below the existing WIT 512-byte ceiling. Other decoded/encoded lengths, padded base64, noncanonical base64url, unknown version/kind, a sampled revision above SQLite's `i64::MAX`, time arithmetic overflow, `expires_at != issued_at + 300`, or trailing bytes are `invalid-input`.

The MAC is:

```text
HMAC-SHA256(
  profile verification key,
  ASCII "junban.plugin.ordinary-query-cursor.v1\0" || first 90 envelope bytes
)
```

Creation uses the current Unix second and sets `expires_at` to exactly 300 seconds later. The TTL is non-configurable. Continuation requires `issued_at <= now < expires_at`; an otherwise authentic cursor at or after expiry returns `cursor-stale`. The MAC, kind, normalized-query hash, event epoch, and current global revision are verified before reads. A valid MAC under another query kind or normalized query is still `invalid-input`; event-epoch or revision drift is `cursor-stale`.

Tampered, cross-kind, cross-query, cross-profile, malformed, oversized, and validly replaced-key cursors return the existing WIT `invalid-input` error without exposing which authentication check failed. Accepting all UUID variant/version bit patterns does not change that rule: changing any bit of either UUID field without recomputing the profile-private tag is tampering and fails MAC verification exactly as before. Expired cursors and authenticated current-state revision/event-epoch drift return `cursor-stale`. Cursor bytes, decoded keys, query hashes, MACs, and the profile verification key never enter logs, events, receipts, diagnostics, test failure values, or public errors.

## Profile-private MAC authority

The cursor reuses the existing random profile-private verification key in strict private `ai-secrets.json`. It does not create a plugin secret, a second key file, a SQLite row, or a backup artifact.

Storage adds purpose-specific profile-MAC create/verify methods around that existing key. AI receipt verification retains its existing distinct domain; ordinary plugin-query cursors use only `junban.plugin.ordinary-query-cursor.v1\0`. Callers cannot request an arbitrary domain. This prevents AI receipt/key material from being accepted as a plugin cursor or vice versa.

The first ordinary plugin query asks the dedicated SQLite worker to load the strict private document and durably create its verification key only when the file is absent. This operation is serialized with existing secret-file operations on that worker. It does not initialize `junban-ai`, provider clients, model discovery, speech, Wasmtime, or any plugin host beyond the already admitted callback. Ordinary startup and profiles that never query through a plugin remain free of the file/runtime artifact.

A missing document may be created lazily. A malformed document, missing/malformed key in an existing document, private-file permission/read/write/durability failure, random-source failure, or other private authority failure maps to scrubbed `unavailable` and fails closed. Replacing the valid key invalidates prior cursors as `invalid-input`. Raw key bytes remain outside SQLite, global events, operation receipts, complete backups, and test output.

## Exact page-size and continuation rule

The response ceiling is exactly 256 KiB measured over the canonical SDK private-body bytes of the complete successful reply variant:

- `HostCallReply::QueryTasks(Ok(page))`;
- `HostCallReply::QueryProjects(Ok(page))`; or
- `HostCallReply::QueryTags(Ok(page))`.

It is not measured over SQLite rows, domain structs, an item-list fragment, WIT lifting estimates, or a reply without its revision and `next_cursor`. The existing canonical SDK serializer performs the authoritative measurement.

Within one read transaction, storage fetches enough ID-ordered matching rows to determine whether another matching record exists after the included prefix. It greedily includes complete records in order while both the requested count and final canonical successful-reply byte ceiling hold. The final size check includes the authenticated `next_cursor` whenever another record exists. Fields and lists are never truncated, shortened, summarized, or dropped to fit.

`next_cursor` is present if and only if another matching record exists after the last returned record. It is never emitted merely because the requested limit was reached without proving another match. If the first individually valid record cannot fit in the complete successful reply, the callback returns scrubbed `internal`/`operation-too-large`; it does not return an empty page, truncate the record, or loop on the same cursor. Empty result pages have no cursor.

Task items carry their persisted task row revision. Schema v7 has no project/tag row-revision column, so every project/tag item and the enclosing page use the first-page sampled global revision as the existing WIT `revision`. This is an ordinary-query presentation rule only and adds no schema authority.

## Explicit non-changes

This planning correction adds no schema SQL, schema version, migration, table, row, WIT field, WIT SHA, generated private body, JBP1/JRI1/package hash, public DTO/OpenAPI route, automation tool, configuration key, secret artifact, dependency declaration, or dependency package.

The API is not the existing `TaskQuery` cursor and cannot replace resync's fixed-head pages. Resync retains its separately reviewed transcript/head/tail/KV authority. Public server routes, ordinary browser task listing, CLI/MCP, AI queries, and complete-backup content do not change.

## Focused implementation and review matrix

The focused reviewer approved this written authority at exact `dbf63a58f38df245b0b62337b29c644b8054984c`; later app/storage implementation must retain focused tests for:

- validation bounds, pre-normalization collection ceilings, sorted/deduplicated set normalization, and normalized-query hash goldens/one-field changes;
- exact task/project/section/parent ID predicates, all-of tags, status/priority membership, half-open due boundaries, and literal `%`, `_`, and `\` search escaping across title/description;
- canonical UUID ordering, zero/one/limit/count boundaries, 256-KiB exact edges, no field truncation, first-record operation-too-large, and exact complete-SDK-reply byte measurement;
- empty, one-page, and multi-page traversal for tasks, projects, and tags, including proof that `next_cursor` means another matching row exists;
- cursor encode/decode/re-encode round trips for nil and non-nil non-RFC-variant UUIDs in both `sampled event_epoch` and `last_id`, plus task/project/tag keyset traversal boundaries whose resource IDs are nil or non-RFC-variant UUIDs, with no variant/version rejection;
- mutation between continuation pages returning `cursor-stale` for global revision drift and event-epoch drift;
- tampered UUID-field bits, noncanonical/padded, cross-query, cross-kind, cross-profile, expired, oversized, malformed, and replaced-key cursors with unchanged MAC behavior and the exact `invalid-input` versus `cursor-stale` mapping;
- profile-MAC domain separation from AI receipt verification, lazy first-query creation through the dedicated worker, serialized secret-file operations, private-file failures as unavailable, and no cursor/key/secret leakage;
- one SQLite read transaction per page, same-transaction state check plus keyset selection, and snapshot consistency under a concurrent writer;
- project/tag sampled-global-revision presentation and task row revisions;
- ordinary default startup and a profile with no plugin query creating no `ai-secrets.json`, AI/provider runtime, Wasmtime engine, or plugin-host process.

This approval authorizes app/storage coding only. It does not accept an implementation, callback composition, resync, the supervisor, Slice 2C, Slice 2D, or Wave 2.
