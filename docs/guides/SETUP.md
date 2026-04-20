# Local Development Setup

Step-by-step guide to get ASF Junban running on your machine.

## Prerequisites

| Tool    | Version | Install                                               |
| ------- | ------- | ----------------------------------------------------- |
| Node.js | 22+     | [nodejs.org](https://nodejs.org/) or `nvm install 22` |
| pnpm    | 10+     | `npm install -g pnpm` or `corepack enable`            |
| Git     | 2.x     | [git-scm.com](https://git-scm.com/)                   |

### Optional (for desktop app)

| Tool      | Version       | Install                         |
| --------- | ------------- | ------------------------------- |
| Rust      | latest stable | [rustup.rs](https://rustup.rs/) |
| Tauri CLI | 2.x           | `cargo install tauri-cli`       |

Rust and Tauri are only needed if you want to build the desktop app. The web UI runs without them.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Artificial-Source/Junban.git
cd Junban
```

### 2. Install Dependencies

```bash
corepack enable
pnpm install
```

### 3. Bootstrap the Dev Environment

```bash
pnpm setup:dev
```

This helper does the common first-run setup for you:

- creates `.env` from `.env.example` if needed
- ensures the dev data directories exist
- runs database migrations for the default dev profile

If you prefer a single command from a fresh machine:

```bash
git clone https://github.com/Artificial-Source/Junban.git && cd Junban && corepack enable && pnpm install && pnpm setup:dev && pnpm dev
```

### 4. Configure Environment Manually (Optional)

```bash
cp .env.example .env
```

The defaults work out of the box. Edit `.env` if you want to change:

- `JUNBAN_PROFILE` — storage profile (`daily` by default; repo dev commands use `dev` automatically)
- `DB_PATH` — where the SQLite database is stored (default: `./data/junban.db`)
- `STORAGE_MODE` — `sqlite` (default) or `markdown`
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error`

Repo-run development commands automatically use the `dev` profile, which keeps local testing data separate from your packaged desktop install. By default that means:

- `pnpm dev:full`, `pnpm server`, `pnpm db:migrate`, `pnpm cli`, `pnpm mcp`, and `pnpm tauri:dev` use `./data/dev/junban.db`
- `STORAGE_MODE=markdown` in those same commands uses `./tasks/dev/`
- Packaged desktop builds still store data in Tauri AppData

### 5. Set Up the Database Manually (Optional)

```bash
mkdir -p data/dev
pnpm db:migrate
```

This creates the SQLite database and runs all migrations for the active profile. With the default repo dev profile, that is `./data/dev/junban.db`.

### 6. Run the Dev Server

```bash
pnpm dev
```

The app is now running at `http://localhost:5173` with hot module replacement (HMR).

### 7. Create Your First Task

Open the app in your browser. You should see the inbox view. Type a task in the input field:

```
buy milk tomorrow at 3pm p1 #groceries +shopping
```

Press Enter. The task is created with:

- Title: "buy milk"
- Due: tomorrow at 3:00 PM
- Priority: P1 (highest)
- Tag: groceries
- Project: shopping (auto-created)

## Using the CLI

The CLI companion shares the same database as the web UI.

```bash
# Add a task
pnpm cli add "review PR by Friday p2 #dev"

# List tasks
pnpm cli list
pnpm cli list --today
pnpm cli list --project=work

# Complete a task
pnpm cli done <task-id>

# Edit a task
pnpm cli edit <task-id> --priority=1

# Delete a task
pnpm cli delete <task-id>
```

## Development Commands

```bash
pnpm dev             # Start browser dev server under the isolated dev profile
pnpm setup:dev       # Create .env, ensure dev dirs, and run migrations
pnpm build           # Build for production
pnpm start           # Preview production build
pnpm test            # Run tests
pnpm test:watch      # Run tests in watch mode
pnpm test:coverage   # Run tests with coverage
pnpm lint            # Run ESLint
pnpm lint:fix        # Fix lint issues
pnpm typecheck       # TypeScript type checking
pnpm check           # Run lint + format:check + typecheck + test (all at once)
pnpm db:generate     # Generate a new migration after schema change
pnpm db:migrate      # Apply migrations to the dev-profile database by default
pnpm cli             # Run CLI companion against the dev-profile database
pnpm mcp             # Start MCP server against the dev-profile database
pnpm tauri:dev       # Run desktop app in dev mode with isolated dev-profile data
pnpm tauri:build     # Build desktop app binary (requires Rust)
```

## Using the MCP Server

The MCP server lets external AI agents (Claude Desktop, personal assistants, other apps) manage your tasks over the Model Context Protocol.

### Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "junban": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/junban", "mcp"]
    }
  }
}
```

Restart Claude Desktop. Claude launches the Junban MCP server from that config entry, so you do not need a separate long-running `pnpm mcp` terminal for normal Claude Desktop usage.

You can now ask Claude to manage your tasks:

- "Create a task to review the PR by Friday"
- "What's on my plate today?"
- "Mark the groceries task as done"

### Custom Agent Integration

If you want a manual smoke test, run the server by itself:

```bash
pnpm mcp
```

If you are building your own MCP client, the stdio transport should launch `pnpm mcp` for you. In that case, do not start a second manual MCP server first.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--dir", "/path/to/junban", "mcp"],
});
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Call tools, read resources, use prompts
await client.callTool({ name: "create_task", arguments: { title: "Hello from MCP" } });
```

See [MCP documentation](../reference/backend/MCP.md) for the full reference. Tool, resource, and prompt inventories should follow the current registries rather than hardcoded counts.

## Building the Desktop App (Optional)

Requires Rust and Tauri CLI (see [Prerequisites](#prerequisites)).

```bash
# Development
pnpm tauri:dev

# Build distributable
pnpm tauri:build
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`.

Packaged installers use Tauri AppData rather than the repo's dev-profile paths, so you can keep a stable daily-use install alongside active development.

`pnpm tauri:dev` automatically stages the bundled desktop backend sidecar first. `pnpm tauri:build` now stages it and runs the packaged-runtime smoke validation before bundling. If you need to smoke-test that packaging input directly, run:

```bash
pnpm build
pnpm tauri:prepare-sidecar
pnpm tauri:validate-sidecar
```

If you want to override the defaults in `.env`, leave `DB_PATH` and `MARKDOWN_PATH` commented out unless you intentionally want a custom shared location.

## Working with Plugins

### Installing a Plugin

Junban discovers local community plugins from the `plugins/` directory. The scaffolded community plugin format uses `manifest.json` plus `index.mjs`.

```bash
plugins/
└── my-plugin/
    ├── manifest.json
    └── index.mjs
```

After adding or editing a community plugin, fully restart the app. Then use **Settings → Plugins** to enable community plugins and approve the plugin's requested permissions before expecting it to load.

### Creating a Plugin

See [Plugin API](../reference/plugins/API.md) for the full API reference and [Plugin Examples](../reference/plugins/EXAMPLES.md) for walkthroughs.

Quick start:

```bash
pnpm plugin:create my-plugin
```

This creates:

- `plugins/my-plugin/manifest.json`
- `plugins/my-plugin/index.mjs`

The scaffold comes from `scripts/create-plugin.ts`. It uses the current community-plugin entry format and default permissions.

For a full walkthrough, see [Build your first Junban plugin](../tutorials/your-first-plugin.md). For the full contract and examples, use [Plugin API](../reference/plugins/API.md) and [Plugin Examples](../reference/plugins/EXAMPLES.md).

## Troubleshooting

### Database errors on startup

```bash
# Delete only the dev-profile database and re-migrate
rm -f data/dev/junban.db
mkdir -p data/dev
pnpm db:migrate
```

### Port already in use

If port 5173 is already busy, stop the conflicting process first. The current local run instructions in this repository do not wire `.env` `PORT` through the Vite server configuration.

```bash
lsof -i :5173 | grep LISTEN
kill <PID>
```

### Desktop sidecar prep fails during `pnpm tauri:dev` or `pnpm tauri:build`

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm tauri:prepare-sidecar
pnpm tauri:validate-sidecar
```

If that still fails, inspect the first failing command in the sidecar-prep output before retrying the full Tauri build.

### pnpm install fails

```bash
# Clear pnpm cache and retry
pnpm store prune
rm -rf node_modules
pnpm install
```

### TypeScript errors after pulling

```bash
# Regenerate types
pnpm typecheck
# If schema changed, re-migrate
pnpm db:migrate
```
