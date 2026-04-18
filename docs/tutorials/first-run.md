# First Run: Your first Junban session

## Goal

Get a local Junban instance running and create your first task.

## Prerequisites

- Node.js 22+
- `pnpm` 10+
- Git

If you already have these, you can usually finish this in a short session. First install may take longer on some machines because `better-sqlite3` can require native binary download or compilation.

## Steps

### 1) Clone and install

```bash
git clone https://github.com/Artificial-Source-Foundation/Junban.git
cd Junban
pnpm install
```

### 2) Copy the environment file

```bash
cp .env.example .env
```

For this tutorial, the defaults are enough. Use `.env.example` as the configuration template, but note that Junban's Node entrypoints currently read `process.env` directly. If you need non-default values for commands such as `pnpm db:migrate`, `pnpm server`, `pnpm cli`, or `pnpm mcp`, export them in your shell or pass them inline.

### 3) Create the database

```bash
mkdir -p data/dev
pnpm db:migrate
```

The repo defaults the `dev` profile to `./data/dev/junban.db`. If you intentionally switch to `STORAGE_MODE=markdown`, this migration step is not the main setup path; see [How to configure Junban](../how-to/configure.md) for that storage mode.

### 4) Start Junban

```bash
pnpm dev
```

Open `http://localhost:5173`.

You should see the inbox with natural-language input in the task composer.

### 5) Create your first task

Type a full sentence:

```text
review PR by Friday p2 #work
```

Junban parses this into a task with metadata (title, due date, priority, and tags).

### 6) Confirm it is saved

Run one of the following from another terminal:

```bash
pnpm cli list
pnpm cli list --today
```

If you want to try CLI mode directly, no extra setup is required in this same profile.

## What changed in this first run

- You installed dependencies.
- You ran schema migration once.
- You started the local app.
- You verified persistence by creating and listing a task.

## Where to go next

- Continue learning with [Build your first Junban plugin](your-first-plugin.md).
- If you are now solving a specific task, start at [How-To Guides](../how-to/README.md).
- If you want source setup context, see [Local Development Setup](../guides/SETUP.md).
- If you are after deeper behavior, read the [Technical Reference](../reference/README.md).
