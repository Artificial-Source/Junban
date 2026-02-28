# Local Development Setup

Step-by-step guide to get ASF Saydo running on your machine.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22+ | [nodejs.org](https://nodejs.org/) or `nvm install 22` |
| pnpm | 10+ | `npm install -g pnpm` or `corepack enable` |
| Git | 2.x | [git-scm.com](https://git-scm.com/) |

### Optional (for desktop app)

| Tool | Version | Install |
|------|---------|---------|
| Rust | latest stable | [rustup.rs](https://rustup.rs/) |
| Tauri CLI | 2.x | `cargo install tauri-cli` |

Rust and Tauri are only needed if you want to build the desktop app. The web UI runs without them.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/asf-org/saydo.git
cd saydo
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

The defaults work out of the box. Edit `.env` if you want to change:
- `DB_PATH` — where the SQLite database is stored (default: `./data/saydo.db`)
- `STORAGE_MODE` — `sqlite` (default) or `markdown`
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error`

### 4. Set Up the Database

```bash
mkdir -p data
pnpm db:migrate
```

This creates the SQLite database and runs all migrations.

### 5. Run the Dev Server

```bash
pnpm dev
```

The app is now running at `http://localhost:5173` with hot module replacement (HMR).

### 6. Create Your First Task

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
pnpm dev             # Start dev server with HMR
pnpm build           # Build for production
pnpm start           # Preview production build
pnpm test            # Run tests
pnpm test:watch      # Run tests in watch mode
pnpm test:coverage   # Run tests with coverage
pnpm lint            # Run ESLint
pnpm lint:fix        # Fix lint issues
pnpm typecheck       # TypeScript type checking
pnpm check           # Run lint + typecheck + test (all at once)
pnpm db:generate     # Generate a new migration after schema change
pnpm db:migrate      # Apply pending migrations
pnpm cli             # Run CLI companion
pnpm mcp             # Start MCP server (for external AI agents)
pnpm tauri:dev       # Run desktop app in dev mode (requires Rust)
pnpm tauri:build     # Build desktop app binary (requires Rust)
```

## Using the MCP Server

The MCP server lets external AI agents (Claude Desktop, personal assistants, other apps) manage your tasks over the Model Context Protocol.

```bash
pnpm mcp
```

### Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "saydo": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/saydo", "mcp"]
    }
  }
}
```

Restart Claude Desktop. You can now ask Claude to manage your tasks:
- "Create a task to review the PR by Friday"
- "What's on my plate today?"
- "Mark the groceries task as done"

### Custom Agent Integration

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--dir", "/path/to/saydo", "mcp"],
});
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// Call tools, read resources, use prompts
await client.callTool({ name: "create_task", arguments: { title: "Hello from MCP" } });
```

See [MCP documentation](../backend/MCP.md) for the full reference (34 tools, 8 resources, 3 prompts).

## Building the Desktop App (Optional)

Requires Rust and Tauri CLI (see [Prerequisites](#prerequisites)).

```bash
# Development
pnpm tauri:dev

# Build distributable
pnpm tauri:build
```

Produces platform-specific installers in `src-tauri/target/release/bundle/`.

## Working with Plugins

### Installing a Plugin

Place plugin directories in `plugins/`:

```bash
plugins/
└── my-plugin/
    ├── manifest.json
    └── index.ts
```

Restart the dev server. The plugin appears in Settings > Plugins.

### Creating a Plugin

See [Plugin API](../plugins/API.md) for the full API reference and [Plugin Examples](../plugins/EXAMPLES.md) for walkthroughs.

Quick start:

```bash
mkdir -p plugins/my-plugin
```

Create `plugins/my-plugin/manifest.json`:
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Does something cool",
  "main": "index.ts",
  "minSaydoVersion": "1.0.0",
  "permissions": ["commands"]
}
```

Create `plugins/my-plugin/index.ts`:
```typescript
import { Plugin } from "@asf-saydo/plugin-api";

export default class MyPlugin extends Plugin {
  async onLoad() {
    this.app.commands.register({
      id: "my-plugin:hello",
      name: "Say Hello",
      callback: () => alert("Hello!"),
    });
  }

  async onUnload() {}
}
```

## Troubleshooting

### Database errors on startup

```bash
# Delete the database and re-migrate
rm -rf data/
mkdir -p data
pnpm db:migrate
```

### Port already in use

Edit `PORT` in `.env` or kill the process using port 5173:
```bash
lsof -i :5173 | grep LISTEN
kill <PID>
```

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
