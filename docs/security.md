# Security

Security implementation lands with the phases that introduce each surface. This document states the standing posture so later work stays aligned.

## Standing rules

- All shipped backend, domain, storage, server, CLI, MCP, AI orchestration, reminder, backup, and plugin-host runtime code is Rust.
- Node.js is frontend development and build tooling only. Releases must not require or launch Node.
- SQLite is the only live database. Markdown is import/export, not a second live backend.
- Plugins are capability-limited portable packages. Unrestricted in-process native plugin APIs are out of scope.
- Optional AI, voice, and plugin subsystems must not inflate default startup or idle memory when unused.

## Hosted server (Phase 1+)

Planned controls:

- loopback bind by default;
- authentication on all non-health application endpoints;
- exact configured hostnames only (no wildcard host trust);
- owner-only runtime metadata and token storage;
- token rotation and bounded authentication lockout/rate limiting;
- browser security headers, request/body limits, origin/host validation;
- redacted logging;
- restore/maintenance barriers when backup restore lands.

Junban never invokes, installs, or configures Tailscale. Setup guidance may be displayed only.

## Secrets and diagnostics

- Provider API keys and local tokens are secrets.
- Diagnostics and error logs must redact secrets and sensitive URLs.
- Scoped automation credentials are introduced with CLI/MCP rather than treating every client as full admin forever.

## Supply chain

- Pin GitHub Actions to full commit SHAs.
- Dependabot groups routine patch/minor Cargo, npm, and GitHub Actions updates. Major upgrades require an explicit migration decision instead of automatic churn.
- When production Rust dependencies arrive in Phase 1, `cargo-audit` and `cargo-deny` become mandatory CI checks. They are intentionally not required in Phase 0 while the Rust dependency graph is empty.
- Frontend production dependencies stay limited to browser UI libraries.

## Reporting

See [`../SECURITY.md`](../SECURITY.md).
