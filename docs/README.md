# Junban Documentation

This directory contains canonical documentation for the active Rust implementation.

## Start here

- [`../AGENTS.md`](../AGENTS.md): agent and contributor quick start
- [`../CLAUDE.md`](../CLAUDE.md): product and development direction
- [`../PLANS.md`](../PLANS.md): planning and review standard
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): contribution workflow and local checks
- [`../SECURITY.md`](../SECURITY.md): vulnerability reporting
- [`../goals/rust-rewrite/execplan.md`](../goals/rust-rewrite/execplan.md): live phased rewrite plan
- [`../goals/rust-rewrite/evidence/baseline-memory.md`](../goals/rust-rewrite/evidence/baseline-memory.md): initial hosted-memory evidence
- [`../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-1-hosted-benchmark-protocol.md): Phase 1 hosted-server measurement protocol
- [`../goals/rust-rewrite/evidence/phase-1-hosted-vertical-slice.md`](../goals/rust-rewrite/evidence/phase-1-hosted-vertical-slice.md): Phase 1 outcome and validation
- [`../goals/rust-rewrite/evidence/phase-1-hosted-memory-budget.md`](../goals/rust-rewrite/evidence/phase-1-hosted-memory-budget.md): measured result and frozen memory ceiling
- [`../goals/rust-rewrite/evidence/phase-1-tailnet-dogfood/report.md`](../goals/rust-rewrite/evidence/phase-1-tailnet-dogfood/report.md): real private-HTTPS dogfood evidence
- [`../goals/rust-rewrite/evidence/phase-2-context-map.md`](../goals/rust-rewrite/evidence/phase-2-context-map.md): Phase 2 contract and frozen 10,000-task scale protocol
- [`../goals/rust-rewrite/evidence/phase-2-outcome.md`](../goals/rust-rewrite/evidence/phase-2-outcome.md): delivered behavior, validation, memory and latency summary
- [`../goals/rust-rewrite/evidence/phase-2-review-ledger.md`](../goals/rust-rewrite/evidence/phase-2-review-ledger.md): material Phase 2 findings and their regression evidence
- [`../goals/rust-rewrite/evidence/phase-2-hosted-memory.json`](../goals/rust-rewrite/evidence/phase-2-hosted-memory.json): authoritative five-sample hosted-memory result
- [`../goals/rust-rewrite/evidence/phase-2-scale-bench.json`](../goals/rust-rewrite/evidence/phase-2-scale-bench.json): authoritative 10,000-task performance result
- [`../goals/rust-rewrite/evidence/phase-3-outcome.md`](../goals/rust-rewrite/evidence/phase-3-outcome.md): Phase 3 recurrence, reminders, planning, validation, and performance outcome
- [`../goals/rust-rewrite/evidence/phase-3-review-ledger.md`](../goals/rust-rewrite/evidence/phase-3-review-ledger.md): material Phase 3 findings and their regression evidence
- [`../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md): Phase 3 temporal workload protocol and result
- [`../goals/rust-rewrite/evidence/phase-3-temporal-bench.json`](../goals/rust-rewrite/evidence/phase-3-temporal-bench.json): authoritative temporal memory, latency, and scheduler result
- [`../goals/rust-rewrite/evidence/phase-4-data-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-4-data-benchmark-protocol.md): Phase 4 export/backup/restore data-operation protocol
- [`../goals/rust-rewrite/evidence/phase-4-data-bench.json`](../goals/rust-rewrite/evidence/phase-4-data-bench.json): accepted 10,000-task Phase 4 data-operation evidence
- [`../goals/rust-rewrite/evidence/phase-4-outcome.md`](../goals/rust-rewrite/evidence/phase-4-outcome.md): Phase 4 acceptance, validation, performance, dogfood, and review outcome
- [`../goals/rust-rewrite/evidence/phase-4-review-ledger.md`](../goals/rust-rewrite/evidence/phase-4-review-ledger.md): closed Phase 4 database, security, UI, and dogfood findings
- [`../goals/rust-rewrite/evidence/phase-4-dogfood/report.md`](../goals/rust-rewrite/evidence/phase-4-dogfood/report.md): production-build backup/restore and Settings dogfood evidence
- [`../goals/rust-rewrite/evidence/phase-5-context-map.md`](../goals/rust-rewrite/evidence/phase-5-context-map.md): approved CLI/MCP authority, credential, catalog, lifecycle, and evidence contract
- [`../goals/rust-rewrite/evidence/phase-5-conformance-protocol.md`](../goals/rust-rewrite/evidence/phase-5-conformance-protocol.md): frozen 17-revision CLI/MCP conformance corpus
- [`../goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-5-automation-benchmark-protocol.md): frozen CLI/MCP latency, memory, lifecycle, and no-Node budgets
- [`../goals/rust-rewrite/evidence/phase-5-review-ledger.md`](../goals/rust-rewrite/evidence/phase-5-review-ledger.md): closed credential-security, catalog, MCP, and human-output findings
- [`../goals/rust-rewrite/evidence/phase-5-conformance.json`](../goals/rust-rewrite/evidence/phase-5-conformance.json): authoritative cross-surface corpus result
- [`../goals/rust-rewrite/evidence/phase-5-automation-bench.json`](../goals/rust-rewrite/evidence/phase-5-automation-bench.json): authoritative automation latency, memory, lifecycle, and cleanup result
- [`../goals/rust-rewrite/evidence/phase-5-dogfood/report.md`](../goals/rust-rewrite/evidence/phase-5-dogfood/report.md): native CLI and MCP dogfood evidence
- [`../goals/rust-rewrite/evidence/phase-5-outcome.md`](../goals/rust-rewrite/evidence/phase-5-outcome.md): Phase 5 acceptance, validation, performance, dogfood, and review outcome
- [`../dogfood-output/phase-2/report.md`](../dogfood-output/phase-2/report.md): Phase 2 browser and recovery dogfood findings
- [`performance.md`](performance.md): hosted memory and scale harness commands

## Foundation docs

- [`architecture.md`](architecture.md): workspace boundaries and runtime ownership
- [`security.md`](security.md): standing security posture and supply-chain policy
- [`cli.md`](cli.md): native CLI setup, catalog, commands, JSON contract, and credentials
- [`mcp.md`](mcp.md): native MCP stdio server, scopes, resources, prompts, and lifecycle
- [`accessibility.md`](accessibility.md): accessibility contract for UI phases
- [`performance.md`](performance.md): memory/performance measurement rules
- [`setup.md`](setup.md): developer toolchain and commands
- [`engineering-practices.md`](engineering-practices.md): Google code-health practices as applied here

Architecture, frontend, backend, plugin, security, performance, setup, and release documents deepen in the phase that establishes each corresponding contract. Do not bulk-copy stale documentation from the archived implementation.
