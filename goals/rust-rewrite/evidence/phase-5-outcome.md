# Phase 5 Outcome — Native CLI and MCP

- **Date:** 2026-08-02
- **Validated implementation commit:** `cd224ec556c806e40e814b29c862b79d6c00cfed`
- **Phase commit:** amended only to add this retained evidence and closure record
- **Status:** accepted

## Delivered

Phase 5 adds two native Rust surfaces without a competing database authority:

- `junban`: ergonomic human commands, strict `--json`, generic catalog discovery/calls, local owner discovery, in-process temporary ownership, explicit HTTPS remote access, scoped credential administration, and private atomic file transfer;
- `junban-mcp`: persistent stdio MCP with the same 87-tool catalog, scope-filtered tools/resources/prompts, real staged progress, cancellation, graceful EOF/SIGTERM handling, and bounded ownership cleanup;
- centralized server authorization for operator and hashed automation principals with independent `read`, `write`, and `data` scopes;
- one versioned, OpenAPI-bound catalog and exact request planner shared by CLI and MCP;
- `docs/cli.md`, `docs/mcp.md`, and `.agents/skills/junban/SKILL.md`.

The local fallback decision is now closed: clients verify instance-matched private runtime metadata and attach to an active owner; with no valid owner they acquire the exclusive profile lock and host the existing Rust server/application composition in-process until the command or MCP session exits. They never open SQLite directly.

## Cross-surface conformance

The authoritative 17-revision corpus ran against HTTP, attached CLI, no-owner local CLI, and MCP. Every surface produced the same canonical state/event/receipt/transfer digest:

`8b511fadf02c066077e124fd7c4fe63b9d2c30df1ad45778b996c84cc7c5ca70`

All state assertions, expected errors, event revisions, JSON/CSV/Markdown exports, complete backup validation, cleanup, and secret scans passed. See `phase-5-conformance.json` and `phase-5-conformance-protocol.md`.

## Performance and lifecycle

The accepted optimized same-commit run used cgroup-v2 transient units and passed every fixed absolute and latency budget:

| Check                           |                Result |        Budget |
| ------------------------------- | --------------------: | ------------: |
| Active-owner CLI p95            |             22.092 ms |      ≤ 150 ms |
| No-owner CLI p95                |             62.535 ms |      ≤ 350 ms |
| MCP `create_task` p95           |              3.729 ms |      ≤ 100 ms |
| MCP `get_task` p95              |              0.320 ms |       ≤ 75 ms |
| Attached MCP max warm / peak    | 20.4648 / 20.9922 MiB | ≤ 24 / 32 MiB |
| Local-owner MCP max warm / peak | 21.9805 / 22.7227 MiB | ≤ 24 / 32 MiB |

Node was absent from all runtime process trees. EOF, SIGTERM, abrupt termination, cancellation, stale metadata, revocation, cleanup, lock release, and concurrent no-owner contenders passed.

The mandatory raw owner-delta run is retained as `phase-5-automation-owner-delta-raw.json`: it failed only the relative post-workload delta check, with 1.5234 MiB maximum growth, while all absolute ceilings and lifecycle checks passed. The accepted rerun, `phase-5-automation-bench.json`, applied the protocol's explicit `durable-sqlite-state-growth` decision. Its own raw maximum delta was 1.6719 MiB after state creation; SQLite/WAL bytes grew from 477,736 to 1,527,808, matched idle controls showed no leak pattern, process counts stayed one, and the 24/32 MiB ceilings remained well below their limits. The raw assertion remains false in the accepted artifact; the disposition does not waive an absolute budget.

## Validation

The implementation passed:

- `cargo fmt --all -- --check`;
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`;
- `cargo test --locked --workspace --all-features` — 518 passed;
- optimized release builds for `junban-server`, `junban`, and `junban-mcp`;
- `cargo audit` and `cargo deny check`;
- frontend format, lint, typecheck, 345 Vitest tests, production build, dependency audit, generated-contract check, docs check, and runtime-boundary check;
- the seven-scenario production MCP stdio subprocess suite;
- authoritative conformance and automation benchmark protocols;
- manual CLI/MCP dogfood in `phase-5-dogfood/report.md`.

The retained protocol files bind exact optimized binary hashes to the validated implementation commit.

## Review and dogfood

The security gate closed `P5-SEC-001`–`P5-SEC-004`. The API-contract gate closed `P5-API-001`–`P5-API-018`, and manual dogfood closed `P5-DOG-001`. Material fixes cover credential ambiguity and private durability, exact catalog schemas and operation identity, restore/rotation outcome safety, scope-filtered MCP projection, genuine progress/cancellation, concise secret-safe human output, and the temporary-owner handoff race.

The final handoff fix permits exactly one local rediscovery only for a definitive pre-dispatch connect failure. Explicit remote targets, timeouts, response/body/decode failures, restore, and ambiguous sent writes do not enter that path. Deterministic regressions cover catalog, principal, and public-status handoff plus explicit-target refusal and lock/runtime cleanup. The exact-delta API-contract recheck approved `P5-API-018`; no material finding remains open.

## Remaining platform evidence

Linux executed the full phase suite. Windows owner-only DACL and write-through branches have portable fail-closed regressions and dependency-isolated Windows API type checks; target-native execution remains part of the existing cross-platform CI/package gates and is not represented as having run on this Linux host.

## Phase disposition

Phase 5 is accepted as one clean implementation commit. Phase 6 may begin from this boundary; no alternate owner implementation, direct CLI/MCP SQLite path, retained temporary artifact, or open Phase 5 finding remains.
