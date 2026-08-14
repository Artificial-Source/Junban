# Junban MCP

Native `junban-mcp` stdio server over the shared CLI session, HTTP executor, and versioned automation catalog. Stdout is MCP JSON-RPC frames only. Diagnostics stay on stderr. There is no second database path and no detached daemon.

## Install and build

```bash
cargo build --release -p junban-mcp
# binary: target/release/junban-mcp
```

Node is not required at runtime.

## Client configuration

### Local profile (auto-discover or temporary owner)

```json
{
  "mcpServers": {
    "junban": {
      "command": "/absolute/path/to/junban-mcp",
      "args": ["--data-dir", "/absolute/path/to/profile"]
    }
  }
}
```

Without `--server`, Junban reads private `runtime.json`, requires loopback, probes health, and matches `instance_id` before loading the operator token. If discovery fails, the process starts one in-process API-only owner after acquiring the exclusive profile lock and releases it on EOF or signal shutdown.

### Explicit server + scoped credential

```bash
junban auth create --name agent --scope read --scope write --write-token ./agent.token
```

```json
{
  "mcpServers": {
    "junban": {
      "command": "/absolute/path/to/junban-mcp",
      "args": [
        "--server",
        "https://junban.example",
        "--credential-file",
        "/absolute/path/to/agent.token"
      ],
      "env": {
        "JUNBAN_CREDENTIAL_FILE": "/absolute/path/to/agent.token"
      }
    }
  }
}
```

Rules:

- Explicit `--server` never uses the profile operator token.
- Credential file is required (`--credential-file` or `JUNBAN_CREDENTIAL_FILE`).
- URL userinfo/fragments are rejected. Non-loopback targets require HTTPS. Redirects are never followed with a bearer attached.
- Raw tokens must never appear in argv logs, MCP results, resources, prompts, or chat.

## Scopes and authorization

Automation scopes are exact: `read`, `write`, and `data` do not imply each other. Request both `read` and `write` for routine agents; add `data` only when export/backup is required.

On every `tools/list`, `tools/call`, resource list/read, and prompt list/get, MCP asks the live server `GET /api/v1/auth/principal` for principal kind and scope names only (never ids/tokens). Local credential-file metadata is not trusted after connect.

| Principal                                  | Tools listed                   | Notes                                                     |
| ------------------------------------------ | ------------------------------ | --------------------------------------------------------- |
| Operator (local discovery/temporary owner) | All non-operator catalog tools | Operator-only recovery/security tools never appear in MCP |
| Automation `read`                          | Read tools only                | Resources and read prompts available                      |
| Automation `write`                         | Write tools only               | No resources or prompts (prompts need `read`)             |
| Automation `data`                          | Data tools only                | Export/backup style tools                                 |
| Revoked / invalid                          | Fail closed                    | Next list/call fails; no stale authorization              |

Guessed operator or out-of-scope tool names are rejected as unknown (`invalid_params`). Tool execution failures return structured JSON errors derived from the shared CLI error envelope.

## Resources

Listed only when the live principal has `read`:

| URI                 | Contents                 |
| ------------------- | ------------------------ |
| `junban://profile`  | Profile revision summary |
| `junban://sync`     | Sync epoch/revision      |
| `junban://today`    | Today task list          |
| `junban://projects` | Projects list            |
| `junban://tags`     | Tags list                |
| `junban://settings` | Typed settings           |

Templates (also require `read`):

| URI template                     | Contents                                |
| -------------------------------- | --------------------------------------- |
| `junban://tasks/{task_id}`       | Exact-ID task                           |
| `junban://projects/{project_id}` | Matching project plus its sections only |

URI forms are strict: exact path, UUID ids where required, no query/fragment/trailing segments. Serialized resource bodies are capped at 2 MiB.

## Prompts

| Prompt          | Required scopes | Optional args                                      |
| --------------- | --------------- | -------------------------------------------------- |
| `plan-my-day`   | `read`          | `date` (`YYYY-MM-DD`), `capacity` (1–1440 minutes) |
| `triage-inbox`  | `read`          | `limit` (1–100)                                    |
| `weekly-review` | `read`          | `date` (`YYYY-MM-DD`)                              |

Prompts return bounded instructions plus live JSON context gathered through shared read tools. They never mutate data themselves. Civil dates are validated as real calendar days. `plan-my-day` lists tasks due on the selected date (or Today when omitted). `weekly-review` stats use the `week_start`/`week_end` returned by planning. Unknown arguments are rejected.

## Tools

MCP exposes every shared catalog tool the live principal may use, excluding operator-only entries. Input/output JSON Schemas match the catalog exactly. Safety annotations set `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint=false`.

`tools/call` enforces a 2 MiB argument ceiling after JSON decode and a 2 MiB ceiling on the complete serialized `CallToolResult` wire body (structured content plus duplicated text content). Oversized success payloads become small structured `result_too_large` tool errors. Local catalog planning validates wrapper/path fields once, then execution uses that single plan so mutation operation IDs are not regenerated. Destructive catalog tools still require their catalog `confirm` field where applicable.

For genuinely disk-staged data tools (`export_tasks`, `create_backup`), if the request carries a progress token, MCP emits bounded start and completion progress notifications only after local planning/wrapper validation succeeds and immediately before disk-staged dispatch. Invalid staged inputs therefore produce zero progress frames. Import preview/apply are bounded in-memory operations and do not emit staged progress.

## Lifecycle and secrecy

- Stdout: MCP JSON-RPC frames only. Never print tokens, bearer headers, or human diagnostics there.
- Stderr: tracing/diagnostics only.
- EOF on stdin, SIGINT, and SIGTERM cancel the service, shut down the shared session/temporary owner, release the profile lock, and remove or leave safely recoverable runtime metadata.
- Request cancellation covers live principal discovery, session-mutex acquisition, and tool/resource/prompt execution so a cancelled request cannot block following calls, EOF/signal shutdown, or owner lock release. Once an HTTP mutation has already been admitted server-side, the client treats the outcome as unknown; server idempotency and cleanup remain authoritative and cancellation does not guarantee removal of server-staged files mid-flight.

## Related docs

- [`cli.md`](cli.md): catalog, ergonomic commands, credential creation
- [`security.md`](security.md): bearer, scopes, and secret handling
- [`architecture.md`](architecture.md): ownership and crate boundaries
- [`.agents/skills/junban/SKILL.md`](../.agents/skills/junban/SKILL.md): agent usage skill
