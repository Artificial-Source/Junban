# Phase 7 Wave 2 Retention-Loss Correction

**Status:** focused planning recheck **APPROVED**; implementation pending  
**Applies to:** Slice 2D composition and `P7-2D-DB-002`  
**Baseline:** `b6f943a` (`feat: add typed plugin callback and resync adapters`)

The initial focused planning review assigned `P7-RLC-001`–`003`. The corrected authority below passed focused recheck; all three findings are fixed and closed for implementation planning only.

## Why this correction exists

The approved Slice 2D adapters provide authority-bearing terminal and verified-skip paths for an exact retained event. Composition mapping found one remaining responsibility that neither path can express: when the next required retained revision has already been pruned, the active generation must atomically close admission, enter a fresh resync, and fence in-flight work.

Today only the legacy unwrapped `advance_plugin_cursor` path can perform that transition. Deleting it without a narrow replacement would either lose retention-gap recovery or tempt the supervisor to manufacture an event delivery for an event that no longer exists. The replacement is therefore a dedicated retention-loss transition, not another general cursor-advance API.

## Frozen correction

Add one nonserializable application request, named `MarkPluginRetentionLossRequest`, with only:

- `operation_id: OperationId`
- `authority: PluginCursorRetentionLossAuthority`
  - `plugin_id`
  - `package_generation`
  - `activation_epoch`
  - `host_session_id`
  - `mode`, restricted to `Active` or `StartingCatchUp`
- `expected_cursor: PluginCursorPosition`

The request carries no next cursor, source revision, caller-supplied head, earliest-retained revision, event classification, effect, or arbitrary runtime state. SQLite remains authoritative for whether loss exists. Before calling AppService, trusted server composition must exact-match `host_session_id` against the actor's current session while that actor owns serialized session/admission authority.

Expose one repository/service operation, `mark_plugin_retention_loss`, and one storage implementation. Define a domain-separated canonical request digest over `operation_id`, every authority field (including mode and host session), and `expected_cursor`. Its receipt-safe canonical request stores the non-secret fields, a digest of `host_session_id`, and the complete request digest, but never the raw host-session UUID. The canonical response stores the returned cursor and exact post-transition generation/epoch/runtime identity. Use the existing `operation_receipts` table; add no schema or general receipt framework.

The transition must, in one immediate transaction:

1. inspect any existing receipt for `operation_id`; exact canonical request/digest replay may return only if the stored response is canonical and the exact plugin/cursor post-state still holds, while a changed request or another operation shape returns idempotency mismatch;
2. for a new operation, load the exact plugin and cursor and require desired-enabled, matching generation and activation authority, the exact non-resync `expected_cursor`, and exactly `(Active, runtime_state = Active)` or `(StartingCatchUp, runtime_state = Starting)`;
3. read the current app event epoch/head and earliest retained revision itself;
4. prove that the next required revision (`expected_cursor.revision + 1`) is not retained while the cursor is behind the current head; otherwise return conflict without mutation;
5. set `resync_required = true` without advancing revision;
6. increment the activation epoch and keep the plugin desired-enabled in `Starting`;
7. using exact `(plugin_id, package_generation, old_activation_epoch)` predicates, convert every `DispatchingHttp` row to `AmbiguousHttp` with `http_ambiguous`, carry both newly converted and already-`AmbiguousHttp` rows to the new epoch without changing delivery identity, and delete only `Reserved`/`EffectCommitting` rows at the old epoch; touch no sibling or other generation;
8. clear retry/failure state exactly as the existing retention-loss transition does;
9. insert the canonical operation receipt and response; and
10. commit before returning the new cursor.

`StartingCatchUp` loss restarts from a fresh resync under a new epoch; it never activates a plugin over a gap. The method must not disable the plugin, rerun ambiguous HTTP, or emit a product event/global revision for this internal recovery transition. Receipt validation participates in normal open, backup preflight, restore preflight, and corruption rejection.

## Replay and stale-authority rules

An exact immediate retry after a successful transition may return the already-marked cursor only when all of these are true:

- `operation_id` resolves to the retention-loss receipt shape;
- the recomputed complete request digest and every receipt-safe request field match exactly;
- the stored cursor matches `expected_cursor` except for `resync_required = true`;
- the plugin is desired-enabled and `Starting`;
- generation is unchanged;
- the stored activation epoch is exactly the request epoch plus one; and
- the canonical stored response matches that exact post-state.

A changed host session, mode, cursor, or any other request field under the same operation ID is an idempotency mismatch. Any other already-resyncing state, event-epoch mismatch, stale generation/epoch, cursor movement, missing actual retention gap, disabled plugin, wrong mode/runtime pair, or changed post-state conflicts. Overflow conflicts fail closed.

`host_session_id` remains runtime-local fence material. Its raw value must never enter the receipt, event stream, diagnostics, or a general credential store; only its domain-framed digest appears in the canonical receipt request. Like the reviewed cursor-skip authority, the request is constructible only inside trusted server composition.

## Integration sequence

1. Add domain validation and focused application tests for mode, zero generation/epoch, resync cursor rejection, canonical request-digest framing, and replay-shape validation.
2. Add repository/service/storage plumbing and migrate the existing ordinary retention-loss regression to the authority-bearing request and operation receipt.
3. Add storage regressions for Active loss, StartingCatchUp loss, exact replay, changed-session/mode/cursor mismatch, operation-ID collision, stale generation/epoch/cursor, no real gap, event-epoch mismatch, pre-existing plus newly dispatching HTTP ambiguity carry-forward, scoped deletion of non-HTTP in-flight work, receipt corruption, normal reopen, backup, and restore preflight.
4. Compose the retained-event worker so an observed catch-up gap calls only this operation and refreshes the supervisor's fatal-fence snapshot from the committed durable selected graph, including the affected plugin's new epoch, before closing the host session. Graceful drain may relaunch directly; any timeout, EOF, exit, or protocol failure during drain must use the existing one-envelope whole-graph fence against that refreshed snapshot. The single-plugin retention transition never substitutes for fencing siblings.
5. Add a graceful session-rotation stale-request regression and an injected post-commit teardown-failure regression proving exactly one successful whole-graph fence and subsequent recovery.
6. Remove `advance_plugin_cursor` across app, storage, service, and tests together with the other Slice 2D unwrapped persistence APIs.

No schema migration, public HTTP/OpenAPI route, CLI/MCP surface, configurable policy, or generalized cursor mutation is added.

## Acceptance gate

Before composition continues:

- focused planning recheck closes `P7-RLC-001`–`003` and approves this correction;
- `cargo test -p junban-app plugin` and the focused storage retention-loss/receipt tests pass;
- normal-open, backup/restore preflight, graceful-session-rotation, and post-commit teardown-failure regressions pass;
- `rg` proves the old unwrapped cursor operation is absent after Slice 2D removal; and
- the real runtime-to-SQLite composition suite proves retained-tail loss restarts resync without guest rerun or HTTP resend.
