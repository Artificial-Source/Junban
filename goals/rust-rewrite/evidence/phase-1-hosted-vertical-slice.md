# Phase 1 hosted vertical slice

**Date:** 2026-07-28  
**Status:** complete; final integrated validation and review recheck recorded below

## Outcome

Phase 1 delivers the first usable source-built Junban runtime:

- one optimized Rust `junban-server` process owns one fresh SQLite profile;
- the server exposes authenticated task create/list/edit/complete/uncomplete/delete operations and a revisioned SSE stream;
- operation receipts make retry identities durable and conflict on payload reuse;
- the Rust server serves production React assets with explicit API/static fallbacks;
- the preserved Today and Inbox interface works at desktop and mobile sizes without a shipped Node runtime;
- fresh profiles, restart persistence, two-client convergence, authenticated reconnect, and graceful shutdown are covered;
- private Tailscale Serve dogfood completed through real HTTPS.

The phase intentionally stops at the minimal hosted task loop. Projects, rich task fields, search, recurrence, planning, AI, plugins, CLI, MCP, and desktop belong to later approved phases.

## Architecture decisions

- `junban-domain` owns pure task value semantics.
- `junban-app` owns framework-free use cases and repository/event ports.
- `junban-storage` owns one dedicated SQLite worker, schema v1, profile ownership, transactions, receipts, activity, and durable events.
- `junban-server` owns HTTP DTOs, Axum composition, authentication, Host/Origin policy, static serving, SSE, runtime metadata, and the binary.
- One dedicated SQLite worker was retained instead of a pool because Phase 1 writes are intentionally serialized and a pool added no demonstrated value.
- Utoipa-derived OpenAPI plus checked `openapi-typescript` output is the contract authority. Drift checks regenerate both outputs in a temporary directory.
- React components talk only through the typed fetch facade. Production assets contain no backend JavaScript resource.

## Security and lifecycle

- Loopback is the default bind.
- Static bootstrap assets and health are unauthenticated; all other `/api/v1` routes require the bearer token.
- Exact raw Host checking, matching browser Origin enforcement, body limits, CSP/frame/referrer/content-type headers, request IDs, bounded failed-auth tracking, private profile files, and API fallback separation fail closed.
- The token is accepted only from one exact URL fragment, stored in `sessionStorage`, and scrubbed immediately. Query tokens are never accepted.
- The owner lock remains alive for every SQLite repository clone. Graceful shutdown removes runtime metadata and releases profile ownership.
- SSE forwarding observes response disconnect and process shutdown, and concurrent streams are bounded per process.

## Design preservation

Eight deterministic legacy-derived references are the visual authority for the Phase 1 Today/Inbox surface:

- desktop and mobile;
- light and dark;
- Today and Inbox.

Every comparison passed at the blocking threshold of at most 1% differing pixels. Separate axe and structural checks passed. No baseline was regenerated from the rewrite.

## Memory and performance

The frozen protocol and full raw samples are in:

- [`phase-1-hosted-benchmark-protocol.md`](phase-1-hosted-benchmark-protocol.md)
- [`phase-1-hosted-memory.json`](phase-1-hosted-memory.json)
- [`phase-1-hosted-memory-budget.md`](phase-1-hosted-memory-budget.md)

The final five-sample release workload remained within the 24 MiB warm / 32 MiB peak hosted-server budget. Phase 1 measured 8.79 MiB median and 9.23 MiB maximum warm cgroup memory, compared with 179.25 MiB for the retired implementation on the same machine. Startup-to-authenticated-health measured 94.68 ms median and 141.31 ms maximum. Later phases must run the same protocol and explain material median growth; explanations cannot waive the final ceiling.

## Tailnet dogfood

[`phase-1-tailnet-dogfood/report.md`](phase-1-tailnet-dogfood/report.md) records the source-free private-HTTPS session. Create, edit, complete, uncomplete, restart persistence, delete, fragment scrubbing, desktop/mobile rendering, and graceful cleanup passed. Dogfood found one same-page connection-fragment recovery defect; it was fixed with a focused regression and passed a real Tailnet retest.

## Review ledger

- `P1-SEC-001` — **fixed** before implementation: static bootstrap/auth boundary made explicit.
- `P1-UI-001` — **fixed** before implementation: independent legacy visual authority captured.
- `P1-FINAL-LIFE-001` — **fixed**: disconnected/open SSE streams now cancel on response drop and shutdown; concurrent streams are bounded.
- `P1-FINAL-CONV-001` — **fixed**: client snapshots apply monotonically, reloads coalesce, and own-operation results upsert by ID.
- `P1-FINAL-GATE-001` — **fixed**: 24 MiB warm / 32 MiB peak ceilings, variance, and per-phase regression rules are frozen.
- `P1-FINAL-TM-001` — **fixed**: bearer holders are untrusted for availability; the 64-stream cap enforces the threat decision.
- `DOGFOOD-001` — **fixed**: a token fragment added to an already-open connection page is consumed and scrubbed without reload.
- `P1-CI-VIS-001` — **fixed**: the visual job installs checksum-pinned Noto fonts matching the capture authority and retains failure images.

No severe or material finding remains open.

## Validation

The final integrated tree passed:

- Rust formatting, Clippy with warnings denied, full workspace tests, release build, `cargo-audit`, and `cargo-deny`;
- frontend formatting, Oxlint, TypeScript, Vitest, production build, generated-contract drift, runtime-boundary and documentation checks;
- release-binary Playwright functional/security/lifecycle coverage;
- all eight visual comparisons and axe/structural checks;
- current npm production/full high-severity audits;
- benchmark quick-mode integrity and the authoritative five-sample release run;
- real private Tailscale Serve dogfood and focused connection recovery retest;
- `git diff --check` and privacy/secret scans.

PR #5 is the protected phase-delivery gate. Its exact merge head requires Rust, Rust supply-chain, frontend/repository, and release-binary E2E checks.
