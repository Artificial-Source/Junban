# Phase 7 process-memory calibration preflight

Date: 2026-08-05

Status: **implemented, cross-platform campaign pending; calibration only**

Protocol: `junban-phase7-process-memory-calibration-v1`

## Blocker and boundary

`P7-PLAN-RUNTIME-001` is open. Wasmtime's default 64-bit configuration reserves approximately 4 GiB of virtual address space for each 32-bit linear memory, plus growth and guard reservations. That default makes a useful Unix `RLIMIT_AS` calibration impossible even though the frozen Junban profiles permit only one 64-MiB Rust memory or one 128-MiB TypeScript memory. A hard child-process ceiling cannot be selected honestly until optimized valid-workload baselines exist on Linux, macOS, and Windows.

This preflight only makes those baselines measurable. It does **not** choose, enforce, or claim a process cap; add `RLIMIT_AS`, a Windows Job Object, spawn restrictions, or unsafe code; close `P7-PLAN-RUNTIME-001` or `P7-RUNTIME-SEC-001`; or authorize Slice 2C.

## Candidate Engine tuning

The child Engine now uses exact constants:

| Wasmtime 36.0.13 setting        |     Value | Reason                                                                                  |
| ------------------------------- | --------: | --------------------------------------------------------------------------------------- |
| `memory_reservation`            |   128 MiB | the largest frozen TypeScript linear-memory limit; Rust remains Store-limited to 64 MiB |
| `memory_guard_size`             |         0 | avoid an unrelated virtual guard reservation                                            |
| `memory_reservation_for_growth` |         0 | avoid Wasmtime's default post-relocation growth reservation                             |
| allocation strategy             | on demand | unchanged selected child authority                                                      |

Wasmtime 36 documents that a wasm32 reservation below the 4-GiB addressable range requires generated explicit bounds checks. Zero guard does not remove memory safety; it prevents guard-based bounds-check elision. Growth may relocate because the existing default `memory_may_move = true` remains unchanged, while the Store limiter remains the authoritative 64/128-MiB guest bound. See the exact-version `Config` documentation for [`memory_reservation`](https://docs.rs/wasmtime/36.0.13/wasmtime/struct.Config.html#method.memory_reservation), [`memory_guard_size`](https://docs.rs/wasmtime/36.0.13/wasmtime/struct.Config.html#method.memory_guard_size), and [`memory_reservation_for_growth`](https://docs.rs/wasmtime/36.0.13/wasmtime/struct.Config.html#method.memory_reservation_for_growth).

This is candidate production tuning required to calibrate address-space use, not the process cap. Exact constant tests and the retained launched-child suite keep both components, Store memory-grow denial, bulk memory, stack, table limits, failed-Store destruction, and clean replacement under this configuration.

## Valid maximum-working-set fixtures

No public WIT changed. Each retained test consumer has one private test-only command, `memory-calibration-barrier`:

- Rust allocates and page-touches 48 MiB under its frozen 64-MiB guest limit, then calls the already-imported and granted `host-settings.get-settings` capability.
- TypeScript allocates and page-touches 64 MiB under its frozen 128-MiB guest limit, then calls the same capability.
- The launched harness intentionally withholds that callback reply only until it obtains a child sample, then replies immediately. The guest keeps the allocation live across the callback and returns normally.

The barrier is a deterministic valid workload, not the later hostile canonical-lift amplification fixture. It neither allocates outside the frozen guest limits nor increases a runtime limit.

## Exact measurement protocol

The opt-in ignored release test `process_memory_calibration::calibration_campaign` performs one warm-up and five measured runs for Rust, followed by one warm-up and five measured runs for TypeScript. Every run launches a fresh exact `target/release/junban-plugin-host`; profiles and runs are serial.

For each child, the harness:

1. starts an exact-PID sampler immediately after spawn;
2. samples spawn and Hello;
3. sends the ordinary hash-bound Load and samples compilation plus initial instantiation;
4. invokes the valid maximum-working-set barrier, obtains another sample while its granted callback is intentionally held, replies before the one-second command deadline, and requires normal return;
5. performs one representative successful service invocation;
6. samples shutdown, receives `ShutdownComplete`, and requires successful reap and empty diagnostics.

The private protocol intentionally exposes one atomic Load response only after compilation and initial instantiation. The JSON therefore reports the honest combined phase `compile_and_instantiate`; it does not invent an unobservable split. Sampling is evidence-only polling. Each phase requires a sample: Linux and macOS allow five seconds for its first sample, while Windows allows thirty seconds because a cold GitHub runner can take longer to start the first `powershell.exe Get-Process`; later polls remain paced. A failed sampling command is retained and reported with its platform diagnostic if that required sample deadline expires. Runtime timeout, cancellation, and containment correctness continue to use the watchdog/condition-variable authorities and never depend on the sampler or a sleep.

Each canonical JSON campaign records:

- schema/protocol/status, exact Git commit and tracked-tree cleanliness;
- OS and architecture;
- release executable name and SHA-256;
- profile, retained component SHA-256, guest memory limit, and barrier allocation;
- exact Wasmtime line and reservation/guard/growth constants;
- whole-run duration and exact-child sample count;
- sample count and maxima for every phase, and whole-run maxima.

A run fails if the release assertion, component inspection, protocol flow, callback reply, invocation, shutdown/reap, empty diagnostics, or any required phase sample fails.

## Single-machine Linux preliminary

The complete local Linux protocol ran from clean source commit `0bb0c039da0fe326a9b091d9ad5a98e134fd2159` with release executable SHA-256 `1493b40ef2f1952375af219b8c052ebb3ba87c29d7cad1c70f954dced67842b3`. The warm-up and all five measured runs per profile passed. Maxima across the five measured runs were:

| Profile    |     VmSize |     VmPeak |        RSS |      VmHWM |
| ---------- | ---------: | ---------: | ---------: | ---------: |
| Rust       | 348.39 MiB | 348.39 MiB |  73.57 MiB |  73.57 MiB |
| TypeScript | 771.54 MiB | 785.90 MiB | 536.71 MiB | 539.37 MiB |

The canonical raw result is retained as [`phase-7-process-memory-calibration-linux-preliminary.json`](phase-7-process-memory-calibration-linux-preliminary.json). This one host is preliminary evidence only. It does not replace the pending Linux/macOS/Windows workflow campaign, establish ordinary variance, select a candidate cap, or close either finding.

## Platform metrics

Metrics are bytes and remain platform-specific rather than being mislabeled as interchangeable:

- **Linux:** exact-child `/proc/<pid>/status` `VmSize` (virtual address), `VmRSS`, `VmPeak`, and `VmHWM`.
- **macOS:** exact-child `ps` virtual size and RSS. Peak fields remain null because this standard exact-process interface does not expose them reliably.
- **Windows:** exact-child PowerShell `Get-Process` private committed bytes (`PrivateMemorySize64`), pagefile bytes (`PagedMemorySize64`), working set, virtual size, and the available pagefile/working-set/virtual peaks.

A future Unix `RLIMIT_AS` candidate must be calibrated from the maximum valid **virtual-address** result, not RSS. A future Windows Job Object process-memory candidate must be calibrated from maximum valid **private commit**; working set and virtual size remain diagnostic. Platform values are not compared as if they measured the same resource.

## Candidate-cap rule and later hostile proof

For each supported platform/profile metric authority, any candidate process cap must satisfy:

```text
candidate_cap >= ceil(1.25 * maximum_valid_metric_across_all_5_measured_runs)
```

The maximum includes compile/instantiate, the valid barrier, representative invocation, and shutdown—not only a warm snapshot. The 25% is a minimum calibration margin, not automatic acceptance. A candidate is rejected if ordinary platform variance, loader behavior, or a valid retained component approaches it.

Headroom alone is insufficient. The same candidate must still be triggered by the later canonical-lift amplification fixture required by `P7-RUNTIME-SEC-001`, with bounded child-only failure, failed-Store destruction, parent-observed child replacement, and a successful clean invocation afterward. If no cap separates the valid maximum from hostile amplification on a supported platform/profile, the cap is not frozen; profile or body authority must be reconsidered instead.

## Fail-closed campaign criteria

The campaign is invalid and cannot inform a cap when any of these holds:

- a platform/profile lacks one warm-up plus exactly five serial measured runs;
- the executable is not an optimized release host, hashes/configuration differ, or the tracked tree is dirty;
- any phase has no sample, sampling addresses another process, or a metric authority is unavailable;
- the barrier exceeds guest limits, fails to reach its granted callback, times out, traps, or does not return normally;
- protocol, representative invocation, shutdown, reap, or diagnostic-empty checks fail;
- results are aggregated across Unix address space and Windows commit as one metric;
- only one developer machine is available, or a historical Wasmtime 45 projection is substituted;
- the later amplification fixture does not reliably hit the candidate while valid maximum workloads retain at least 25% headroom.

No observed number closes either open finding by itself. Cross-platform raw artifacts, cap implementation, hostile amplification/replacement evidence, and focused security recheck are all still required.

## Commands and campaign dispatch

Local Linux preliminary run (approximately twelve fresh release children):

```bash
cargo build --locked --release -p junban-plugin-host
JUNBAN_PLUGIN_MEMORY_CALIBRATION=1 \
JUNBAN_PLUGIN_MEMORY_CALIBRATION_OUTPUT="$PWD/target/phase7-process-memory-calibration.json" \
  cargo test --locked --release -p junban-plugin-host \
  --test process_memory_calibration calibration_campaign -- \
  --ignored --exact --test-threads=1
```

The temporary workflow `.github/workflows/phase7-process-memory-calibration.yml` is manual and also listens only to branches named `phase7-process-memory-calibration/**`. Push such a temporary branch or dispatch the workflow at that ref. Its Ubuntu, macOS, and Windows jobs each build the exact release host, run the fixed warm-up/five-sample campaign, and upload one raw JSON artifact. It does not run on ordinary `main` pushes or pull requests and makes no acceptance claim.
