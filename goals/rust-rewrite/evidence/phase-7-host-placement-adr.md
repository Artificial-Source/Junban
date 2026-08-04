# Phase 7 Wave 0 host-placement ADR (preliminary)

Date: 2026-08-04  
Status: **preliminary** — one-sample quick evidence on a contended host  
Branch: `phase-7-wave0-host-placement`  
Evidence: [`phase-7-host-placement-quick.json`](phase-7-host-placement-quick.json)  
Contract: [`phase-7-context-map.md`](phase-7-context-map.md)

## Decision (preliminary only)

**Preferred direction under the frozen decision rule: on-demand child `junban-plugin-host`.**

This is **not** an authoritative architecture-gate acceptance. The quick harness selected
`on_demand_child_host` by the context-map fault-containment tiebreak after close Rust
active-warm medians. Wave 1 must not treat this as frozen until five-sample idle-host
evidence is recorded with `--idle-host-confirmed` and architecture review accepts it.

## What was built

Temporary isolated spike under `tools/phase7-host-placement/` (not product crates):

| Artifact | Role |
| -------- | ---- |
| `junban-p7-spike-probe` | Parent HTTP probe: `sdk` / `inprocess` / `child` modes |
| `junban-p7-spike-host` | Child stdio host; no DB path, token, or profile lock |
| Rust `wasm32-wasip2` guest | Minimal ping/trap/cpu-loop/grow component |
| TypeScript pure guest | jco 1.26.1 + componentize-js 0.22.0 with `--disable all` |
| `scripts/check-phase7-host-placement.py` | cgroup-v2 harness; fail-closed; SDK/full bins separated |

Exact pins:

- Wasmtime / wasmtime-wasi **45.0.3** features: `runtime`, `cranelift`, `component-model`, `async` + WASI `p2`
- jco **1.26.1**, componentize-js **0.22.0** (build-only Node)
- Rustc **1.93.0**

## Non-negotiables proven in this spike

1. **Ordinary `junban-server` does not link or construct Wasmtime**  
   `strings`/crate-path markers: no Wasmtime on the release server binary. Server baseline cgroup stayed well under 24/32 MiB in the quick sample.
2. **SDK/protocol-only probe is separable**  
   Built with `--no-default-features` into `target/p7-sdk-only/` so it is not overwritten by the full probe. ~0.62 MiB vs ~13.6 MiB full probe.
3. **Child receives no DB/token/lock**  
   Length-prefixed JSON IPC; env scrubbed; hello identity cannot encode token/sqlite; component path rejects profile-looking names; child hashes loaded bytes and exact-matches hello `component_sha256` before compile.
4. **Trap / CPU / memory containment**  
   In-process and child survived deliberate trap, epoch-interrupted CPU loop, and StoreLimits grow failure; child shutdown left no orphan (`cleaned: true`).
5. **No runtime Node**  
   TypeScript is componentized at build time; process-tree scans reject node markers in measured units.
6. **IPC frame cap = 256 KiB** (product plugin-output ceiling), with unit rejection of oversized frames.

## Import profiles (frozen for Wave 2 linker design)

### TypeScript pure profile

- componentize-js `--disable all`
- **Actual imports: none** (only spike world exports)
- Host must **not** broaden the WASI linker to admit TypeScript

### Rust wasm32-wasip2 baseline profile

Exact imports observed on the spike guest:

- `wasi:io/error@0.2.6`
- `wasi:io/streams@0.2.6`
- `wasi:cli/environment@0.2.6`
- `wasi:cli/exit@0.2.6`
- `wasi:cli/stderr@0.2.6`

Host context for the spike: empty env/args, stdin closed, stdout/stderr sink, no preopens, no sockets, no HTTP inherit.

**Important:** the spike may call `wasmtime_wasi::p2::add_to_linker_async` for Rust guests. That helper **defines a broader interface set** than the five baseline imports. That is acceptable only as an admitted fixed spike convenience. It is **not** proof of the final selective production linker.

Wave 2 must:

1. import-lint exact baseline + granted host interfaces;
2. either define the five baseline interfaces à la carte, or prove broader definitions are unreachable/denied under security review;
3. never claim raw stdio/environment exposure.

## Measurement method and limitations

- Linux cgroup-v2 via `systemd-run --user` + MemoryAccounting (self-check required; never faked).
- Quick mode: **1 sample**, dirty tree allowed, contended host allowed → `evidence_status=preliminary_quick`.
- Authoritative candidate requires: five samples, clean tree, no contention signals, and explicit `--idle-host-confirmed`.
- **Probe cgroup totals are not product server+runtime totals.**  
  Projected product active memory:

  ```text
  projected = server_baseline + max(0, variant - sdk_only_probe)
  ```

  Preliminary ceilings = projected maxima + explicit headroom (Rust +25%/+8 MiB, TS +25%/+16 MiB).
- Wave 5 must measure integrated server+host and may revise ceilings.
- `invoke_wall_ms` is recorded as a limit field but **not** enforced as a general per-call wall deadline in this spike; only the explicit CPU-loop epoch ticker is measured. Product Wave 2 must enforce epoch + wall deadlines on every guest call.
- Advisory: `RUSTSEC-2026-0222` (GHSA-hgjw-h833-99q9) has no 45.x patch; ignored in `deny.toml` **only** for this throwaway spike with documented reason. Product host must re-evaluate pin/toolchain before shipping.

## Quick-sample numbers (preliminary, contended host)

Host was contended (high load, swap, build confounders). Do not use these as acceptance.

| Variant | Warm (median MiB) | Peak max (MiB) | Notes |
| ------- | ----------------- | -------------- | ----- |
| server baseline | 3.96 idle | 5.73 | under 24/32 |
| sdk-only probe | 0.47 | 0.49 | no engine |
| in-process Rust after warm | 4.46 | 4.96 | trap/cpu/grow survived |
| child Rust after warm | 4.78 | 5.94 | shutdown cleaned |
| in-process TypeScript after warm | 282.8 | 329.1 | pure component ~12.5 MiB wasm |
| child TypeScript after warm | 280.3 | 379.8 | separate from Rust evidence |

Projected product (server + max(0, variant − sdk)):

| Profile | Projected warm max | Projected peak max | Preliminary ceiling warm/peak |
| ------- | ------------------ | ------------------ | ----------------------------- |
| Rust | 8.52 | 11.18 | 16.52 / 19.18 |
| TypeScript | 286.51 | 385.07 | 358.14 / 481.34 |

Selection rule outcome on raw probe warm medians: close (4.46 vs 4.78) → **child** by fault-containment tiebreak.

## Losing path

Lazy in-process remains implementable and passed the same containment probes. It is not deleted from the temporary spike until authoritative evidence + architecture gate confirm the child path. Product Wave 2 should implement only the accepted placement; the temporary crate is deleted or reduced after the gate rather than renamed into `junban-plugin-host`.

## Follow-ups before Wave 1 architecture gate

1. Re-run `python3 scripts/check-phase7-host-placement.py --idle-host-confirmed` on a quiet host with a clean tree and five samples.
2. Confirm server no-Wasmtime linkage and ≤`max(15%, 1 MiB)` median growth vs Phase 6 disabled baseline on matched release pairs.
3. Freeze authoritative projected/active ceilings from that run (or integrated measurements if available).
4. Architecture review of the measured placement; only then start Wave 1 product crates.
5. Resolve Wasmtime advisory via 45.x patch (if published), toolchain move to a patched line, or documented residual risk accepted for product host only after review.

## Commands

```bash
cargo fmt -p junban-phase7-host-placement -- --check
cargo clippy --locked -p junban-phase7-host-placement --all-targets --all-features -- -D warnings
cargo test --locked -p junban-phase7-host-placement --all-features
cargo build --locked --release -p junban-phase7-host-placement
cargo deny check
python3 scripts/check-phase7-host-placement.py --self-check
python3 scripts/check-phase7-host-placement.py --quick \
  --output goals/rust-rewrite/evidence/phase-7-host-placement-quick.json
# authoritative candidate (idle host only):
# python3 scripts/check-phase7-host-placement.py --idle-host-confirmed \
#   --output goals/rust-rewrite/evidence/phase-7-host-placement.json
node scripts/check-docs.mjs
```
