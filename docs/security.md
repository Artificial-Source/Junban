# Security

Security implementation lands with the phases that introduce each surface. This document states the standing posture so later work stays aligned.

## Standing rules

- All shipped backend, domain, storage, server, CLI, MCP, AI orchestration, reminder, backup, and plugin-host runtime code is Rust.
- Node.js is frontend development and build tooling only. Releases must not require or launch Node.
- SQLite is the only live database. Markdown is import/export, not a second live backend.
- Plugins are capability-limited portable packages. Unrestricted in-process native plugin APIs are out of scope.
- Optional AI, voice, and plugin subsystems must not inflate default startup or idle memory when unused.

## Hosted server

The Phase 1 server implements:

- `127.0.0.1:4219` as the default bind, with explicit bind override;
- exact raw `Host` allowlisting on every request; `Forwarded` and `X-Forwarded-Host` are ignored;
- unauthenticated health and static shell/assets, with bearer authentication on every other `/api/v1` request including fetch-parsed SSE;
- a persistent random bearer token in the private profile's `access-token` file; the token is never placed in runtime metadata or logs;
- a small global in-memory invalid-auth limiter (eight attempts per rolling 30 seconds). It is deliberately bounded and resets at process restart; per-client/scoped credentials belong to the CLI/MCP phase;
- rejection of unsafe browser mutations when an optional `Origin` does not exactly match the raw Host, while clients with no Origin remain usable;
- a 64 KiB JSON body limit with JSON errors, global CSP/frame/content-type/referrer headers, and generated request IDs returned in `x-request-id` and error envelopes;
- explicit `/api` fallback routes before the static SPA fallback, so unknown API paths never return HTML;
- startup rejection when the static web directory and private profile directory overlap, preventing accidental token/database serving.

Static assets remain public because URL fragments are not sent to the server. The browser accepts only one nonempty, correctly decoded `#access_token=<value>` fragment, moves it to `sessionStorage`, and immediately removes the fragment. Any fragment shape outside that exact form is discarded; `access_token` query parameters are removed without being used, while unrelated query parameters remain. Query-string tokens and native `EventSource` are not supported.

Junban never invokes, installs, or configures Tailscale. Setup guidance may be displayed only. Restore/maintenance barriers arrive with backup/restore.

## Profile files and secrets

The profile directory is owner-only (`0700`) and its database, lock, token and runtime metadata files are owner-only (`0600`) on Unix. Default profiles use the per-user application-data location for the host OS (`$XDG_DATA_HOME/junban` or `$HOME/.local/share/junban` on Linux/BSD, `$HOME/Library/Application Support/Junban` on macOS, `%LOCALAPPDATA%/Junban` on Windows), falling back to `./data` only when required environment data is missing. The default Windows profile inherits that user-profile ACL; a custom profile inherits its selected parent ACL. Junban never broadens inherited Windows permissions. Runtime metadata contains only the bound address and process ID and is removed on graceful shutdown (Ctrl-C everywhere; SIGTERM on Unix as well).

- Provider API keys and local tokens are secrets.
- Diagnostics and error logs must redact secrets and sensitive URLs.
- Scoped automation credentials are introduced with CLI/MCP rather than treating every client as full admin forever.

## Supply chain

- Pin GitHub Actions to full commit SHAs.
- Dependabot groups routine patch/minor Cargo, npm, and GitHub Actions updates. Major upgrades require an explicit migration decision instead of automatic churn.
- `cargo-audit` and `cargo-deny` are mandatory CI checks. CI installs exact pinned tool versions from checksum-verified prebuilt binaries before running the checked `deny.toml` policy.
- Frontend production dependencies stay limited to browser UI libraries.

## Reporting

See [`../SECURITY.md`](../SECURITY.md).
