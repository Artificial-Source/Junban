# Security

Security implementation lands with the phases that introduce each surface. This document states the standing posture so later work stays aligned.

## Standing rules

- All shipped backend, domain, storage, server, CLI, MCP, AI orchestration, reminder, backup, and plugin-host runtime code is Rust.
- Node.js is frontend development and build tooling only. Releases must not require or launch Node.
- SQLite is the only live database. Markdown is import/export, not a second live backend.
- Plugins are capability-limited portable packages. Unrestricted in-process native plugin APIs are out of scope.
- Optional AI, voice, and plugin subsystems must not inflate default startup or idle memory when unused.

## Hosted server

The hosted Rust server implements:

- `127.0.0.1:4219` as the default bind, with explicit bind override;
- exact raw `Host` allowlisting on every request; `Forwarded` and `X-Forwarded-Host` are ignored;
- unauthenticated health (includes non-secret `instance_id` for runtime matching), unauthenticated recovery status for the recovery UI, and static shell/assets; every other `/api/v1` request requires a bearer, including fetch-parsed SSE;
- a persistent random bearer token in the private profile's operator-readable `access-token` file; rotation first durably records one private recovery receipt, and the immediately previous token is accepted only for an exact retry of `POST /api/v1/auth/rotate` with that receipt's operation ID; tokens are never placed in runtime metadata or logs;
- private hashed automation credentials in `automation-credentials.json` (at most 32 entries). Each credential stores id, label, created-at, optional expiry, exact sorted scopes (`read`, `write`, `data` — none implies another), and a SHA-256 digest of the full presented bearer compared with `subtle` constant-time equality. The bearer format is `jba_<uuid>_<64-hex>`; raw secrets are never stored. Startup fails closed on malformed authority. Create/list/revoke are operator-only; create is client-secret-generated and hash-only on the server;
- route authorization resolves an immutable principal (operator or automation id/scopes) after Host/origin checks and before body limits or maintenance admission. Unknown API routes default operator-only. Restore, recovery mutation, hostname policy, operator-token rotation, credential administration, diagnostics clear/read, and reminder delivery lease/claim/settle/owner-lost remain operator-only;
- a small global in-memory invalid-auth limiter (eight attempts per rolling 30 seconds). It is deliberately bounded and resets at process restart;
- authenticated bearer holders are untrusted for availability: concurrent SSE connections are hard-capped at 64 per process with a retryable `503 sse_connection_limit` overflow, and SSE forwarders cancel on client disconnect and graceful shutdown so open streams cannot pin the process;
- rejection of unsafe browser mutations when an optional `Origin` does not exactly match the raw Host, while clients with no Origin remain usable;
- a 512 KiB JSON body limit with JSON errors, independent 4 MiB receipt-material and 512 KiB event limits, global CSP/frame/content-type/referrer headers, and generated request IDs returned in `x-request-id` and error envelopes;
- explicit `/api` fallback routes before the static SPA fallback, so unknown API paths never return HTML;
- startup rejection when the static web directory and private profile directory overlap, preventing accidental token/database serving;
- bounded task cascades/bulk actions, event catch-up pages, retained event history, undo receipts, and WAL checkpoint work so an authenticated client cannot request unbounded transaction or stream material;
- durable atomic replacement of the persisted Host policy and one process-wide staged-artifact permit: while a backup download, restore upload/cutover, or task export is active, another staged operation fails with `409 staged_artifact_conflict` before creating a temporary file.

Static assets remain public because URL fragments are not sent to the server. The browser accepts only one nonempty, correctly decoded `#access_token=<value>` fragment, moves it to `sessionStorage`, and immediately removes the fragment. Any fragment shape outside that exact form is discarded; `access_token` query parameters are removed without being used, while unrelated query parameters remain. Query-string tokens and native `EventSource` are not supported.

Junban never invokes, installs, or configures Tailscale. Setup guidance may be displayed only. Restore/maintenance barriers arrive with backup/restore.

## Profile files and secrets

The profile directory is owner-only (`0700`) and its database, lock, access token, token-rotation receipt, automation credentials, AI provider/speech secrets (`ai-secrets.json`), persisted Host policy, and runtime metadata files are owner-only (`0600`) on Unix. Default profiles use the per-user application-data location for the host OS (`$XDG_DATA_HOME/junban` or `$HOME/.local/share/junban` on Linux/BSD, `$HOME/Library/Application Support/Junban` on macOS, `%LOCALAPPDATA%/Junban` on Windows), falling back to `./data` only when required environment data is missing. Existing custom output parents are never chmodded or assigned a new ACL. A newly created CLI token file receives a protected Windows DACL containing one full-access ACE for the file owner before secret bytes are written; failure removes the empty file and stops before server registration. Windows atomic private-file replacement applies the same protected owner-only DACL to its new file and uses `MoveFileExW` with write-through and conditional replacement; in-memory credential authority changes only after that call succeeds. CLI exports, complete backups, token-rotation reservations, and other private artifacts use the same owner-only temporary-file and atomic publication boundary. Unix replacement remains file fsync, atomic rename or no-replace publication, then parent-directory fsync. Runtime metadata contains only the bound address and process ID and is removed on graceful shutdown (Ctrl-C everywhere; SIGTERM on Unix as well).

The Windows implementation follows the official [`GetSecurityInfo`](https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo), [`SetSecurityInfo`](https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo), and [`MoveFileExW`](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw) contracts. `PROTECTED_DACL_SECURITY_INFORMATION` prevents inherited ACEs on the newly opened file, and `MOVEFILE_WRITE_THROUGH` requires the move to be flushed before success is reported.

- Provider API keys and speech credentials are secrets in `ai-secrets.json` only. Settings and APIs expose credential **ids** and presence flags — never secret bytes. Complete SQLite backups do not include that file; restore clears AI enablement and credential bindings and does not read or write `ai-secrets.json`.
- Confirmed provider/context/credential preflight completes before a daily or history-rewrite transaction; exact terminal action replay is provider-free.
- Daily briefing and edit/retry/regenerate routes are operator-only. Strict bodies, deterministic action identities, 30-day removed-run tombstones, and one transaction per suffix rewrite prevent stale operation receipts from reviving deleted AI authority.
- Daily provider prompts are ephemeral server-owned user messages that request the read-only `plan_my_day` tool first, include the exact date and confirmed default energy when configured, and prohibit schedule apply. They are not persisted and contain no profile/session/operation identifier or credential; custom instructions remain system messages.
- AI tool mutations require an approval bound to canonical tool name and arguments; trusted tool result envelopes omit receipts, tokens, and raw upstream bodies. Chat SSE exposes versioned local envelopes only.
- Built-in chat provider base URLs are fixed official HTTPS origins (or loopback for Ollama/LM Studio). Custom bases allow HTTPS anywhere or loopback HTTP and reject userinfo, query, and fragment material.
- Browser-local voice downloads use pinned HTTPS manifest entries with SHA-256 admission; workers and support assets are same-origin. Cloud speech audio leaves the host only through authenticated server speech routes when cloud speech is enabled.
- Diagnostics and error logs must redact secrets and sensitive URLs.
- Scoped automation credentials are private-file-backed and non-admin; the same-user local threat boundary is honest: filesystem access to the operator token remains full administrator authority.

Operator-facing AI/voice configuration and egress expectations: [`ai-and-voice.md`](ai-and-voice.md).

## Plugin child sandbox checkpoint

The optional `junban-plugin-host` is the only crate linked to Wasmtime. Slice 2B.1 revalidates actual component imports against the exact runtime profile and canonical grants before compilation, then builds a deny-by-default linker. TypeScript receives no WASI. Rust receives only `wasi:io/error`, `wasi:io/streams`, `wasi:cli/environment`, `wasi:cli/exit`, and `wasi:cli/stderr` at exact version 0.2.6, linked individually with empty environment/arguments, closed input, no stdout, and bounded sink stderr. Ambient WASI network, filesystem/preopens, random, clocks, processes, inherited stdio/environment, HTTP, and broad linker helpers are absent.

One serial owner retains the limited Store/instance across successful calls. Each call receives finite profile-specific fuel; memory, table, instance, stack, IPC body, callback, and output limits remain bounded. Callback replies must exact-match the active generation/epoch/session/invocation/callback/kind authority. Guest WIT errors remain typed outcomes, while traps/runtime failures discard the Store. Active cancellation, unload, and shutdown fail closed rather than acknowledging work that has not stopped.

This is not the complete hostile-runtime claim. Slice 2B.2 still owns wall-deadline epoch interruption, blocked host-future cancellation, hostile memory/table/stack/output/spin exhaustion, EOF/crash recovery, Store replacement, and the cross-platform containment matrix. `P7-DEP-001` and the Wave 2 security gate remain open until that later evidence and optimized replacement measurements pass.

## Supply chain

- Pin GitHub Actions to full commit SHAs.
- Dependabot groups routine patch/minor Cargo, npm, and GitHub Actions updates. Major upgrades require an explicit migration decision instead of automatic churn.
- `cargo-audit` and `cargo-deny` are mandatory CI checks. CI installs exact pinned tool versions from checksum-verified prebuilt binaries before running the checked `deny.toml` policy.
- Frontend production dependencies stay limited to browser UI libraries.

## Reporting

See [`../SECURITY.md`](../SECURITY.md).
