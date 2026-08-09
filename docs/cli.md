# Junban CLI

Native `junban` client for the Rust authority. CLI and MCP share one session, HTTP executor, and versioned automation catalog. There is no second database path and no detached daemon.

## Install and build

```bash
cargo build --release -p junban-cli
# binary: target/release/junban
```

Node is not required at runtime.

## Profile and target selection

| Flag / env                                            | Purpose                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `--data-dir <path>`                                   | Private profile directory (same default as `junban-server`) |
| `--server <url>`                                      | Explicit remote/local base URL                              |
| `--credential-file <path>` / `JUNBAN_CREDENTIAL_FILE` | Bearer file for explicit `--server`                         |
| `--json`                                              | Emit exactly one JSON value on stdout                       |

Discovery rules:

1. Without `--server`, read private `runtime.json`, require loopback, probe `/api/v1/health`, and match `instance_id` before loading the operator token.
2. If discovery fails, start one in-process API-only owner (`LocalApiOwner`) after acquiring the exclusive profile lock. The owner shuts down when the command exits.
3. Explicit `--server` never uses the operator token. It requires a credential file, rejects URL userinfo/fragments, requires HTTPS off-loopback, and never follows redirects.

## Catalog discovery

```bash
junban tools list
junban tools list --scope read
junban --json tools list
junban tool call create_task --input '{"title":"Buy milk"}'
junban tool call create_task --input @./create.json
junban tool call export_tasks --input '{"format":"json"}' --output ./tasks.json
```

`tools list --json` prints:

```json
{ "version": 1, "tools": [/* deterministic order by name */] }
```

Each tool has a stable OpenAPI operation-id name, description, self-contained input and result JSON Schemas, required access (`read` / `write` / `data` / `operator`), read/mutation kind, timeout class, and safety annotations. The catalog currently exposes **87** operations covering tasks, organization, parsing, user reminders, planning/motivation, timeblocking, settings/sync, import/export/backup, and operator controls. Reminder delivery lease/claim/settle, SSE streams, principal discovery, and raw credential creation are intentionally excluded. Credentials are created only through the secret-safe `auth create --write-token` flow. MCP consumes the same catalog; see [`mcp.md`](mcp.md).

Export and backup tools use HTTP reads but are catalogued as destructive mutations because they write a local artifact and can replace it when overwrite is explicitly enabled. Their output is owner-private, streamed to a same-directory temporary file, and atomically published.

## Ergonomic commands

All of these reduce to the shared catalog/session:

| Command                                                                                     | Notes                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `task list\|get\|add\|edit\|complete\|uncomplete\|cancel\|reopen\|delete\|bulk\|undo`       | Exact task UUIDs; civil dates `YYYY-MM-DD`          |
| `project list\|add\|edit\|archive\|delete`                                                  | Exact project UUIDs                                 |
| `tag list\|add\|edit\|delete`                                                               | Exact tag UUIDs                                     |
| `reminder list\|snooze\|dismiss`                                                            | Requires `--task-id`; snooze needs RFC 3339 instant |
| `plan daily\|end-of-day\|weekly\|calendar\|stats\|nudges\|eat-the-frog\|task-jar\|dopamine` | Optional `--date`                                   |
| `data export\|import-preview\|import\|backup\|restore`                                      | File paths for bodies/artifacts                     |
| `status`                                                                                    | Owner connectivity                                  |
| `auth create\|list\|revoke`                                                                 | Operator credential admin                           |
| `server hosts get\|set`                                                                     | Host allowlist                                      |
| `server rotate-token`                                                                       | Writes new operator token to `--write-token` only   |
| `server diagnostics get\|clear`                                                             | Operator diagnostics ring                           |
| `server maintenance`                                                                        | Maintenance/restart status                          |
| `server recovery status`                                                                    | Recovery-mode probe                                 |

Examples:

```bash
junban task add "Ship Wave 2" --due-date 2030-01-15
junban --json task list --view today
junban task complete <task-uuid>
junban task delete <task-uuid> --confirm delete
junban project add "Rewrite"
junban plan daily --date 2030-01-15
junban data export --format json --output ./tasks.json
junban data backup --output ./profile.junban-backup
junban data restore --input ./profile.junban-backup --confirm restore
```

Human mutations print one compact receipt with the event, exact resource ID, revision, and operation ID; lists and planning commands print bounded rows/summaries. Use `--json` for complete typed documents and automation, or generic `tool call` when directly inspecting catalog payloads.

## JSON and error contract

- Success with `--json`: exactly one JSON value on stdout, trailing newline, nothing else.
- Failure with `--json`: exactly one JSON object `{"error":{"code","message",...}}` on stdout; exit code non-zero.
- Human mode: concise stdout for success; diagnostics on stderr.
- Error fields may include `request_id`, `retryable`, and `details` when the server provided them.
- Exit codes: `0` success, `1` runtime, `2` usage, `3` busy, `4` auth.

Raw backup/export bytes never mix with JSON stdout. Download tools require an `output_path` (or `--output`) and refuse overwrite unless `overwrite=true` / `--overwrite`.

## IDs, dates, and instants

- Resource IDs are exact UUID strings. There is no fuzzy project/tag name lookup.
- Civil dates use `YYYY-MM-DD`.
- Instants use RFC 3339 with an offset or `Z`.

## Destructive confirmation

Non-interactive only. No browser or native prompts.

| Action                       | Flag                     |
| ---------------------------- | ------------------------ |
| delete                       | `--confirm delete`       |
| restore                      | `--confirm restore`      |
| clear diagnostics            | `--confirm clear`        |
| rotate operator token        | `--confirm rotate-token` |
| revoke automation credential | `--confirm revoke`       |

Generic `tool call` uses the same `confirm` field inside JSON input when the catalog marks the tool destructive. Bulk task calls require `confirm:"delete"` only when `action.type` is `delete`; the confirmation field is removed before the HTTP request.

## Credentials

```bash
junban auth create --name agent --scope read --scope write --write-token ./agent.token
junban auth list
junban auth revoke <credential-id> --confirm revoke
```

Creation writes the one-time secret only to `--write-token` (owner-private, never overwrites). Stdout/JSON never include the raw token. Explicit remote use:

```bash
junban --server https://junban.example --credential-file ./agent.token --json task list
```

## Operator rotation, restore, and restart

`server rotate-token` reserves the owner-private destination and persists its operation ID before contacting the server. If the result is ambiguous or the final token write fails, rerun the same command with the same `--write-token` path; Junban replays the durable receipt and writes the exact issued token. Do not delete the empty reservation or its adjacent pending-state file while recovery is pending.

`data restore` is operator-only, never auto-retried, and returns `restart_required: true` on success. If it returns `restore_outcome_unknown`, do not repeat it blindly: restart Junban and inspect maintenance/recovery status first. After a successful restore, restart the owning server/process before normal traffic.

## Troubleshooting

| Symptom                          | Likely cause                                                              |
| -------------------------------- | ------------------------------------------------------------------------- |
| `profile_busy`                   | Another process holds the profile lock without reachable runtime metadata |
| `server_cleartext_forbidden`     | Non-loopback `--server` used `http://`                                    |
| `credential_file_required`       | Explicit `--server` without credential file                               |
| `confirmation_required`          | Missing destructive `--confirm` value                                     |
| `output_exists`                  | Download path exists; pass `--overwrite` / `overwrite=true`               |
| `redirect_rejected`              | Target issued a redirect; bearer is never followed                        |
| `token_rotation_outcome_unknown` | Rerun rotation with the same output path to replay its durable receipt    |
| `restore_outcome_unknown`        | Restart and inspect maintenance/recovery status before any retry          |

See also [`architecture.md`](architecture.md), [`security.md`](security.md), and [`setup.md`](setup.md).
