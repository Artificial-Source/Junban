# Use the Junban CLI

This guide is for people who want fast, repeatable task operations from the terminal.

## Quick command

```bash
pnpm cli <command>
```

The executable comes from `src/cli/index.ts` and uses Commander.js command parsing.

The current CLI path reads configuration from `process.env`, so if you need non-default values such as `STORAGE_MODE=markdown`, export them in your shell or pass them inline when running the command.

## Add a task

```bash
pnpm cli add "buy milk tomorrow p1 #groceries +shopping"
```

CLI add uses natural-language parsing and auto-creates a project when `+project-name` is present.

## List tasks

```bash
pnpm cli list
pnpm cli list --today
pnpm cli list --project work
pnpm cli list --tag urgent
pnpm cli list --search "review PR"
```

You can also add `--json` to get machine-readable output.

## Complete, update, and delete by ID

```bash
pnpm cli done <task-id>
pnpm cli done <task-id> --json

pnpm cli edit <task-id> --title "buy almond milk"
pnpm cli edit <task-id> --priority 1
pnpm cli edit <task-id> --due "next friday"
pnpm cli edit <task-id> --description "bring change"

pnpm cli delete <task-id>
```

`edit` requires at least one field (`--title`, `--priority`, `--due`, or `--description`).

## Common notes

- `--json` output is available on the same core flows (`add`, `list`, `done`, `edit`, `delete`).
- `list` defaults to pending tasks.
- If an ID does not exist, commands fail with `Task not found` output.
- The CLI bootstrap path shares the same service layer as the web app (`bootstrap()`), so it works against the same profile/database configured for the process.

## Related docs

- Full CLI reference: [`../reference/backend/CLI.md`](../reference/backend/CLI.md)
- Development setup and profile behavior: [`../guides/SETUP.md`](../guides/SETUP.md)
- Command registration entrypoint: [`../../src/cli/index.ts`](../../src/cli/index.ts)
