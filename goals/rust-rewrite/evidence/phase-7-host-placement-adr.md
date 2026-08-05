# Phase 7 Wave 0 host-placement ADR

Date: 2026-08-04
Status: **accepted** — clean idle-host five-sample evidence and focused architecture review approved
Evidence: [`phase-7-host-placement.json`](phase-7-host-placement.json) (authoritative candidate), [`phase-7-host-placement-quick.json`](phase-7-host-placement-quick.json) (preliminary protocol history)
Contract: [`phase-7-context-map.md`](phase-7-context-map.md)

## Decision

**Retain an on-demand child `junban-plugin-host`; do not embed Wasmtime in the owner process.**

The clean five-sample campaign selected `on_demand_child_host` because neither placement materially regressed on the frozen Rust+TypeScript warm, peak or cold criteria, so the predeclared fault-containment tiebreak applies. The child path survived traps, CPU and memory limits, in-flight child death, replacement, graceful shutdown and orphan checks for both component profiles. The ordinary release server remained below 24/32 MiB and did not link or construct Wasmtime or spawn a host.

The harness emitted an authoritative candidate with `accepted=false` because it cannot approve its own architecture decision. The focused architecture recheck returned `APPROVE`, closed `P7-ARCH-001`–`004`, and authorized manual acceptance metadata in the retained JSON.

Wave 1 sequencing is **not** circular with placement:

1. Architecture freezes host placement from Wave 0 evidence.
2. Wave 1's first SDK-only subgate then produces matched default
   `junban-server` vs server-with-SDK/protocol memory proof (no Engine, no child)
   **before** schema/runtime product work proceeds.
3. That default SDK proof is a condition on **continuing** Wave 1 implementation,
   not a prerequisite to choosing placement, and is **not** claimed by the custom
   probe projection.

## What was built

Temporary isolated spike under `tools/phase7-host-placement/` (not product crates):

| Artifact                                 | Role                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `junban-p7-spike-probe`                  | Parent HTTP probe: `sdk` / `inprocess` / `child` modes   |
| `junban-p7-spike-host`                   | Child stdio host; no DB path, token, or profile lock     |
| Rust `wasm32-wasip2` guest               | Minimal ping/trap/cpu-loop/grow component                |
| TypeScript pure guest                    | jco 1.26.1 + componentize-js 0.22.0 with `--disable all` |
| `scripts/check-phase7-host-placement.py` | cgroup-v2 harness; fail-closed; SDK/full bins separated  |

Exact pins:

- Wasmtime / wasmtime-wasi **45.0.3** features: `runtime`, `cranelift`, `component-model`, `async` + WASI `p2`
- jco **1.26.1**, componentize-js **0.22.0** (build-only Node)
- Rustc **1.93.0**

These are immutable historical measurement inputs, not the production dependency selection. After this spike, `RUSTSEC-2026-0222` made 45.0.3 unacceptable. Production Wave 2 keeps Rust 1.93 and selects exact `wasmtime`/`wasmtime-wasi` **36.0.13**, the patched 24-month LTS line; active-runtime containment and performance evidence must be regenerated on that line.

## Non-negotiables proven in this spike

1. **Ordinary `junban-server` does not link or construct Wasmtime**
   `strings`/crate-path markers: no Wasmtime on the release server binary. Server baseline cgroup stayed well under 24/32 MiB in the quick sample.
2. **SDK/protocol-only probe is separable**
   Built with `--no-default-features` into `target/p7-sdk-only/` so it is not overwritten by the full probe.
3. **Child receives no DB/token/lock**
   Length-prefixed JSON IPC; env scrubbed; hello identity cannot encode token/sqlite; component path rejects profile-looking names; child hashes loaded bytes and exact-matches hello `component_sha256` before compile.
4. **Trap / CPU / memory containment**
   In-process and child survived deliberate trap, epoch-interrupted CPU loop, and StoreLimits grow failure for **both Rust and TypeScript**. Missing or failed survival evidence blocks placement selection.
5. **Child in-flight crash/recovery (P7-ARCH-001)**
   All child request I/O goes through one `child_exchange` helper that takes session
   ownership, restores only on successful non-shutdown replies, and on any write/read
   EOF/error kills/reaps/clears before returning. The in-flight crash probe prestarts a
   SIGKILL helper, then issues host-side `Sleep` through that same helper so its pass
   proves ordinary IPC errors cannot wedge a replacement spawn. Graceful Shutdown still
   waits/cleans without restore. Required for **both** child Rust and child TypeScript.
   Missing/failed/bound-overrun blocks selection.
6. **No runtime Node**
   TypeScript is componentized at build time; measured units reject active Node tooling processes.
7. **IPC frame cap = 256 KiB** (product plugin-output ceiling), with unit rejection of oversized frames.

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

## Fair comparator (P7-ARCH-002)

Child variants are measured with the **SDK-only parent probe** (no Wasmtime linked in
the parent process). In-process variants use the full Wasmtime parent probe.

Selection considers **both Rust and TypeScript** warm current, peak, and cold total
(spawn+engine/compile/instantiate/first call as applicable):

- warm material if delta > max(15%, 8 MiB)
- peak material if delta > max(20%, 32 MiB)
- cold material if delta > max(25%, 100 ms)

If one placement is materially worse and the other is not, choose the other. Conflicting
material tradeoffs block for architecture judgment. Only when neither required profile
materially regresses may fault containment pick child. Selected-profile ceilings derive
from the selected placement only; losing projections are retained separately.

## TOCTOU component admission (P7-ARCH-003)

Load opens a path once, metadata-prechecks when available, then reads through a bounded
`take(MAX+1)` buffer (≤32 MiB). The exact retained bytes are hashed and compiled; paths
are not reopened at compile time. After first compile, bytes may be dropped while the
compiled `Component` is retained for later reinstantiate-after-trap. Sparse oversize
rejection and replacement-after-load are covered by unit tests.

## Actual import inspection (P7-ARCH-004)

Freshly built component bytes are inspected with `wasmparser` (`junban-p7-inspect-imports`).
Evidence records actual imports. Selection blocks unless TypeScript imports are exactly
empty and Rust imports are exactly the frozen five baseline names. Report constants are
not trusted as proof. The spike may still call broader `p2::add_to_linker_async` for Rust;
that remains an explicit **non-production** linker limitation.

## Authoritative measurements

The retained campaign used a clean tree, three consecutive uncontended preflight windows, explicit idle-host confirmation, five samples per variant and uncontended pre/post checks. Its JSON status is `authoritative_candidate`; the decision has no blockers.

| Variant                    | Warm median / max MiB | Peak max MiB | Cold median / max ms |
| -------------------------- | --------------------: | -----------: | -------------------: |
| ordinary `junban-server`   |         4.586 / 5.398 |        6.488 |                  n/a |
| lazy in-process Rust       |         4.734 / 4.855 |        5.102 |      45.898 / 57.540 |
| child Rust                 |         4.883 / 5.430 |        5.738 |      47.053 / 54.060 |
| lazy in-process TypeScript |     280.848 / 287.207 |      333.441 | 9272.868 / 10127.987 |
| child TypeScript           |     280.512 / 280.695 |      326.727 |  9104.312 / 9460.921 |

The selected child projections and explicit headroom propose these Wave 1 active gates:

| Profile    | Projected warm / peak max MiB | Proposed warm / peak ceiling MiB |
| ---------- | ----------------------------: | -------------------------------: |
| Rust       |               10.602 / 11.508 |                  18.602 / 19.508 |
| TypeScript |             285.867 / 332.496 |                357.334 / 415.620 |

These numbers are intentionally profile-specific. TypeScript's componentize-js/SpiderMonkey component is materially large even though the host placement adds no material regression. The default/no-plugin 24/32-MiB budget remains unchanged. The architecture reviewer accepted these active ceilings as frozen Wave 1 gates; Wave 5 replaces projection with integrated product evidence and may revise them through the same documented gate rather than silently loosening them.

## Measurement method and limitations

- Linux cgroup-v2 via `systemd-run --user` + MemoryAccounting (self-check required; never faked).
- Quick mode: **1 sample** → `evidence_status=preliminary_quick`; retained authority uses five samples.
- Authoritative candidate requires **all** of:
  - five samples
  - clean git tree at campaign **start** (evidence file write afterward does not retroactively dirty eligibility)
  - pre + post actual idle (CPU-scaled load; active confounder CPU ticks; swap **I/O** delta only)
  - explicit `--idle-host-confirmed`
  - successful real TypeScript component plus `inprocess_typescript` and `child_typescript` samples
  - no `--skip-typescript` (debug-only; can never be authoritative)
  - no Wasmtime on `junban-server`; Wasmtime present on full probe; absent on SDK-only probe
- Host contention measures **activity**, not mere existence:
  - candidate build/preview/browser PIDs must show positive CPU tick delta over a short sample window
  - candidacy is not bare Node identity: cargo/rustc/etc and browsers match directly; `node`/`nodejs` count only with recognized tool markers in comm/cmdline (`tsc`, `vite`, `pnpm`, `/node_modules/.bin/`, …). Bare Pi/agent Node sessions are not process-specific confounders (aggregate CPU still covered by pre load thresholds)
  - confounder candidacy excludes the harness PID and its bounded `/proc/<pid>/stat` ancestor chain (supervising Pi/node parent, etc.); siblings, unrelated sessions, and descendants/cgroup work are **not** excluded; evidence records excluded ancestor PIDs/count/method only (no ancestor command lines)
  - swap contention uses combined `/proc/vmstat` `pswpin`/`pswpout` **rate** over the 0.25s activity window with a frozen threshold of **≥256 pages/s (≥1 MiB/s at 4 KiB/page)**; below-threshold page noise is informational only; allocated-but-inactive swap never contends; evidence records raw deltas, pages/s, MiB/s, page-size assumption, and threshold
  - **pre-run** enforces CPU-scaled historical load thresholds (must not reject a Phase 6-class idle host solely for load5≈3.28 on ~20 CPUs)
  - **post-run** still enforces active external confounder CPU ticks and swap I/O, but treats historical load averages as **informational only** because they include this campaign's own compile/invoke CPU (`load_thresholds_enforced=false` on post samples)
  - authoritative eligibility requires both pre and post uncontended under those respective semantics

### Projection limitation (critical honesty)

Custom probe cgroup totals and derived **projected product** values:

```text
projected = server_baseline + max(0, variant - sdk_only_probe)
```

are **not** an actual SDK-linked or integrated `junban-server` measurement.

They are a temporary cross-check only. They do **not** prove the context-map criterion that a Phase 7 server linked to SDK/protocol-only stays within default memory growth bounds, and they were **not** a prerequisite to freezing placement. Wave 1's subsequent clean exact-commit matched release pairs supplied that SDK-only default proof: default warm was 8.6484 MiB median/9.5312 MiB maximum and 9.5820 MiB maximum peak, 0.3868 MiB below feature-off median. Wave 5 still measures integrated server+host and may revise active ceilings.

The accepted ceilings are data-derived from selected-path projections plus explicit headroom only. They are not integrated product measurements; architecture acceptance freezes them as Wave 1 implementation gates. The mandatory matched SDK-only default condition is now fulfilled; the later integrated Wave 5 replacement remains.

Other limits:

- `invoke_wall_ms` is recorded but **not** enforced as a general per-call wall deadline; only the explicit CPU-loop epoch ticker is measured. Product Wave 2 must enforce epoch + wall deadlines on every guest call.
- Advisory `RUSTSEC-2026-0222` has no 45.x patch. The throwaway spike's historical dependency result is not production acceptance, and the workspace `deny.toml` contains no advisory exception. Product Wave 2 selects patched 36.0.13 and must pass clean audit/deny checks.

## Evidence posture

The quick JSON remains preliminary protocol history and must not be used for acceptance. The retained measurement records `evidence_status=authoritative_candidate`, five complete samples, clean start state, no pre/post contention, real Rust and TypeScript components, exact inspected imports and no decision blockers. After the independent `APPROVE` verdict, manual gate metadata records `accepted=true`, the four fixed findings, retained placement, conditions and numeric ceilings without rewriting any measured value.

## Losing path

Lazy in-process passed the same containment probes but lost the frozen fault-containment tiebreak. The architecture reviewer authorized deleting or reducing that losing temporary path during Wave 2. Product Wave 2 implements only the accepted child placement; the temporary crate is not renamed wholesale into `junban-plugin-host`.

## Follow-ups

1. Wave 1 SDK-only matched default condition is fulfilled by `phase-7-sdk-matched-release.json` at clean commit `5d05eacbdfd9298eefc16c5b69f730cd2f05494e`.
2. Wave 5 replaces projections with integrated selected-path measurements and may revise active ceilings only through documented evidence/review.
3. Production resolution selected exact Wasmtime/`wasmtime-wasi` 36.0.13 LTS on Rust 1.93 with no advisory exception; Wave 2 must replace active-runtime containment/performance evidence before acceptance.

## Commands

```bash
cargo fmt -p junban-phase7-host-placement -- --check
cargo clippy --locked -p junban-phase7-host-placement --all-targets --all-features -- -D warnings
cargo test --locked -p junban-phase7-host-placement --all-features
cargo build --locked --release -p junban-phase7-host-placement
python3 scripts/check-phase7-host-placement.py --self-check
python3 scripts/check-phase7-host-placement.py --quick \
  --output goals/rust-rewrite/evidence/phase-7-host-placement-quick.json
# retained authoritative candidate (idle host + clean tree only):
python3 scripts/check-phase7-host-placement.py --idle-host-confirmed \
  --output goals/rust-rewrite/evidence/phase-7-host-placement.json
node scripts/check-docs.mjs
git diff --check
```
