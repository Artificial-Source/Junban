# Phase 7 Wave 2 Transient Invocation Authority Correction

**Status:** focused API/planning recheck **APPROVED**; implementation pending  
**Applies to:** Slice 2D callback/runtime composition  
**Baseline:** `438cf57` with typed callback adapters at `b6f943a`

The focused API-contract review assigned `P7-PLAN-2D-006` and `P7-PLAN-2D-006-ACTOR`. Focused recheck approved this correction and fixed/closed both findings for implementation planning only, without changing durable delivery, SQLite, WIT, or public contracts.

## Problem

Schema-v7 durable plugin invocation authority deliberately covers only command, retained event, surface action, and resync recovery. The other valid SDK exports—Activate, Deactivate, RenderSurface, ValidateSettings, and nested CallService—currently can reach callback validation only by relabeling an unrelated durable delivery. That does not bind their exact mode, request, entry policy, or target identity and prevents valid transient calls for a plugin with no suitable durable row.

Adding durable hook kinds would be incorrect: these calls have no replayable effect/HTTP authority and must leave no recovery row. The callback seam also discards the exact child frame/body and keeps a second callback counter outside the adapter, so a global decoded-request dispatcher cannot reconstruct safe transient or nested-service authority.

## Frozen authority split

Keep `PluginDeliveryAuthority`, `PluginInvocationDelivery`, delivery hashes, `PluginHookKind`, `plugin_invocations`, receipts, and schema v7 unchanged. In the server only, replace the callback authority's unconditional durable delivery with a private nonserializable sum type:

```rust
enum PluginInvocationAuthority {
    Durable {
        delivery: PluginInvocationDelivery,
        entry: PluginManifestEntry,
    },
    Transient(PluginTransientInvocationAuthority),
}

struct PluginTransientInvocationAuthority {
    plugin: InstalledPlugin,
    host_session_id: OperationId,
    invocation_id: OperationId,
    call: PluginTransientCall,
    grants: Vec<Permission>,
    permission_set_sha256: Sha256Digest,
    request_sha256: Sha256Digest,
    canonical_request_body: Box<[u8]>,
    ancestors: Vec<PluginId>,
}

enum PluginTransientCall {
    Activate,
    Deactivate,
    RenderSurface { surface_id: PluginId },
    ValidateSettings,
    CallService {
        service_id: PluginId,
        parent_callback: CallbackFence,
    },
}
```

These types have private fields and no `Serialize` implementation. `PluginTransientCall` alone derives the exact SDK invocation kind, mode, and entry rule; callers cannot supply conflicting kind/mode fields. `permission_set_sha256` must equal the canonical hash of the exact grants. `request_sha256` is SHA-256 of the exact SDK-canonical private request body. The exact parent `Invoke` frame must bind that body hash/length plus plugin, generation, activation epoch, host session, invocation ID, and derived invocation kind. Service depth is derived from `ancestors.len()` and is never stored as a second caller-selected value.

The transient authority never creates a delivery ID, `plugin_invocations` row, operation receipt, cursor transition, effect commit, HTTP transition, or recovery work.

## Mode matrix

| SDK export          | Authority                                        | Durable row | Entry and admission                                                                            |
| ------------------- | ------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------- |
| Activate            | transient lifecycle                              | no          | `entry_id = None`; exact actor-owned Starting activation attempt                               |
| Deactivate          | transient lifecycle                              | no          | `entry_id = None`; actor-owned drain of the exact loaded generation/session                    |
| InvokeCommand       | existing durable Active delivery                 | yes         | exact persisted command entry                                                                  |
| HandleEvent         | existing durable Active/StartingCatchUp delivery | yes         | exact retained source and event entry                                                          |
| RenderSurface       | transient render                                 | no          | `entry_id = surface_id`; exact manifest surface and current UI grant                           |
| HandleSurfaceAction | existing durable Active delivery                 | yes         | exact persisted surface/action entry                                                           |
| ValidateSettings    | transient validation                             | no          | `entry_id = None`; exact manifest-valid candidate and current Settings grant                   |
| Resync              | existing durable StartingResync delivery         | yes         | exact resync session/transcript authority                                                      |
| CallService         | transient nested service                         | no          | never top-level; `entry_id = service_id`; exact validated parent callback and provider service |

Lifecycle failure may use the already-reviewed plugin health operations after actor classification; that does not make the guest call durable. Lifecycle, render, validation, and nested service may use only the host-call matrix already frozen for their exact SDK mode. HTTP, returned effects, cursor changes, and durable KV mutation must pattern-match durable authority and are unavailable to every transient mode. Read-only service mode cannot recursively gain HTTP/effect authority.

## Construction and validation ownership

The runtime actor is the only constructor and owner.

1. Consume the exact SDK-generated parent invoke frame and canonical private body for the currently loaded node; canonical decode/re-encode equality is mandatory.
2. Bind current plugin ID, package generation, activation epoch, host session, fresh invocation ID, manifest/state snapshot, canonical grants/hash, derived mode/kind, frame body hash/size, and exact entry policy before dispatch.
3. Construct `PluginInvocationCallbackState` inside the actor-owned invocation record. Its callback sequence starts at exactly 1, only the adapter advances it, and at most one callback is outstanding.
4. Pass exact child callback frame/body through the actor to `PluginCallbackAdapter::dispatch_message`; remove the decoded-only global dispatcher and duplicate callback counter/validation path.
5. Before work and after every await, recheck the same invocation record, loaded node, generation, epoch, session, phase, expected callback ID, manifest, and grants. A late result is discarded without reply or mutation.
6. Terminal, cancellation, timeout, unload, generation change, or session loss drops transient state and canonical request bytes. No transient replay is attempted after process loss.

Lifecycle and settings validation use owner-specific internal admission, not command/operator admission. Render uses current contribution admission. Nested CallService is admitted only from the adapter's validated service dispatch while the parent invocation remains suspended and actor-owned.

## Nested service authority

For CallService, the parent adapter must first prove caller `services:consume`, exact dependency lock/scope/schema, unique acyclic ancestry, and depth. The callee actor then proves target plugin ID/generation/epoch/session, exact service declaration, `services:provide`, service ID/body/schema, and the exact `parent_callback`. Ancestry is `[root, …, caller]`, contains callers only, excludes the callee, and is canonical unique. Root depth is 0; service edges 1 through 8 are allowed; edge 9 and any cycle reject before callee dispatch. The target callback plugin/invocation identity must match the transient callee authority rather than the caller's durable delivery.

A schema-validated service result returns only to the still-live exact parent record. Cancellation or authority drift in either record suppresses it. CallService leaves `list_plugin_invocations()` unchanged and cannot produce HTTP, effect, cursor, or durable KV work.

## Implementation sequence

1. Add the server-private authority sum type and exhaustive derived mode/kind/entry helpers in `plugin_callbacks.rs` or a narrow server-owned delivery module.
2. Make HTTP/effect/durable transition helpers require `Durable`; update static/live callback validation for exact transient fields and mode policy.
3. Refactor `plugin_runtime.rs` so one actor-owned invocation record retains exact parent frame/body and callback state; route raw child frame/body through the adapter and route only `ValidatedPluginServiceCall` into nested admission.
4. Delete the decoded-only `PluginCallbackDispatcher`, duplicate callback counter, relabelled durable-transient compatibility tests, and weaker parallel service validation path.
5. Add focused actor/adapter composition tests before resync/event coordinator work.

No app/storage file, durable delivery hash, schema/migration, WIT/generated body, dependency, OpenAPI/DTO, CLI/MCP, or public route changes are authorized.

## Focused acceptance

- exhaustive nine-export durable/transient mapping and cross-construction rejection;
- every transient export leaves `list_plugin_invocations()` unchanged;
- one-field tampering of plugin/generation/epoch/session/invocation/mode/grant/hash/body/hash/size/entry fails before app access;
- lifecycle/render/validation callback and outcome matrices prove no HTTP/effect/write/cursor path;
- callback IDs 1..n plus duplicate/skip/late/cancel and generation/session/grant drift during awaits;
- service calls from durable and render roots with exact parent callback, consumer/provider/schema checks, edge-8 success, edge-9/cycle rejection, no row/HTTP/effect, and stale post-await suppression;
- existing command/event/action/resync durable authority and replay regressions remain green.

Focused API/planning recheck closed `P7-PLAN-2D-006` and `P7-PLAN-2D-006-ACTOR`. Runtime callback composition may implement this authority, but remains unaccepted until its focused regressions and review pass.
