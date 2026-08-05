# Phase 5 Native Automation Dogfood

- **Date:** 2026-08-02
- **Platform:** Linux x86_64
- **Surfaces:** optimized `junban` CLI and `junban-mcp` stdio server

## Objective

Exercise the native automation experience as a user rather than only through unit tests: fresh-profile ownership, ergonomic human commands, strict JSON failures, reminder/planning workflows, catalog discovery, scoped MCP initialization and calls, shutdown, cleanup, and immediate profile-lock reacquisition. Node must not participate in the runtime process tree.

## CLI workflow

A fresh temporary profile was used for each pass. The production release binary performed:

1. project creation;
2. task creation with project, due date, and priority;
3. reminder scheduling and listing;
4. task listing and detail inspection;
5. daily, weekly, end-of-day, and empty motivation reads;
6. read-scope catalog discovery;
7. one deliberate malformed UUID under `--json`;
8. process exit, runtime-file cleanup, and immediate exclusive profile-lock reacquisition.

The strict JSON error remained one stdout document, used exit code `2`, and wrote no human diagnostics to stdout. One-shot local-owner commands removed `runtime.json` and released `profile.lock` before returning.

## Finding and repair

### `P5-DOG-001` — fixed and approved

The first pass found that ergonomic human mutations still printed complete event/snapshot JSON. This was functionally correct but contradicted the frozen human-output contract and made ordinary terminal use noisy.

The repair added concise, shape-aware human renderers while preserving complete strict `--json` documents and generic catalog `tool call` output. Follow-up contract review found and closed two related defects: planning DTO shape inference (`P5-API-016`) and import-warning safety/visibility (`P5-API-017`). The final output uses compact mutation receipts, bounded list/detail rows, explicit planning views, safe import transformation guidance, and exact resource/revision/operation identifiers.

## MCP workflow

The production stdio binary was exercised through the same framed protocol as a real client:

- initialize and capability negotiation;
- deterministic `tools/list` and JSON Schema inspection;
- read, write, and data scope projection;
- task/project visibility filtering;
- resources and prompts under the same scope filter;
- mutation, staged export progress, and cancellation;
- credential revocation while connected;
- stdin EOF, SIGTERM, abrupt termination, cleanup, and lock release.

The authoritative seven-scenario subprocess suite and 17-revision cross-surface corpus are retained beside this report. No Node process appeared in any release-runtime process tree, no partial artifact survived cancellation, and all owner processes/units/profile locks were clean after completion.

## Final disposition

Accepted. The user-visible defect found during dogfood has a focused process regression and an approved API-contract recheck. No Phase 5 dogfood finding remains open.
