# Phase 6 Schema-v6 Cross-Surface Conformance Protocol

Date frozen: 2026-08-03

Protocol: `junban-phase6-conformance-v1`

Status: frozen for the Phase 6 Wave 5 schema-v6 head rerun of the accepted Phase 5 corpus. This protocol does **not** replace or rewrite the immutable Phase 5 result at `phase-5-conformance.json`.

## Relationship to Phase 5

The ordered success corpus, error corpus, four surfaces, alias/normalization rules, export/backup/integrity/secret/cleanup assertions, and no-Node policy are exactly the frozen Phase 5 corpus in [`phase-5-conformance-protocol.md`](./phase-5-conformance-protocol.md).

Phase 6 changes only the head schema authority and evidence labeling:

| Field                            | Phase 5 (immutable)                   | Phase 6 head rerun             |
| -------------------------------- | ------------------------------------- | ------------------------------ |
| Protocol name                    | `junban-phase5-conformance-v1`        | `junban-phase6-conformance-v1` |
| Starting schema                  | v5                                    | v6                             |
| Backup/SQLite schema assertion   | 5                                     | 6                              |
| Evidence path                    | `phase-5-conformance.json`            | `phase-6-conformance.json`     |
| Expected final revision / events | 17                                    | 17                             |
| Surfaces                         | HTTP, attached CLI, no-owner CLI, MCP | same                           |

Fresh profiles are created by current optimized binaries, so they open at schema v6 with default typed settings (including typed AI/voice defaults). The corpus still performs only accepted Phase 1–5 operations plus the shared catalog path; it does not exercise AI provider runs, voice engines, or plugin hosts.

## Surfaces and corpus

Run the same ordered 17-revision success corpus and four-case error corpus against four fresh profiles:

1. direct authenticated HTTP requests to an optimized `junban-server`;
2. optimized `junban --json --server ... --credential-file ... tool call` processes attached to an active owner;
3. optimized `junban --json --data-dir ... tool call` processes using temporary local ownership;
4. one persistent optimized `junban-mcp` stdio session using `tools/call` against an active owner.

Corpus steps, aliases, normalization, final observation, export formats, backup framing/integrity/foreign-key checks, secret rejection, lock/runtime cleanup, and cross-surface byte-identical canonical digests follow the Phase 5 protocol unchanged, except every backup and SQLite schema assertion expects **schema version 6**.

## Harness and evidence

`scripts/check-phase5-conformance.py --phase6` must:

- reject a dirty tree for authoritative mode and record exact binary hashes/sizes and commit;
- build nothing and launch optimized binaries only unless `--build` is passed;
- bind protocol name `junban-phase6-conformance-v1` and schema version 6 explicitly;
- refuse to write `goals/rust-rewrite/evidence/phase-5-conformance.json`;
- write deterministic `goals/rust-rewrite/evidence/phase-6-conformance.json` with protocol identity, schema version, corpus label, per-surface normalized digests, assertion booleans, binary metadata, commit, and top-level `accepted`;
- preserve the exact 17-revision corpus and HTTP / attached CLI / no-owner CLI / MCP comparison;
- exit nonzero on any skipped call, normalization omission, schema/state/revision/event/error/artifact mismatch, stdout contamination, retained process/listener/lock, or secret occurrence.

Authoritative invocation:

```bash
cargo build --locked --release -p junban-server -p junban-cli -p junban-mcp
python3 scripts/check-phase5-conformance.py --phase6 --authoritative \
  --output goals/rust-rewrite/evidence/phase-6-conformance.json
```

Or `pnpm conformance:phase6`.

A `--self-check` mode may validate harness rejection paths, including Phase 5/Phase 6 authority separation. It is not acceptance evidence.

## Non-goals

- Do not regenerate or weaken `phase-5-conformance.json`.
- Do not treat a Phase 6 digest mismatch against the Phase 5 digest as failure; schema-v6 defaults (for example typed AI/voice settings) legitimately change normalized state.
- Do not require Node at runtime.
- Do not open SQLite through a competing live connection during observation.
