# Phase 5 Cross-Surface Conformance Protocol

Date frozen: 2026-08-01

Protocol: `junban-phase5-conformance-v1`

Status: frozen before the authoritative run. The corpus uses only accepted Phase 1–4 behavior and the Phase 5 shared catalog. It does not use direct SQLite access or a Node runtime.

## Surfaces

Run the same ordered corpus against four fresh profiles:

1. direct authenticated HTTP requests to an optimized `junban-server`;
2. optimized `junban --json --server ... --credential-file ... tool call` processes attached to an active owner;
3. optimized `junban --json --data-dir ... tool call` processes using temporary local ownership;
4. one persistent optimized `junban-mcp` stdio session using `tools/call` against an active owner.

External surfaces use separate private `read,write,data` automation credentials. The local-owner CLI uses its instance-matched same-profile operator authority, but the corpus contains no operator-only operation. Setup and final observation may use the private operator credential; corpus calls may not.

Each profile begins at schema v5 with default typed settings, revision zero, no domain rows, no pending recovery/maintenance state, and no retained events. Every external owner uses the same server-local time zone. All corpus dates and instants are explicit, so no browser clock or current-date default is authoritative.

## Aliases and normalization

Generated UUIDv7 values and timestamps legitimately differ between fresh profiles. The driver assigns stable aliases from immutable semantic fields and creation order:

- project `project:automation` from name `Automation Project`;
- section `section:doing` from name and owning project;
- tag `tag:agent` from name `agent`;
- template `template:weekly-check` from name `Weekly check`;
- saved filter `filter:important` from name `Important`;
- tasks `task:root`, `task:dependency`, and `task:imported` from unique titles;
- one comment, relation, time slot, time block, reminder occurrence, receipt, operation, and event alias per corpus step and owner.

Normalize IDs, event epochs, request IDs, operation/receipt IDs, creation/update timestamps, parser-sampled authority dates, local output paths, backup hashes, and generated event timestamps to those aliases or typed placeholders. Preserve and compare semantic values, relationship direction, status, recurrence/reminder state, revision numbers, event kinds/summaries, affected-entity alias sets, error codes/status/retryability/details, artifact formats/inventory, and JSON schema shape. Normalization must reject an unknown generated identifier rather than deleting it.

## Ordered success corpus

Read-only parser calls do not advance revision. Each accepted mutation below must advance exactly one revision and emit exactly one event.

1. `get_profile`, `get_sync_state`, and `get_settings` on the empty profile.
2. `parse_quick_entry` with `Write report p2 45m due 2030-01-15 #agent`.
3. `parse_filter` with `priority:2 due_after:2030-01-01 due_before:2030-01-31 #agent`.
4. `parse_text_import` with two indented checkbox lines.
5. `create_project`: `Automation Project`, color `#3b82f6`, list view, favorite true.
6. `create_section`: `Doing` in `project:automation`.
7. `create_tag`: `agent`, color `#10b981`.
8. `create_template`: `Weekly check`, title `Review weekly goals`, priority 2, tag name `agent`, project `project:automation`, recurrence `weekly`.
9. `create_saved_filter`: `Important`, query `priority:2 #agent`, color `#ef4444`.
10. `create_task` as `task:root`: title `Conformance root`, description `Across every native surface`, priority 2, due date `2030-01-15`, due time `09:30:00` in `UTC`, deadline `2030-01-14T12:00:00Z`, estimate 45, dread 2, project/section/tag aliases, recurrence `weekly`.
11. `create_task` as `task:dependency`: title `Conformance dependency`, estimate 15, no project.
12. `reschedule_reminder`: set `task:root` to `2030-01-14T11:30:00Z`; this is the existing user-facing create-or-reschedule operation.
13. `add_relation`: `task:root` blocks `task:dependency`.
14. `create_comment` on `task:root`: `Conformance comment`.
15. `create_time_slot`: `Deep work`, `2030-01-15`, `09:00:00`–`11:00:00`, UTC, project `project:automation`, color `#3b82f6`.
16. `append_time_slot_task`: append `task:root` to the created slot.
17. `create_time_block`: `Root block`, `2030-01-15`, `09:30:00`–`10:15:00`, UTC, task `task:root`, created slot, locked true, color `#3b82f6`.
18. `patch_settings`: replace only the complete appearance section with dark theme, accent `#10b981`, compact density, medium font size, inter font, reduced motion true.
19. `complete_task` for recurring `task:root`; capture its source operation ID and verify exactly one next occurrence is created and reminder state transitions consistently.
20. `undo_operation` using that captured source operation ID; verify the root task/reminder and recurrence lineage return to the pre-completion state and the generated next occurrence is removed.
21. `preview_import` with Markdown content `- [ ] Imported conformance task`; capture `content_fingerprint`.
22. `apply_import` with the unchanged content/fingerprint and empty project/tag mappings, creating `task:imported` through one mutation.
23. Read `get_catalog`, `get_task`/comments/relations/reminders/activity for `task:root`, `list_tasks`, `list_time_slots`, `list_time_blocks`, `planning_daily` for `2030-01-15` capacity 480, `planning_weekly` for `2030-01-15` with Sunday start, `calendar_tasks` over the containing range, `stats`, and `get_sync_state`.
24. `export_tasks` in JSON, CSV, and Markdown to fresh private output files; validate each complete format and normalized inventory.
25. `create_backup` to a fresh private output file; validate framing, manifest version/schema/inventory, payload hash/length, SQLite integrity, foreign keys, and schema v5 without restoring it into the source profile.

Expected final global revision and retained event count: **17**. Expected database-mutating operation count: **17**. The three exports and backup creation are local-file side effects but do not change the profile revision. The driver derives the exact expected affected-entity sets from the corpus and fails if recurrence/import behavior adds a second revision or event.

## Error corpus

Run after the success corpus without accepting a mutation:

1. `get_task` with UUID `00000000-0000-0000-0000-000000000001` → stable task-not-found error.
2. `create_task` with a whitespace-only title → stable validation error and no revision change.
3. `add_relation` from `task:root` to itself → stable validation/conflict error and no revision change.
4. `apply_import` using the preview fingerprint from step 21 but changed content → stable fingerprint/conflict error and no revision change.

Compare HTTP status plus Junban error envelope for direct HTTP/CLI and structured `isError: true` content for MCP after normalizing transport wrappers. The semantic code, message class, retryability, bounded details, and unchanged revision must agree. No surface may panic, reconnect-loop, write partial state, or expose a token.

## Final authoritative observation

After each surface exits cleanly, start or retain one normal optimized owner and observe through authenticated HTTP only:

- profile, sync state, typed settings;
- complete catalog and every domain collection touched by the corpus;
- exact task details, comments, relations, reminders, activity, slots, and blocks;
- bounded event catch-up from revision zero using the current event epoch;
- exported artifact parses and complete backup inventory/integrity;
- SQLite quick/integrity and foreign-key checks through supported backup validation, never through a competing live connection;
- runtime/listener/profile-lock cleanup after final shutdown.

The normalized success responses, error responses, final state, revision sequence, events, receipts, and artifact inventories must be byte-identical canonical JSON across all four surfaces.

## Harness and evidence

`scripts/check-phase5-conformance.py` must:

- reject a dirty tree for the authoritative mode and record exact binary hashes/sizes and commit;
- build nothing and launch optimized binaries only;
- use bounded readiness and shutdown polling with private temporary profiles;
- parse CLI stdout as exactly one JSON value and MCP stdout as JSON-RPC frames only;
- keep all raw credentials and absolute paths out of retained output;
- write deterministic `goals/rust-rewrite/evidence/phase-5-conformance.json` with corpus version, per-surface normalized digests, assertion booleans, and top-level `accepted`;
- exit nonzero on any skipped call, normalization omission, schema/state/revision/event/error/artifact mismatch, stdout contamination, retained process/listener/lock, or secret occurrence.

A `--self-check` mode may use temporary output and a reduced setup to validate harness rejection paths. It is not acceptance evidence.
