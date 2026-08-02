# Phase 5 Automation Benchmark Protocol

Date frozen: 2026-08-01

Protocol: `junban-phase5-automation-v1`

Status: frozen before the authoritative run. `--quick` and `--self-check` runs validate the harness only and are never acceptance evidence.

## Purpose

Measure optimized native CLI and persistent-stdio MCP behavior without a development server, browser, Node runtime, or direct SQLite client. The driver and fixture setup remain outside every measured cgroup. Every operation reaches the same authenticated Rust HTTP owner path used by the hosted product.

## Authoritative artifacts

Build with the pinned toolchain and lockfile:

```bash
cargo build --locked --release -p junban-server -p junban-cli -p junban-mcp
```

Record relative artifact names, SHA-256 digests, byte sizes, exact commit, dirty-state rejection, `rustc -Vv`, operating-system/kernel summary, CPU model/count, cgroup mode, SQLite file size, and protocol version. Never record a bearer value, credential hash, absolute local path, username, hostname, or environment dump.

## Environment and isolation

- Linux cgroup v2 and a working per-user systemd manager are required.
- Each measured process runs in a fresh transient `systemd-run --user` service with `MemoryAccounting=yes`.
- The Python driver, fixture setup, credential creation, and result validation remain outside measured cgroups.
- An external-owner MCP sample uses two cgroups: one containing exactly one `junban-server` process and one containing exactly one `junban-mcp` process.
- A local-owner MCP sample uses one cgroup containing exactly one `junban-mcp` process; the API owner is hosted in that process and no second runtime process is permitted.
- The harness rejects any `node`, `nodejs`, `npm`, `npx`, `pnpm`, `vite`, or `playwright` process in a measured cgroup.
- Readiness, EOF, signal cleanup, lock release, and listener cleanup use bounded condition polling. The only fixed wait is a 2-second idle-settle period before memory sampling.

Private fresh profiles use deterministic non-secret fixture content and an owner-private operator credential file. An external MCP connection uses a one-time `read,write` automation credential written to an owner-private file during unmeasured setup. Raw credentials never enter argv, stdout, stderr retained as evidence, command descriptions, or the result JSON.

## Frozen workload

### A. Active-owner CLI startup and operation

1. Start one optimized `junban-server` on a fresh deterministic profile containing 100 tasks.
2. Confirm instance-matched runtime discovery and authenticated health.
3. Run **20** independent optimized `junban --json task list --limit 100` processes against that active local owner.
4. Measure each process from spawn immediately before `exec` to exit after one complete JSON value is read.
5. Validate every result schema, task count, revision, exit status, empty unexpected stderr, and that no client attempted profile-lock ownership.

Recorded series: start-to-result latency, exit status, response byte count, server cgroup current/peak before and after the series, and process counts.

### B. No-owner one-shot CLI

Run **10** independent samples. Each sample uses a new deterministic empty profile with no runtime owner:

1. spawn optimized `junban --json --data-dir <profile> task list --limit 100`;
2. measure spawn-to-result-and-clean-exit;
3. validate one JSON value, an empty task page, runtime metadata removal, listener closure, SQLite/profile-lock release, and successful immediate lock reacquisition;
4. reject any detached child or second process.

The CLI process is measured in its own transient cgroup. Profile creation and post-exit lock verification are outside it.

### C. Persistent MCP operation samples

Run **3** external-owner samples. Each sample uses a new deterministic profile and one scoped `read,write` credential:

1. start an external optimized server and optimized `junban-mcp --server <loopback-url> --credential-file <private-file>` in separate measured cgroups;
2. initialize a real line-delimited MCP session and validate declared tools/resources/prompts;
3. capture settled MCP idle memory;
4. execute exactly **100** successful catalog calls: 50 `create_task` mutations followed immediately by 50 exact-ID `get_task` reads for the created task;
5. generate one operation ID per mutation and retain it for any safe transport retry;
6. measure call-to-result latency separately for writes and reads;
7. validate zero JSON-RPC/protocol errors, zero tool errors, monotonically increasing revisions, exact final 50-task state, 50 mutation events, stable receipt/event relationships, and no operator-only tool exposure;
8. close stdin, await clean exit, and verify listener/profile ownership remains solely with the external server until its own controlled shutdown.

The driver parses every stdout line as an MCP JSON-RPC frame. Any non-frame stdout byte fails the run. Expected stderr diagnostics are bounded and credential-free.

### D. MCP idle ownership modes

Record at least **3** settled idle samples for each mode:

- attached mode: `junban-mcp` attached to a separately measured active owner;
- local-owner mode: `junban-mcp --data-dir <fresh-profile>` acquires and hosts the owner in-process.

For each sample record initialization latency, cgroup `memory.current`, cgroup `memory.peak`, process count, profile SQLite size, and cleanup state. The local-owner sample must expose a reachable matching runtime record while alive and remove it after EOF.

### E. Lifecycle and failure cases

Run each case against optimized binaries with bounded polling:

- stdin EOF after initialization;
- SIGINT after initialization;
- SIGTERM after initialization on Unix;
- abrupt SIGKILL after initialization;
- credential revocation during a live attached MCP session;
- one cancelled in-flight MCP request;
- stale runtime metadata followed by a no-owner command;
- two concurrent no-owner contenders.

Graceful cases must remove runtime metadata, stop the listener, close the SQLite worker, and release the profile lock. Abrupt termination may leave strict stale metadata, but the listener and lock must be released and the next owner must safely ignore/replace the stale record. Revocation must fail closed on the next list/call without leaking the credential. Cancellation must emit no late response and must not retain staged artifacts, profile locks, or an in-flight owner after cleanup. Concurrent contenders may attach or return the stable busy error, but must never produce two owners.

## Metrics and fixed budgets

| Metric                                                                  |                 Samples | Acceptance budget |
| ----------------------------------------------------------------------- | ----------------------: | ----------------: |
| Active-owner CLI `task list` start-to-result p95                        |                      20 |       **≤150 ms** |
| No-owner CLI start-to-result-and-clean-exit p95                         |                      10 |       **≤350 ms** |
| Persistent MCP `create_task` call p95                                   | 150 total across 3 runs |       **≤100 ms** |
| Persistent MCP `get_task` call p95                                      | 150 total across 3 runs |        **≤75 ms** |
| Attached MCP settled `memory.current`, maximum                          |                      ≥3 |       **≤24 MiB** |
| Attached MCP cgroup `memory.peak`, maximum                              |                      ≥3 |       **≤32 MiB** |
| Local-owner MCP settled `memory.current`, maximum                       |                      ≥3 |       **≤24 MiB** |
| Local-owner MCP cgroup `memory.peak`, maximum                           |                      ≥3 |       **≤32 MiB** |
| Protocol/tool errors in successful workload                             |               300 calls |             **0** |
| Extra measured processes / resident Node processes                      |            every sample |             **0** |
| Cleanup, lock, listener, state, revision, event, and secrecy assertions |            every sample |      **all pass** |

Percentiles use linear interpolation over sorted samples: rank `(p / 100) * (n - 1)`. Memory values are binary MiB (`bytes / 1_048_576`). `memory.current` is sampled after the settle period; `memory.peak` is the kernel cgroup value for the process lifetime.

The separately measured owner must remain below the established **24 MiB warm / 32 MiB peak** hosted ceilings. Its post-workload settled-memory change from its same-run pre-client baseline must stay within the larger of **15% or 1 MiB**. A larger change requires retaining the raw failure, running matched idle-host controls, and recording a root-cause decision; it cannot waive the absolute ceiling. The sole accepted decision value is `durable-sqlite-state-growth`, requested explicitly with `--accept-explained-owner-delta`; it is allowed only when state-creating samples show corresponding SQLite/WAL growth, idle controls show no leak pattern, process/no-Node/cleanup checks pass, and every absolute memory ceiling remains within budget. The accepted report must keep `owner_delta_raw_passed: false` visible.

Any client-side idle process over 24/32 MiB, missed sample, malformed frame, secret disclosure, duplicate owner, state mismatch, unexpected stderr/stdout contamination, cleanup failure, or unexplained hosted-owner regression blocks acceptance. Do not weaken a budget after seeing results.

## Result document

`scripts/check-phase5-automation-budget.py` writes deterministic JSON evidence. The unwaived run is retained as `goals/rust-rewrite/evidence/phase-5-automation-owner-delta-raw.json`; when the frozen disposition predicates pass, the explicit decision run is retained separately as `goals/rust-rewrite/evidence/phase-5-automation-bench.json`. Each document contains:

- protocol identity/version and all frozen knobs/budgets;
- sanitized artifact/toolchain/host metadata;
- raw per-sample latencies and memory values;
- p50/p95/min/max summaries;
- normalized final-state/revision/event assertions;
- lifecycle/ownership/stdout/secrecy/no-Node assertions;
- an explicit boolean for every budget and one top-level `accepted` boolean.

The harness exits nonzero unless every required sample and assertion passes. Quick-mode output uses a separate caller-supplied temporary path and is never copied into accepted evidence.
