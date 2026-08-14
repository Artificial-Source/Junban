---
name: junban
description: Use Junban MCP or CLI for local-first tasks. Prefer MCP resources for reads, exact UUIDs, scoped credentials, and never handle raw tokens.
---

# Junban agent skill

## Choose a surface

- **MCP (`junban-mcp`)** for a persistent session: discovery, multi-step reads, coordinated mutations.
- **CLI (`junban`)** for one-shot scripts and operator admin (`auth`, restore, rotate-token, hosts, diagnostics).

Both share one catalog and one HTTP owner path. Do not open SQLite directly.

## Credentials

- Create a scoped file credential: `junban auth create --name agent --scope read --scope write --write-token ./agent.token`
- Add `--scope data` only when export/backup is required.
- Point MCP/CLI at `--credential-file` / `JUNBAN_CREDENTIAL_FILE`. Never put tokens in chat, argv logs, tool args, or commits.
- Local MCP without `--server` may use the operator token only for instance-matched loopback owners.

## Read path

1. Prefer resources: `junban://today`, `junban://projects`, `junban://tags`, `junban://settings`, `junban://profile`, `junban://sync`.
2. Exact IDs: `junban://tasks/{task_id}`, `junban://projects/{project_id}`.
3. Use read tools when filters/cursors are needed (`list_tasks`, `get_catalog`, planning tools).
4. Prompts `plan-my-day`, `triage-inbox`, and `weekly-review` need `read` only. Prompts assemble context and never mutate.

## Write path

- Use exact UUIDs from prior reads. No fuzzy name lookup.
- Civil dates: `YYYY-MM-DD`. Instants: RFC 3339 with offset/`Z`.
- Destructive catalog tools require the documented `confirm` value (`delete`, `restore`, `revoke`, `clear`, `rotate-token`).
- Prefer idempotent tools when retries are likely. Do not blindly retry restore.
- Operator-only tools (restore, token rotation, credential admin, hosts, diagnostics) are CLI-only and never listed over MCP.

## Errors and revocation

- Structured tool errors use `{ "error": { "code", "message", ... } }`.
- After credential revoke, the next MCP list/call fails closed. Recreate a credential; do not cache authority.
- Keep stdout protocol-only for MCP. Never echo bearer material.
