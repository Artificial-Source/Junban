# Phase 6 disabled matched parent/head release evidence

- **Date:** 2026-08-03
- **Protocol:** `junban-phase6-disabled-matched-release-v1`
- **Harness:** `scripts/check-phase6-disabled-matched-release.py`
- **Machine JSON:** [`phase-6-disabled-matched-release.json`](phase-6-disabled-matched-release.json)
- **Protocol freeze:** [`phase-6-disabled-matched-release-protocol.md`](phase-6-disabled-matched-release-protocol.md)
- **Evidence status:** `preliminary_passed_contended_or_dirty_host` — **not** the frozen idle-host gate
- **Accepted:** `false` (host swap-contended and measurement worktree dirty with harness/docs only)

## Scope

Matched disabled release comparison of:

| Side   | Commit                                     | Role                                                     |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| parent | `351c842b0fd5e8b346e0483d0d95b3a34fa86edc` | Phase 5 base (`feat: add native CLI and MCP automation`) |
| head   | `a1673aa58c87fb53573c48358a31b23b2325549b` | Phase 6 Wave 4 closure product head at measurement       |

Five interleaved fresh-profile Phase 1 health/UI/idle samples per side in transient `systemd --user` cgroup-v2 units. No enabled chat, tool, STT, TTS, or local-model workload.

## Artifacts

| Side   | `junban-server` SHA-256                                            |       Size | dist tree SHA-256                                                  | dist files / bytes |
| ------ | ------------------------------------------------------------------ | ---------: | ------------------------------------------------------------------ | ------------------ |
| parent | `2d088c9f2c02218c4d9e6ba0825691c48fe3296595b8349314b34c3925c2c0b4` | 10,900,088 | `465ca0c2d3ce538155aabc27cd4b9ab0fca19a05e95647d2727c461062328b97` | 8 / 891,167        |
| head   | `cbb4cb166f02fa025e542820e33cee6039ce770f72ec9028d30133b1cf6052fb` | 16,938,584 | `77724053237cf48a92fb1a57def59417f7128291c69281978f764c27a91fe7e5` | 69 / 91,172,918    |

Toolchain at build/measurement: `rustc 1.93.0 (254b59607 2026-01-19)`, Node `v24.13.1`, pnpm `10.29.1`.

Head dist is larger because Phase 6 ships lazy local-voice static assets; the disabled initial-UI proof shows those assets are not in the startup request set.

## Interleaved warm results (cgroup current MiB)

Sample order is parent then head for each index.

| Index | Parent warm | Parent peak | Head warm | Head peak |
| ----: | ----------: | ----------: | --------: | --------: |
|     0 |      7.8984 |      8.2266 |    7.8906 |    8.3438 |
|     1 |      7.3203 |      7.3789 |    8.5312 |    9.3984 |
|     2 |      7.5469 |      8.0469 |    7.8633 |    8.3086 |
|     3 |      7.0664 |      7.6797 |    8.9023 |    9.0781 |
|     4 |      7.7109 |      8.0273 |    8.5859 |    8.8281 |

### Summary

| Metric                | Parent |        Head | Budget                                |
| --------------------- | -----: | ----------: | ------------------------------------- |
| Median warm MiB       | 7.5469 |      8.5312 | growth ≤ max(15%, 1 MiB) = **1.1320** |
| Median warm delta MiB |      — | **+0.9843** | pass                                  |
| Max warm MiB          | 7.8984 |  **8.9023** | head ≤ 24                             |
| Max peak MiB          | 8.2266 |  **9.3984** | head ≤ 32                             |
| Process count         |      1 |           1 | exactly 1                             |
| Resident Node         |      0 |           0 | 0                                     |

All absolute and relative memory budgets **passed** on this run. Status remains preliminary because the host was swap-contended (`host_contention.contended = true`) and the measurement worktree was dirty with harness/documentation files.

## Disabled request proof

Passed without instrumenting the measured binary:

1. **Phase 1 path set** — only `/api/v1/health`, `/`, `/index.html`, and `/api/v1/tasks*` routes; no `/api/v1/ai` or `/api/v1/voice`.
2. **Head offline initial UI static closure** — `dist/index.html` + Vite manifest static import closure (not `dynamicImports`) contains no AI/voice/local-model markers.
3. **Head live initial UI probe** — release server fetched only:

   `/`, `/index.html`, favicon/apple icons, `assets/index-*.js`, rolldown/jsx runtime chunks, visual-fixture helper chunks present in the static graph, and `assets/index-*.css`.

No provider, model, media-device, worklet, or speech-asset path was issued.

## Zero-construction claim (not proven here)

In-process claims that disabled startup constructs zero AI HTTP clients, model caches, media devices, audio contexts, workers, or background provider tasks are **not** proven by this cgroup harness. Observing construction would require counters inside the measured release binary; the protocol forbids that instrumentation.

Recorded separately in JSON as:

`zero_construction_claim.status = not_proven_by_release_cgroup_harness`

Pointers retained there include:

- `crates/junban-ai/tests/provider_contract.rs::default_factory_has_zero_client_construction`
- `crates/junban-ai/tests/provider_runtime.rs::zero_construction_when_unused`
- server voice API tests asserting speech client `construct_calls == 0` before use
- `scripts/check-local-voice-assets.mjs` initial-graph engine exclusion

## Commands

```bash
# Harness validation
python3 scripts/check-phase6-disabled-matched-release.py --self-check

# Build or reuse cached parent/head artifacts and run five interleaved samples
python3 scripts/check-phase6-disabled-matched-release.py --build \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json

# Non-evidence smoke
python3 scripts/check-phase6-disabled-matched-release.py --quick --build
```

This retained run used cached artifacts under `target/phase6-disabled-matched/{parent,head}/` after an earlier `--build`, with `--allow-build-head-dirty` only because the harness/docs edit set was uncommitted. Product Rust/frontend inputs matched head `a1673aa`.

## Authoritative idle-host rerun

Do **not** treat this JSON as the frozen Wave 5 disabled gate. After other agents finish and the host is idle, on a clean worktree:

```bash
python3 scripts/check-phase6-disabled-matched-release.py --build \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json
```

Require `evidence_status: authoritative_passed` and `accepted: true`.
