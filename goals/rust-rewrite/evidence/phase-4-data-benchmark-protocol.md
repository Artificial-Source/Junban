# Phase 4 data-operation benchmark protocol

`junban-phase4-data-v1` measures Phase 4 export, complete backup, restore cutover, and post-restore hosted memory with the existing Linux cgroup-v2 hosted-server harness. It extends `scripts/bench-hosted-server.py`; it is not a parallel harness and adds no dependency.

## Scope

| In scope                                                       | Out of scope                                       |
| -------------------------------------------------------------- | -------------------------------------------------- |
| Optimized `target/release/junban-server` only                  | `cargo run`, dev profiles                          |
| Production `dist/` static assets                               | Vite/Node runtime                                  |
| Fresh mode-`0700` profile + deterministic private token        | Reused/dirty profiles                              |
| `junban-scale-seed --task-count N` outside the measured cgroup | HTTP task creation inside the cgroup               |
| Streamed `GET /api/v1/exports/tasks?format=json`               | CSV/Markdown export timing                         |
| Streamed `GET /api/v1/backup` framed `.junban-backup`          | Hostile/malformed artifact fuzz (covered by tests) |
| Streamed `POST /api/v1/backup/restore` from on-disk artifact   | Recovery-mode-only restore path                    |
| Post-restore restart in a fresh measured cgroup                | Browser download prompting                         |
| Frozen 24 MiB warm / 32 MiB peak memory ceilings               | Invented throughput budgets                        |

## Preconditions

```bash
pnpm build
cargo build --locked --release -p junban-server
cargo build --locked --release -p junban-storage --features scale-bench --bin junban-scale-seed
python3 scripts/bench-hosted-server.py --self-check
```

Requirements match earlier hosted protocols: Linux cgroup v2, working `systemd --user`, `systemd-run` / `systemctl`, and Python 3 stdlib only.

The development-only seeder writes each fresh deterministic profile **before** the measured `junban-server` starts. Seeder wall time is recorded and stays outside the transient user service cgroup. Every measured cgroup must contain exactly one optimized Rust server process and no Node/tooling marker.

## Fixed authoritative workload

Three independent samples use a 10,000-task seeded profile and a two-second post-health settle.

For each sample:

1. Create a fresh profile directory mode `0700` and pre-write the deterministic owner-only access token.
2. Seed with `junban-scale-seed --data-dir <profile> --task-count 10000` outside the cgroup.
3. Start `target/release/junban-server` in a transient `systemd --user` unit (`MemoryAccounting=yes`, `Type=exec`, bind `127.0.0.1:0`).
4. Poll health via `runtime.json`, wait the 2.0s settle window, and record **idle** cgroup current/peak plus RSS/PSS.
5. **JSON export:** stream `GET /api/v1/exports/tasks?format=json` to a driver-side temporary file with `copyfileobj` (no full-body Python buffer). Validate HTTP 200, `application/json` content type, attachment disposition, parseable JSON, and `tasks.length == 10000`. Record bytes, elapsed ms, throughput MiB/s, and operation cgroup current/peak sampled while the request runs.
6. **Complete backup:** stream `GET /api/v1/backup` the same way. Validate HTTP 200, `application/octet-stream`, attachment disposition containing `.junban-backup`, and a nonempty framed envelope (`JNBK` magic, version 1, positive manifest/payload lengths, size = header + manifest + payload). Record bytes, elapsed/throughput, and operation cgroup current/peak.
7. **Restore:** `POST /api/v1/backup/restore` with `Content-Type: application/octet-stream`, streaming the on-disk backup file handle as the body (no payload materialization in Python). Validate HTTP 200 and `restart_required: true`. Record elapsed ms, uploaded bytes/throughput, and restore operation cgroup current/peak.
8. Stop the restart-required unit. Confirm staging temp files under `transfers/` and `backups/` are gone.
9. Restart the release server on the **same restored profile** in a **new** measured cgroup. Verify health, authenticated profile access, and task count via paginated `GET /api/v1/tasks` (`limit=100`). Record post-restore startup-to-health and **post-restore warm** cgroup current/peak.
10. Stop the restore unit, delete the profile and driver artifacts, and require cleanup success with no lingering unit or server/tooling process.

## Commands

Authoritative three-sample run:

```bash
python3 scripts/bench-hosted-server.py \
  --mode phase4 \
  --server target/release/junban-server \
  --seeder target/release/junban-scale-seed \
  --web-dir dist \
  --output goals/rust-rewrite/evidence/phase-4-data-bench.json
```

Or:

```bash
pnpm bench:phase4 -- \
  --output goals/rust-rewrite/evidence/phase-4-data-bench.json
```

Quick smoke only (not evidence):

```bash
python3 scripts/bench-hosted-server.py --mode phase4 --quick
pnpm bench:phase4:quick
```

Quick mode uses one 500-task profile. It enforces the same integrity and memory ceilings but is not authoritative evidence.

## Report fields

Machine-readable JSON includes:

- protocol name/version, authoritative flag, sample/task knobs, streaming notes, budget basis
- host OS/kernel/CPU, rustc, git commit, dirty working-tree flag
- server and seeder binary path/size/SHA-256
- exact command argv and cwd
- per-sample seed duration, startup-to-health, idle memory, export/backup/restore operation records (bytes, elapsed ms, throughput MiB/s, cgroup current/peak, validation), post-restore startup/warm/sqlite, integrity block, cleanup flag
- summary p50/p95/min/max/median series for every recorded metric
- `integrity_passed`, `cleanup_passed`, `memory_budget_passed`, overall `budget_passed`
- `evidence_status`: `authoritative_passed` | `authoritative_failed` | `non_authoritative_dry_run`

## Acceptance / budget

Overall `budget_passed` requires:

1. **Integrity:** every sample exported exactly the seeded task count, backup envelope validated nonempty, restore returned `restart_required`, and post-restore paginated task count matched the seed.
2. **Cleanup:** every sample removed its profile, driver artifacts, staging temps, and systemd units with no process leak.
3. **Memory:** post-restore warm cgroup current max ≤ **24 MiB**, and the max sample peak (operation-attributable and unit absolute peaks) ≤ **32 MiB**.

Throughput and operation latency are **recorded** for evidence. This protocol does **not** invent a separate throughput or latency fail gate; Phase 4 ExecPlan acceptance requires the measurements themselves, and the frozen hosted memory ceilings remain binding. Context-map engineering targets (export ≤1.5 s, backup ≤2 s, restore ≤5 s on the 10k profile) may be discussed in outcome notes but do not override the harness budget basis above.

Same-commit variance and per-phase regression rules from Phase 1 remain in force for warm-median interpretation.

## Fail-closed conditions

The harness exits non-zero (authoritative) or raises before writing a passing verdict when any of the following occur:

- non-2xx where success is required, or restore without `restart_required: true`
- malformed export JSON, wrong task count, or invalid backup framing
- process count ≠ 1 inside a measured cgroup, or Node/npm/pnpm/vite/playwright appears
- missing cgroup/RSS/PSS metrics
- server not on loopback
- staging temp-file leak after an operation
- lingering systemd unit or profile/artifact cleanup failure
- post-restore warm or sample peak above the frozen ceilings on an authoritative run

## Assumptions

- User systemd session is available (`systemctl --user`).
- cgroup v2 provides `memory.current` and `memory.peak`.
- Operation peak is the maximum `memory.current` sampled while the request runs (attributable even when cumulative `memory.peak` cannot be reset mid-unit).
- Absolute unit peaks are retained alongside attributable peaks and contribute to the sample peak used for the 32 MiB ceiling.
- No other tool may place processes into the bench unit; unit names are unique per sample and post-restore restart.
- Protocol knobs are fixed in the harness (authoritative vs `--quick` only).

## Measured result

The accepted three-sample run is `phase-4-data-bench.json` (`authoritative_passed`). Every sample exported and restored exactly 10,000 tasks and cleaned its staged artifacts and measured units.

| Metric                             | Accepted result        |
| ---------------------------------- | ---------------------- |
| JSON export p50 / p95              | 506.48 / 510.13 ms     |
| JSON export median throughput      | 1.85 MiB/s             |
| Complete backup p50 / p95          | 199.17 / 223.88 ms     |
| Complete backup median throughput  | 34.03 MiB/s            |
| Restore p50 / p95                  | 1,136.45 / 1,146.49 ms |
| Restore median throughput          | 5.96 MiB/s             |
| Post-restore warm median / maximum | 6.6562 / 6.8516 MiB    |
| Maximum operation/sample peak      | 25.2617 MiB            |

The frozen 24 MiB warm and 32 MiB peak ceilings pass. The run records one optimized Rust server and no Node/tooling process in each measured cgroup.

`phase-4-data-bench-failed.json` retains the preceding same-tree failed run (32.8086 MiB maximum peak). Diagnostic `memory.stat` sampling isolated 20.465 MiB of file cache from simultaneously resident candidate, durable rollback, and live SQLite images, versus 8.961 MiB anonymous memory. The accepted implementation fsyncs the rollback snapshot and advises Linux that its clean cache pages can be dropped before candidate apply; rollback durability and reload behavior remain unchanged. The database specialist approved the narrow optimization after its Linux-only target gate was corrected.
