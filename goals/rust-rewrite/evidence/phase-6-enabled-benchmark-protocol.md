# Phase 6 enabled local-mock release benchmark protocol

Status: **implemented and self-checked; authoritative idle-host run pending**.

The fixture requires no privileged bind. The benchmark-only interception layer
preserves the official TLS hostname while redirecting only an exact loopback
sentinel destination on port 443 to a kernel-selected unprivileged fixture port.
The current host is contended, so no current latency or memory sample is retained
as authoritative. This is not a budget result or waiver.

## Authoritative command

From a clean checkout of the exact head to retain:

```bash
python3 scripts/check-phase6-enabled-benchmark.py \
  --build \
  --authoritative \
  --idle-host-confirmed \
  --output goals/rust-rewrite/evidence/phase-6-enabled-bench.json
```

The command builds `junban-server` with Cargo's locked release profile, executes
three fresh profiles, writes the machine-readable result, and exits nonzero
unless every frozen gate passes. `accepted` can only be `true` for an
`--authoritative --idle-host-confirmed` run. A contended-host diagnostic may use
`--preliminary` instead, but such a result always has `accepted: false` even if
its observed values happen to fit every budget.

Run the interception preflight independently with:

```bash
python3 scripts/check-phase6-enabled-benchmark.py --self-check
```

## Measured boundary

Only the exact optimized `junban-server` process is placed in a transient
cgroup-v2 `systemd --user` service with `MemoryAccounting=yes`. The standalone
Python fixture, driver, ephemeral certificate generation, resolver-shim
compilation, and all evidence serialization remain outside that cgroup. Each
sample asserts exactly one cgroup process, that it is the Rust server, that it
has no resident child, and that no Node tool or process is resident.

The production endpoint contract and shipped binary are unchanged:

- OpenAI is selected for model discovery, chat, STT, and TTS.
- An ephemeral benchmark CA signs an ephemeral TLS leaf whose only DNS SAN is
  `api.openai.com`.
- `SSL_CERT_FILE` is set only in the measured server service environment.
- `scripts/phase6-fixture-getaddrinfo.c` is compiled into an ephemeral shared
  object. During a benchmark run, `LD_PRELOAD` is set only in the measured server
  environment. The standalone preflight also injects it into isolated probe
  subprocesses. The shim maps only exact `api.openai.com` lookups to the
  dedicated `127.66.0.1` loopback sentinel. It rewrites `connect` only when the
  destination is exactly `127.66.0.1:443`, redirecting to
  `127.0.0.1:$JUNBAN_PHASE6_FIXTURE_PORT`. The port environment value is a
  strictly parsed non-secret integer above 1023. Missing, privileged, malformed,
  or out-of-range values fail closed. Every other hostname, address, and port is
  delegated unchanged.
- The TLS fixture binds `127.0.0.1:0` and rejects a kernel-selected privileged
  port. No privileged bind, root capability, HTTP proxy, `/etc/hosts` edit,
  system-trust edit, endpoint override, runtime feature, or shipped artifact is
  used. TLS SNI and HTTP Host remain exactly `api.openai.com`.
- The CA private key, TLS private key, compiled shim, synthetic profile token,
  synthetic provider credentials, and fresh profile directories live only in
  an owner-private temporary root and are removed before the final cleanup proof
  is written. Evidence records certificate/shim fingerprints and tool metadata,
  never private key or bearer bytes.

The harness verifies the fixture is outside the server cgroup, that its selected
high port is unreachable after fixture exit, that `/etc/hosts` is unchanged,
that server journals do not contain any generated credential, and that profile
locks and runtime metadata are clean after shutdown. Preflight proves the exact
allowlisted hostname reaches the TLS fixture, unrelated hostnames resolve
unchanged, ordinary loopback addresses connect unchanged, the sentinel on a
non-443 port connects unchanged, and missing or invalid redirect-port values fail
closed.

## Frozen operation matrix

Each of the three fresh profiles performs, without live provider egress:

1. OpenAI model discovery through the fixed official origin.
2. Thirty short streamed turns whose OpenAI Responses SSE frames are written in
   deterministic 1–11 byte fragments across UTF-8 codepoint boundaries.
3. One read tool call that executes and continues through exactly two provider
   rounds.
4. One proposed mutation that is rejected, produces no task, and continues
   through exactly two provider rounds.
5. One proposed mutation that is approved and produces exactly one task. The
   decision response and durable SSE projection (assistant text, tool transcript,
   and terminal payload) replay exactly without contacting the fixture or
   duplicating the effect. `run_started`'s replay marker and transient provider
   usage are intentionally outside the durable replay projection; both live and
   replay streams independently retain strict sequence/terminal validation.
6. One pre-body HTTP 503 followed by exactly one successful retry.
7. One accepted request held until the production provider timeout closes it;
   the durable run must fail and the fixture connection must quiesce.
8. One partial-body connection failure; the run must fail without retry.
9. One cancellation after a fragmented text delta; timing ends only after both
   the local `run_cancelled` terminal and fixture-side connection quiescence.
   The fixture attempts a stale post-close delta and the harness proves it never
   reaches SSE or durable state.
10. One exact 1 MiB multipart STT input and exact transcript.
11. One exact 1 MiB TTS response and canonical `audio/mpeg` output.
12. Credential deletion, confirmed AI/voice disablement, maintenance status,
    post-drain memory settling, graceful server stop, runtime-file removal, lock
    reacquisition, fixture quiescence, and temporary-artifact removal.

Every local SSE stream must keep one version/run/generation identity, use unique
contiguous sequence numbers, and end in exactly one terminal. Provider-private
identifiers, stale deltas, rejected mutation effects, duplicate mutation effects,
and transcript/audio contamination of durable chat state are hard failures.
The fixture has strict request bounds and retains only sanitized route/scenario
counters and payload sizes.

## Frozen gates

There are no waivers or alternate acceptance paths:

| Gate                                                |                             Budget |
| --------------------------------------------------- | ---------------------------------: |
| First local SSE event, all 90 short turns           |                       p95 ≤ 250 ms |
| Completed short turn, all 90 turns                  |                       p95 ≤ 750 ms |
| Cancellation to terminal **and** fixture quiescence |                       p95 ≤ 500 ms |
| Exact 1 MiB STT                                     |                     p95 ≤ 1,000 ms |
| Exact 1 MiB TTS                                     |                     p95 ≤ 1,000 ms |
| Post-session warm cgroup memory                     |             every profile ≤ 32 MiB |
| Operation/cumulative cgroup peak                    |             every profile ≤ 48 MiB |
| Post-drain warm growth over pre-session             |              every profile ≤ 4 MiB |
| Resident processes                                  | exactly one Rust server, zero Node |

The JSON retains every raw latency and memory value, aggregate p50/p95/min/max,
per-profile operation assertions, process snapshots, fixture counters, hashes,
tool versions, cleanup proof, every gate boolean, `all_gates_passed`, and the
separate `accepted` decision.
