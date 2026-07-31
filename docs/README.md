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
- [`../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md`](../goals/rust-rewrite/evidence/phase-3-temporal-benchmark-protocol.md): Phase 3 temporal workload protocol and result
- [`../goals/rust-rewrite/evidence/phase-3-temporal-bench.json`](../goals/rust-rewrite/evidence/phase-3-temporal-bench.json): authoritative temporal memory, latency, and scheduler result
- [`../dogfood-output/phase-2/report.md`](../dogfood-output/phase-2/report.md): Phase 2 browser and recovery dogfood findings
- [`performance.md`](performance.md): hosted memory and scale harness commands

## Foundation docs

- [`architecture.md`](architecture.md): workspace boundaries and runtime ownership
- [`security.md`](security.md): standing security posture and supply-chain policy
- [`accessibility.md`](accessibility.md): accessibility contract for UI phases
- [`performance.md`](performance.md): memory/performance measurement rules
- [`setup.md`](setup.md): developer toolchain and commands
- [`engineering-practices.md`](engineering-practices.md): Google code-health practices as applied here

Architecture, frontend, backend, plugin, security, performance, setup, and release documents deepen in the phase that establishes each corresponding contract. Do not bulk-copy stale documentation from the archived implementation.
