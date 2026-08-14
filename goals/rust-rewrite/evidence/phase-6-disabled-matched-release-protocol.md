# Phase 6 disabled matched parent/head release protocol

Date frozen: 2026-08-03

Protocol: `junban-phase6-disabled-matched-release-v1`

Status: frozen before the authoritative idle-host run. `--quick` and `--self-check` validate the harness only. Contended-host or dirty-tree runs may retain preliminary numbers but never claim the frozen gate.

## Purpose

Prove that the Phase 6 exact-head optimized hosted server, with AI/voice code present but disabled/unused, stays inside the frozen Phase 1 hosted ceilings and does not grow warm cgroup memory versus the Phase 5 parent base by more than noise. The workload is the exact Phase 1 health/UI/idle protocol—not an enabled chat/voice session.

## Harness

[`../../../scripts/check-phase6-disabled-matched-release.py`](../../../scripts/check-phase6-disabled-matched-release.py)

Reuses the Phase 1 sample primitive from [`../../../scripts/bench-hosted-server.py`](../../../scripts/bench-hosted-server.py) (`junban-phase1-hosted-server-v1`) so task counts, settle windows, cgroup isolation, Node rejection, and memory fields stay identical.

## Artifacts

For each side (parent and head):

1. optimized `junban-server` built with the pinned Rust toolchain and `--locked --release`;
2. matching production `dist/` from `pnpm build` at that same commit;
3. recorded binary SHA-256, byte size, dist tree SHA-256, file count, total bytes, rustc/node/pnpm versions, and commit.

Default parent base: `351c842` (`feat: add native CLI and MCP automation`).

Default head: the exact `HEAD` commit under test.

Build or accept:

```bash
# Build missing parent/head into target/phase6-disabled-matched/{parent,head}/
python3 scripts/check-phase6-disabled-matched-release.py --build \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json

# Or accept prebuilt trees
python3 scripts/check-phase6-disabled-matched-release.py \
  --parent-server path/to/parent/junban-server \
  --parent-web-dir path/to/parent/dist \
  --head-server path/to/head/junban-server \
  --head-web-dir path/to/head/dist \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json
```

Package scripts:

```bash
pnpm bench:phase6-disabled-matched:self-check
pnpm bench:phase6-disabled-matched:quick
pnpm bench:phase6-disabled-matched -- --build
```

## Environment

- Linux cgroup v2 and a working `systemd --user` session
- Python 3 stdlib only
- Idle host for authoritative status: 1-minute load average ≤ 0.75 × CPU count, ≥2 GiB MemAvailable, and not heavily into swap
- Clean git worktree when claiming authoritative head measurement
- Driver, builds, and UI probe setup stay outside every measured cgroup
- Each sample runs in a fresh transient user unit with `MemoryAccounting=yes`
- Fail closed if the measured cgroup does not contain exactly one `junban-server` process or if any Node/npm/pnpm/vite/playwright marker appears

## Interleaved sample procedure

Authoritative: **five** independent pairs. Quick: **one** pair.

For sample index `i = 0 .. N-1`:

1. Run one fresh-profile Phase 1 sample against the **parent** binary + parent dist.
2. Run one fresh-profile Phase 1 sample against the **head** binary + head dist.

Each Phase 1 sample (authoritative knobs):

1. fresh mode-`0700` profile and deterministic owner token;
2. start optimized server on `127.0.0.1:0` inside a transient cgroup unit;
3. poll health; record startup-to-health;
4. settle **2.0s**;
5. idle memory snapshot (cgroup current/peak, RSS, PSS, process count);
6. workload: static `GET /` and `/index.html` ×20, create 100 tasks, list ×20, 20× replace/complete/uncomplete/delete, final list;
7. warm memory snapshot;
8. SQLite/WAL/SHM sizes;
9. stop unit, delete profile, require cleanup success.

Record global interleaving order, per-sample side/commit/binary/dist hashes, and all Phase 1 memory/latency fields.

## Disabled request proof (no binary instrumentation)

1. **Phase 1 path set** — the frozen workload only issues health, static shell, and `/api/v1/tasks*` routes. The harness classifies that path set and fails if any AI/voice/model marker appears.
2. **Head release initial UI static closure** — walk `dist/index.html` plus the Vite manifest **static** import closure (not `dynamicImports`). Fail if path or body contains AI/voice/local-model markers.
3. **Live initial UI probe** — boot the head release server once outside the memory-sample loop and fetch only that static closure through HTTP. Record every issued path. Fail on forbidden markers.

JavaScript is not executed. Microphone, `AudioContext`, workers, and provider HTTP clients are not opened by the probe.

## Budgets

| Check                                 |                             Budget |
| ------------------------------------- | ---------------------------------: |
| Head maximum warm cgroup current      |                           ≤ 24 MiB |
| Head maximum warm cgroup peak         |                           ≤ 32 MiB |
| Head median warm − parent median warm | ≤ max(15% of parent median, 1 MiB) |
| Process count per sample              |                          exactly 1 |
| Resident Node markers                 |                                  0 |
| Disabled request proof                |                               pass |

## Zero-construction claim (separate)

The external harness **cannot** prove that the Rust process constructed zero AI HTTP clients, model caches, or speech runtimes without adding counters to the measured binary. That in-process claim remains outside this protocol and is tracked explicitly in the JSON as `zero_construction_claim.status = not_proven_by_release_cgroup_harness`, with pointers to existing unit/integration tests and `scripts/check-local-voice-assets.mjs`.

## Evidence status

| Status                                        | Meaning                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `authoritative_passed`                        | idle host, clean tree, budgets passed                                     |
| `preliminary_passed_contended_or_dirty_host`  | budgets passed but host contended or tree dirty — **not** the frozen gate |
| `authoritative_failed` / `preliminary_failed` | budget or proof failure                                                   |
| `non_authoritative_dry_run`                   | `--quick`                                                                 |

## Authoritative rerun

When the retained JSON is preliminary, rerun on an idle host with a clean tree:

```bash
python3 scripts/check-phase6-disabled-matched-release.py --build \
  --output goals/rust-rewrite/evidence/phase-6-disabled-matched-release.json
```

Only `evidence_status: authoritative_passed` with `accepted: true` satisfies the Wave 5 disabled matched gate.

## Retained artifacts

- Machine JSON: [`phase-6-disabled-matched-release.json`](phase-6-disabled-matched-release.json)
- Narrative: [`phase-6-disabled-matched-release.md`](phase-6-disabled-matched-release.md)
