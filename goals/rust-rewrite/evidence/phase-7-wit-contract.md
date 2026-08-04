# Phase 7 WIT contract

Date: 2026-08-04
Status: Wave 0 pre-implementation authority; exact `.wit` source and generated Rust/TypeScript bindings land in Wave 1 and must compile before this gate closes
Package: `junban:plugin@0.1.0`
Parent authorities: [`phase-7-context-map.md`](phase-7-context-map.md), [`phase-7-package-contract.md`](phase-7-package-contract.md)

## Contract goal

One synchronous Component Model ABI supports Rust and TypeScript plugins without runtime Node, ambient authority, arbitrary JSON, guest UI code, or duplicated Junban business rules. Host imports are bounded reads or explicitly scoped external calls. Guest writes are typed requests returned only after successful execution; the parent validates and commits at most one SQLite effect.

WASI P3 async/streams/futures, Junban-owned WIT resources, free-form maps, recursive values, arbitrary byte-encoded mutations/UI/settings/errors, and compatibility with legacy plugins are excluded. The exact Rust runtime baseline necessarily uses the standard WASI I/O resource handles named later; those are closed/sink host plumbing, not guest-owned Junban authority.

## World composition and optional capabilities

WIT has no optional imports. The canonical package therefore separates the required export world from capability interfaces:

```wit
package junban:plugin@0.1.0;

world plugin {
  export guest;
}
```

`plugin` has no imports and requires the exact `guest` interface below. Each authored package targets its own local world, includes this required world, and imports only capabilities it requests:

```wit
package example:pomodoro@1.0.0;

world pomodoro {
  include junban:plugin/plugin@0.1.0;
  import junban:plugin/host-tasks@0.1.0;
  import junban:plugin/host-settings@0.1.0;
  import junban:plugin/host-storage@0.1.0;
  import junban:plugin/host-log@0.1.0;
}
```

The local package/world name is build metadata, not authority. JBP1 records the required Junban world/version and actual import fingerprint. Install requires actual imports to be a subset of requested permissions and the runtime-profile baseline. Enable links only actual granted Junban interfaces plus the exact baseline. Declarations and returned effects are checked separately by the package-contract capability matrix because they need not correspond to imports.

## Interface set

Exact package interface IDs:

- `types`: shared records/variants/enums;
- `host-tasks`, `host-projects`, `host-tags`: bounded read queries;
- `host-settings`: current typed settings reads;
- `host-storage`: isolated KV reads;
- `host-clock`: wall timestamp and monotonic milliseconds;
- `host-http`: one synchronous exact-origin request;
- `host-log`: structured bounded log;
- `host-services`: one declared dependency service call;
- `guest`: required lifecycle, command, event, UI, settings, resync and service exports.

Interfaces are split by permission so an ungranted interface is absent from the linker: in particular, settings and KV storage are separate imports and grants. No generic `host-call(name, bytes)` exists.

## Common scalar rules

WIT strings are revalidated by the host. IDs use their canonical package/domain regex and ≤64 bytes. Visible text is ≤8 KiB unless a smaller manifest/UI limit applies. Date and timestamp are canonical strings parsed by Junban; duration/count/revision values are bounded integers. Lists have explicit element and aggregate limits before allocation/iteration. UUID/operation values are canonical strings; guest-provided identifiers never bypass parent derivation/validation.

Closed data used by commands/actions/services:

```text
scalar-value = string | signed integer | boolean | date | timestamp |
               task id | project id | tag id | plugin id | option id
data-value   = scalar(scalar-value) |
               string-list | integer-list | boolean-list | date-list |
               timestamp-list | task-id-list | project-id-list | tag-id-list |
               plugin-id-list | option-id-list
named-value  = { name, value: data-value }
```

Lists are homogeneous, contain at most 100 elements, and share the caller's aggregate 64 KiB cap. UI form action values are scalars; command/service inputs may use these nonrecursive list variants. There is no nested object/list recursion and no bytes. Opaque bytes are justified only for plugin KV values and HTTP bodies under their independent limits.

## Read queries

`host-tasks` exposes `query-tasks(task-query) -> result<task-page, host-error>` with:

- optional exact task/project/section/parent IDs;
- ≤16 tag IDs;
- ≤3 statuses and ≤4 priorities;
- optional due-date half-open range and bounded text search;
- opaque host cursor ≤512 bytes and limit 1…100.

A task view contains the existing safe plugin subset: id, title, full valid description (up to the domain's 10,000 Unicode-character bound), status, priority, due date/time, estimated/actual minutes, project/section/parent IDs, up to the domain's 100 tag IDs, recurrence/someday indicators, created/updated timestamps and revision. It excludes receipts, operation identities, reminder leases, AI/provider data, credentials and unrelated settings. Valid domain fields are never silently truncated.

Project/tag queries use equivalent opaque cursor + 1…100 limit and return bounded id/name/color/icon/view/revision summaries. All three query kinds order by canonical ID ascending. A page stops before either 100 records or 256 KiB of canonical lifted WIT material and returns at least one individually valid record; `next-cursor` means more records, not truncated fields.

The first page samples global revision and binds it plus the canonical query hash and last ID into an authenticated opaque cursor ≤512 bytes. Each continuation exact-matches query and revision and fails `cursor-stale` if global revision changed; callers restart rather than receiving an inconsistent page. Modified, cross-query, cross-profile or expired cursors fail. Resync uses its separately defined fixed-head keyset protocol rather than these ordinary cursors.

Queries always run through `AppService`/repository snapshot authority and current read grant. Guest filters are not SQL or JSON.

## Guest exports

The exact required export names are:

```text
activate(context) -> result<unit, plugin-error>
deactivate(context) -> result<unit, plugin-error>
invoke-command(context, command-call) -> result<plugin-outcome, plugin-error>
handle-event(context, event-envelope) -> result<plugin-outcome, plugin-error>
render-surface(context, surface-request) -> result<surface, plugin-error>
handle-surface-action(context, surface-action) -> result<plugin-outcome, plugin-error>
validate-settings(context, setting-values) -> result<list<validation-issue>, plugin-error>
resync(context, resync-page) -> result<resync-page-outcome, plugin-error>
call-service(context, service-call) -> result<service-data, plugin-error>
```

Activation/deactivation/validation/render/service results cannot carry domain effects. Resync may return only staged bounded KV segments and a final replacement decision defined below; no segment is durable before the final cursor CAS. Context includes bounded invocation/contribution identity for diagnostics but is never authority; host-side generation/epoch/session and grants remain authoritative.

## One returned effect

```text
plugin-outcome = { effect: option<plugin-effect> }
plugin-effect  = domain-mutation | kv-patch
```

A domain mutation is a closed variant mapped to existing AppService operations:

- `create-task`: exact `TaskDraft` fields title, description, priority, due date/time, deadline, someday, estimated/actual minutes, dread, project/section/parent IDs, tag IDs, sort order, recurrence rule, reminder timestamp and recurrence anchor; WIT defaults equal `TaskDraft::new` defaults;
- `patch-task`: task ID plus every exact `TaskPatch` field above; required/non-null fields use `unchanged | set`, nullable fields use `unchanged | clear | set`, booleans/sort use `unchanged | set`, and tags use `unchanged | replace`;
- `complete-task`, `uncomplete-task`, `cancel-task`, `reopen-task`, `delete-task`: exact task ID;
- `bulk-tasks`: 1…500 unique task IDs plus the existing closed `BulkAction` variants complete, uncomplete, cancel, reopen, delete, move, tag, schedule and priority. Move mirrors project/section/parent `unchanged | clear | set` and fixes `OrderAnchor::Keep`; tag mirrors bounded unique add/remove sets; schedule mirrors due date/time/deadline `unchanged | clear | set` and someday `unchanged | set`;
- `create-project`: exact `ProjectDraft` fields name, color, icon, parent ID, favorite, archived, view and sort order with existing defaults;
- `patch-project`: project ID plus exact `ProjectPatch` fields; icon/parent use `unchanged | clear | set`, all others `unchanged | set`;
- `delete-project`: exact project ID;
- `create-tag`: exact `TagDraft` name and color;
- `patch-tag`: tag ID plus exact `TagPatch` name/color `unchanged | set` fields;
- `delete-tag`: exact tag ID.

Generated bindings expose named records/variants, never positional option nesting. Every value is reconstructed through the named domain/AppService type and existing validation; no independent mutation semantics or defaults exist in the plugin layer. The guest does not choose the authoritative operation ID, revision, generated entity ID, event summary or receipt bytes. The parent deterministically derives one operation identity under `junban.plugin.effect.v1` from exact generation/invocation-or-event/action identity plus canonical typed effect, persists/binds it to the invocation, and applies or exact-replays the normal transaction/event/receipt path. Same identity with changed effect conflicts.

A KV patch contains 1…64 sorted unique set/delete operations and ≤64 KiB aggregate new value bytes; profile totals remain 2 MiB/plugin. It is committed with the event cursor/invocation terminalization in one plugin-local transaction and emits no global event.

If the invocation called `host-http`, every returned domain/KV effect is rejected. Trap, timeout, cancellation, malformed/oversized output or guest error commits neither effect.

## Invocation modes and HTTP import

The parent stores one closed invocation mode and checks it before every host import and after guest return:

| Guest export                                      | Allowed imports                                                                                  | Allowed return                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| activate/deactivate                               | granted settings/storage reads, clock, log                                                       | no effect                                                                                          |
| invoke-command/handle-event/handle-surface-action | granted domain/settings/storage reads, clock, log, dependency service and HTTP                   | at most one domain/KV effect, but none after any HTTP call                                         |
| render-surface                                    | granted domain/settings/storage reads, clock, log and dependency service                         | declarative surface only; no HTTP/effect                                                           |
| validate-settings                                 | clock and log only                                                                               | validation issues only                                                                             |
| resync                                            | settings, clock and log; with storage grant, isolated KV list/read; host supplies snapshot pages | no HTTP/domain/service; staged KV segments plus final replacement decision only with storage grant |
| call-service                                      | granted domain/settings/storage reads, clock, log and nested dependency service                  | flat service data only; no HTTP/effect/UI                                                          |

Nested service depth/cycle checks apply to every dependency call. A mode cannot gain an import because the package has that grant in another mode.

`host-http.request(http-request) -> result<http-response, http-error>` is synchronous to the guest. Request has method enum, canonical HTTPS origin + path/query, ≤32 allowlisted headers and ≤1 MiB body. Response has status, ≤32 allowlisted headers, ≤1 MiB body and truncated flag; non-2xx is a normal response. Host inserts the stable delivery ID and applies the exact DNS pinning/no-proxy/no-redirect/private-address/header policy in the package contract.

`http-error` has closed code `invalid-request | invalid-response | permission-denied | dns-denied | tls-failed | connect-failed | timeout | delivery-ambiguous | unavailable`, delivery state `not-sent | may-have-been-sent | response-received`, retryable boolean and ≤512-byte scrubbed message. Request over-limit is `invalid-request` before send. The client reads at most the first 1 MiB of a response body; if another byte exists it closes that response stream and returns the successful bounded response with `truncated = true` and delivery state `response-received`—body size never alternatively becomes an error. Invalid/over-limit response metadata is `invalid-response` + `response-received`. Any post-dispatch uncertainty before a valid response is `delivery-ambiguous` + `may-have-been-sent`; neither guest nor host reports it as definitely unsent. HTTP body bytes are justified because content protocols are external; they cannot be interpreted as a Junban mutation, setting, service, error or UI payload. External delivery is honestly at-least-once.

## Settings, KV, clock, log and services

- `get-settings()`: exact manifest-declared typed values only; ≤64 settings/64 KiB.
- `get-kv(keys)`: ≤64 unique keys and ≤64 KiB returned aggregate.
- `list-kv(cursor, limit)`: all isolated keys in bytewise key order, limit 1…64 and ≤256 KiB page. The opaque cursor is invocation/session-bound; one-plugin-at-a-time execution makes the plugin-local snapshot stable. No prefix/range scan exists in v1.
- `wall-now()`: canonical UTC timestamp; `monotonic-ms()`: invocation-relative monotonic value. No guest timer/scheduler.
- `log(level, message, fields)`: closed level enum, ≤4 KiB message, ≤16 flat scalar fields; parent redacts/truncates/rate-limits before diagnostics.
- `call-service(plugin-id, service-id, values)`: exact manifest dependency lock + `services:consume` grant, ≤64 KiB flat typed data, depth ≤8/cycle detection. Callee mode denies HTTP/effects/UI and requires `services:provide`.

Settings are operator-owned; there is no guest setting write. KV bytes are isolated by plugin id and never rendered/interpreted by the host.

## Events and resync

Event envelopes carry event epoch/revision, closed resource event kind, and one typed task/project/tag subject summary or deleted resource reference. They contain no receipt request/response or arbitrary event JSON. The guest may query current state.

Resync is a frozen paged protocol, never a truncated snapshot accepted as complete. `resync-page` is the closed request variant `snapshot | flush-staged-kv | finalize`; `resync-page-outcome` has corresponding acknowledgement/segment, continuation, and final-choice variants, so generated bindings make sequence errors explicit.

1. Parent closes that plugin's event admission and atomically samples event epoch `E` and head revision `R`.
2. It starts a fresh runtime-local resync session and sends `snapshot` requests containing task, project and tag pages in canonical resource-kind then ID order. Each page is count/byte bounded like reads and carries session ID, `E`, `R`, resource kind, page index, full typed records, and host-owned `final-snapshot-page`.
3. Page queries use keyset `id > last-id` plus `row_revision <= R`. Rows changed after `R` disappear from the baseline but their retained `> R` full-summary event supplies current state; rows deleted after `R` need only their deletion event. No offset cursor or long-lived SQLite transaction is used.
4. Each `snapshot` outcome acknowledges the exact page and may add one sorted unique KV segment whose complete lifted outcome is ≤256 KiB; the parent buffers but does not commit it. Duplicate keys across segments fail. Aggregate staging remains ≤256 keys/2 MiB. With `storage`, the guest may first list/read all old isolated KV so operational keys can be preserved alongside rebuilt derived keys.
5. After the exhaustive snapshot, the parent drives up to nine ordered `flush-staged-kv` requests in the same export/session. Each response may add another ≤256-KiB segment and declares `more` or `complete`; `more` with an empty segment, a tenth request, duplicate key or aggregate overflow fails. This allows the full 2-MiB authority even for an empty profile while every response stays bounded.
6. After `complete`, one host-driven `finalize` request returns only `leave-kv` or `replace-kv-with-staged-segments`. Only segments/replacement require `storage`; zero segments plus replace means intentional empty replacement. No snapshot/flush/finalize outcome can partially commit.
7. One parent transaction verifies the cursor still has its expected resync identity, epoch still equals `E`, every snapshot/flush/finalize request was acknowledged in order, and the required `> R` event tail remains retained; it atomically performs the chosen KV action and CASes the cursor to `(E,R,false)`. No global event is emitted.
8. Catch-up applies only retained events `> R` before admission reopens. Any epoch change, lost tail, request mismatch, guest restart/trap or CAS race abandons guest state/staged KV and restarts at a new head; repeated inability suspends rather than skipping.

This permits up to the full 2 MiB isolated state to be preserved/rebuilt through 256 KiB outputs without committing an incomplete page and without holding a repository transaction while guest code runs. Resync denies HTTP, domain effects and dependency services.

## Declarative UI

WIT types cannot be recursive. `surface` is therefore one flat preorder node array, not a tree:

```text
surface = { surface-id, root-index: u16, nodes: list<ui-node> }
ui-node = { id, parent-index: option<u16>, content: ui-content }
```

Root index is zero with no parent. Every later node has a unique ID and parent index lower than itself, allowing one-pass acyclic validation; ≤256 nodes, depth ≤8, serialized material ≤32 KiB.

Closed `ui-content` variants:

- stack, row;
- heading, text, badge, metric, progress;
- button, text-input, number-input, select, toggle;
- task-list, task-ref;
- divider, empty-state, error-state.

Props are closed typed records with host tone/size/alignment/icon enums, plain escaped text, bounded numeric ranges and manifest-declared action IDs. There is no HTML, Markdown, SVG/image/data URL, CSS/style/class, route, script, component name, React object, recursive child payload or arbitrary props map.

Surface actions contain exact surface/action identity and ≤32 flat named scalar values. Browser requests also carry package generation + activation epoch + host session; parent rechecks them before guest call and before any effect.

## Errors

`host-error` and `plugin-error` use closed codes (`invalid-input`, `not-found`, `conflict`, `cursor-stale`, `permission-denied`, `unavailable`, `rate-limited`, `cancelled`, `internal`) plus optional bounded field and ≤512-byte scrubbed message. Raw Wasmtime/provider/HTTP/SQLite/package/token/path errors do not cross the API. Guest error strings are untrusted diagnostics and never become an authorization decision.

## Runtime profiles

Wave 0 actual import inspection freezes:

- `typescript`: componentize-js 0.22.0 with `random`, `stdio`, `clocks`, `http`, and `fetch-event` disabled; **zero WASI imports**. Clock/log/HTTP/random-like identifiers come only from Junban interfaces/host-owned identity.
- `rust`: Rust 1.93.0 `wasm32-wasip2` reference imports exactly `wasi:io/error@0.2.6`, `wasi:io/streams@0.2.6`, `wasi:cli/environment@0.2.6`, `wasi:cli/exit@0.2.6`, and `wasi:cli/stderr@0.2.6`. Host returns empty environment/arguments/cwd, provides closed/bounded sink streams, and maps exit to controlled guest termination. Nothing is inherited.

WASI filesystem/preopens/sockets/network/HTTP/random/clocks/stdin/stdout/process spawning and every unknown import are absent. The Wave 0 full P2 linker is measurement scaffolding, not production selective-linker proof.

## Versioning

Import lint requires exact `@0.1.0` Junban interface names even if Wasmtime can semver-match compatible interfaces. Additions ship only after a new exact package version and host implementation; breaking changes use `0.2.0`. Phase 7 ships one required version and no adapter/dual-world compatibility layer.

Package update changing component bytes, WIT version, imports, permissions, signer or manifest consumes a new package generation and requires approval. Dependency service semver is manifest/lock authority and cannot substitute another Junban WIT version.

## Validation gate

Wave 1 must check in actual `.wit` files plus generated Rust/TypeScript bindings and golden components. Required tests compile both profiles, enumerate exact imports/exports, round-trip every variant/record, reject all bounds and malformed graphs, prove TypeScript change/clear patch distinctions, and show import/declaration/effect grant omissions fail. One API-contract reviewer approves the compiled contract before Wave 2 runtime implementation closes.
