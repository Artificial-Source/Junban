# TEMPORARY — Phase 7 Wave 0 host-placement spike

**Status:** throwaway measurement scaffolding for the Wave 0 host-placement ADR.

This directory is **not** the product plugin SDK, host, WIT world, package format, or lifecycle.

It exists only to compare:

1. exact Phase 6 / current `junban-server` baseline (no spike linkage);
2. a protocol/SDK-only probe (no Wasmtime);
3. lazy in-process Wasmtime before/after `Engine` creation and a minimal Component Model call;
4. an on-demand Rust child host (spawn/idle/invoke/trap/CPU-loop/memory-limit/disable/shutdown).

## Non-goals

- schema v7, package install/signing, public plugin APIs, production lifecycle
- contaminating default `junban-server` startup or release features
- final `junban:plugin@0.1.0` WIT world
- runtime Node

## Layout

| Path | Role |
| ---- | ---- |
| `wit/spike-world.wit` | **Non-public** minimal invoke/trap/loop/grow world |
| `src/protocol.rs` | SDK/protocol-only types (no Wasmtime) |
| `src/runtime.rs` | Wasmtime 45.0.3 Component Model host glue |
| `src/child_ipc.rs` | length-prefixed parent↔child frames (no token/DB path) |
| `src/bin/junban-p7-spike-probe.rs` | measured parent probe |
| `src/bin/junban-p7-spike-host.rs` | measured child host |
| `guests/rust-spike/` | minimal `wasm32-wasip2` Rust component |
| `guests/typescript-spike/` | build-only jco 1.26.1 + componentize-js 0.22.0 guest |
| `components/` | built `.wasm` outputs (generated; not source authority) |

## Build

From the repository root (release only for evidence):

```bash
cargo build --locked --release -p junban-phase7-host-placement
python3 scripts/check-phase7-host-placement.py --build-components
```

## Measure

```bash
python3 scripts/check-phase7-host-placement.py --self-check
python3 scripts/check-phase7-host-placement.py --quick   # not authoritative
python3 scripts/check-phase7-host-placement.py \
  --output goals/rust-rewrite/evidence/phase-7-host-placement.json
```

## Deletion rule

After the ADR selects a placement, delete the losing runtime path and any scaffolding the evidence no longer needs. Do not graduate this crate into `junban-plugin-sdk` / `junban-plugin-host` by renaming alone — Wave 1+ rebuilds product crates from the frozen contract.
