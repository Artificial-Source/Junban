# Phase 7 outcome

Date: 2026-08-14  
Status: accepted after the resulting single Phase 7 squash commit passes exact-head CI  
Scope: capability-limited portable WebAssembly Component Model plugins

## Delivered

Phase 7 adds the versioned `junban:plugin@0.1.0` SDK and WIT world, schema-v7 plugin persistence, signed JBP1 packages and JRI1 registry, an adjacent on-demand `junban-plugin-host`, bounded Rust and TypeScript component execution, typed host capabilities, generation/epoch/session fencing, operator-only HTTP/OpenAPI management, declarative contributions, the preserved Extensions interface, and three offline signed reference plugins.

The ordinary server remains Node-free and does not link or initialize Wasmtime. One plugin-host child is created only for an active profile, with one Engine and at most 16 serialized runtimes, one active invocation per plugin, and four active invocations in total. Restore, package replacement, grant changes, disable, failure, cancellation, and process loss advance or invalidate the exact durable and process-local authorities described by the Phase 7 contracts.

## Final review

The final integrated security review at candidate `4ae2ba712c20415672f0febd1aeb1ee74fd91dbf` found two material races:

- `P7-FINAL-SEC-001`: an exact cancel could race terminal publication and emit a contradictory terminal frame;
- `P7-FINAL-SEC-002`: a guest-triggerable private-body decode path used `expect` after validated construction and could panic on corrupted ownership state.

Commit `9fc7143c9486f56d6bf7893b84ae0293ac6d1b40` fixes both: terminal commit and completed-fence publication are one serialized transition, exact late cancel is a no-op, and private-body decode failure returns typed stale authority without guest bytes. The same security reviewer rechecked only these findings and returned **APPROVED** with both fixed and closed. The final candidate additionally replaced the timeout-sensitive late-cancel probe with a deterministic unload ordering barrier and removed a duplicate manual workflow entry; neither correction changed shipped runtime behavior. Final API-contract spot review and documentation audit found no additional material issue.

No named Phase 7 finding remains open. The intentionally unsupported Windows private signing path, same-user/install-directory threat-model boundary, and build-only `componentize-js -> weval -> decompress@4.2.1` advisory retain their documented fail-closed dispositions; none is a shipped runtime dependency or suppressed root audit finding.

## Accepted evidence

All authoritative Wave 5 reports bind a clean, stable candidate at `7ac35e3588a0521671de19ac16bfa4ffc4ddd9f7`. The result JSON files were appended afterward as protocol-permitted result-only records.

| Authority                                | Result                                                                                                                                                                                                                                       | SHA-256                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Product dogfood                          | [`phase-7-dogfood.json`](phase-7-dogfood.json)                                                                                                                                                                                               | `a345a9be85c25e17f0cea0b3ade141dfa6c904f2001ed69af8c774a256682c55` |
| Default five-sample benchmark            | [`phase-7-default-benchmark.json`](phase-7-default-benchmark.json)                                                                                                                                                                           | `e0b2a7e3a1be3dbc833a204a2dcc00d8c17ff5c6c674816062913a57bec6a5c8` |
| Rust five-sample benchmark               | [`phase-7-rust-benchmark.json`](phase-7-rust-benchmark.json)                                                                                                                                                                                 | `78ebb5034bd3311e496bd38e964141aea2871aa28fa3b635739ce2e1166c24fb` |
| TypeScript five-sample benchmark         | [`phase-7-typescript-benchmark.json`](phase-7-typescript-benchmark.json)                                                                                                                                                                     | `0d104ac8363b06f0b77a3684b8e5d3ba6027e5b43e4c2aea505a2c7516df075d` |
| Linux/macOS/Windows reference matrix     | [`phase-7-reference-matrix-linux.json`](phase-7-reference-matrix-linux.json), [`phase-7-reference-matrix-macos.json`](phase-7-reference-matrix-macos.json), [`phase-7-reference-matrix-windows.json`](phase-7-reference-matrix-windows.json) | `8f01e205…`, `07d358c3…`, `56fa767d…`                              |
| Linux/macOS/Windows Slice 2E composition | [`phase-7-slice2e-linux.json`](phase-7-slice2e-linux.json), [`phase-7-slice2e-macos.json`](phase-7-slice2e-macos.json), [`phase-7-slice2e-windows.json`](phase-7-slice2e-windows.json)                                                       | `23733465…`, `b798587a…`, `b21b117b…`                              |

The authoritative Linux cgroup-v2 campaign was GitHub Actions run `31770557554` and passed all three independently checked reports:

| Profile    |                   Maximum warm/current |      Maximum peak |                     Frozen gate |
| ---------- | -------------------------------------: | ----------------: | ------------------------------: |
| Default    | 5,541,888 bytes; 5,484,544-byte median |   8,220,672 bytes |   25,165,824 / 33,554,432 bytes |
| Rust       |                       29,319,168 bytes |  32,632,832 bytes |  91,678,720 / 131,328,000 bytes |
| TypeScript |                      611,205,120 bytes | 715,870,208 bytes | 692,418,560 / 806,824,960 bytes |

Every sample observed zero swap, successful file-only reclaim, exact expected server/host counts, no runtime Node process, complete corpus behavior, cleanup, and profile-lock release. Default median warm growth over the exact Phase 6 base was 921,600 bytes, below the 1 MiB cap. Rust used 0.32×/0.25× of current/peak budget and TypeScript used 0.88×/0.89×. The TypeScript enable/compile p95 was 11,825.244 ms and remains informational because Phase 7 freezes no latency ceiling.

Exact candidate CI run `31770558122` passed all 13 jobs at `7ac35e3588a0521671de19ac16bfa4ffc4ddd9f7`: Rust, Rust supply chain, frontend/repository, release-binary E2E, Linux/macOS/Windows host containment, Linux/macOS/Windows real composition, and Linux/macOS/Windows optimized reference matrices. The Phase 7 squash is accepted only after the same CI workflow passes on its exact resulting head; result-only evidence/docs do not alter measured executable, lock, generated-contract, package, registry, checker, or protocol inputs.

## Validation summary

The final local gate passed workspace formatting, Clippy with warnings denied, all-feature Rust tests, no-default-feature server tests, frontend formatting/lint/typecheck/unit/build checks, plugin artifact/public-registry verification, generated OpenAPI/catalog checks, package-local Rust and TypeScript author checks, all 13 immutable Phase 7 visual comparisons, runtime-boundary checks, root Cargo/pnpm supply-chain checks, optimized containment, and the authoritative dogfood/performance evidence checkers. Immutable visual PNGs were not changed.

## Retrospective and later obligations

The child-process design preserved default startup and failure containment while keeping one shared application authority. The main implementation risks were not Wasm execution itself but exact durable replay, callback authority, cancellation publication, and evidence that included the large TypeScript runtime without weakening the ordinary server budget.

Phase 8 and Phase 9 packaging must enforce the documented install-directory owner/mode/ACL expectation for the adjacent host binary. Phase 8 adds desktop packaging; Phase 9 performs release-grade cross-platform packaging and the final cumulative 24/32-MiB default-path gate. Phase 10 remains the bounded whole-codebase, module-maintainability, DX, documentation, CI, and operations audit before any separately approved release tag.
