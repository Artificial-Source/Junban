# Build your first Junban plugin

This tutorial creates a minimal community plugin using the repository's built-in scaffold and wires a working command into Junban.

## What you'll build

You will:

- create a new plugin directory with `manifest.json` and `index.mjs`
- register a simple command in `onLoad()`
- restart Junban and see the plugin registered

## Prerequisites

- repository setup is done (see [`../guides/SETUP.md`](../guides/SETUP.md))
- you can run `pnpm dev` or use the app against the same profile you want the plugin to use
- your environment has permissions to create files under `plugins/`

## 1) Scaffold the plugin files

From the repo root, run:

```bash
pnpm plugin:create my-plugin
```

This runs `scripts/create-plugin.ts` and creates:

- `plugins/my-plugin/manifest.json`
- `plugins/my-plugin/index.mjs`

The command supports only lowercase IDs with digits and hyphens (for example `my-plugin`) and rejects names that are too short/long.

## 2) Inspect scaffolded files

Open `plugins/my-plugin/manifest.json` first.

You should see:

- `id`, `name`, `version`, `author`, `description`
- `main: "index.mjs"`
- default `permissions` and optional `settings`

Then open `plugins/my-plugin/index.mjs`.

The scaffold exports a class with:

- `onLoad()` (called when the plugin activates)
- `onUnload()` (called when it is deactivated)

It also registers a sample command under `this.app.commands.register(...)`.

## 3) Edit metadata and behavior

Edit `manifest.json`:

- set `author` and `description`
- keep `minJunbanVersion` aligned with your repo version if needed
- retain at least the `commands` permission if you keep the sample command

Edit `index.mjs`:

- replace the sample command `id` and `name` with your own
- replace the callback body with your desired behavior

Keep runtime code simple while you are learning.

## 4) Restart and verify

After saving changes, fully stop and restart Junban. Community plugins are discovered at startup, so normal frontend hot reload is not enough for plugin changes.

Before you verify the command, make sure community plugins are allowed and the plugin's requested permissions are approved. The loader in `src/plugins/loader.ts` skips community plugins when `community_plugins_enabled` is not enabled, and it also skips requested permissions until approval is recorded.

Then run your command from the command palette/launcher flow available in Junban.

If your plugin does not load:

- confirm files are under `plugins/<id>/`
- confirm `manifest.json` is valid JSON
- ensure `main` matches an existing file

## 5) Next steps

When this works, move to:

- `this.app` API reference in [`../reference/plugins/API.md`](../reference/plugins/API.md)
- example plugins in [`../reference/plugins/EXAMPLES.md`](../reference/plugins/EXAMPLES.md)
- runtime behavior and permissions internals in [`../reference/backend/PLUGINS.md`](../reference/backend/PLUGINS.md)

If you want to customize the scaffold itself, the source is [`../../scripts/create-plugin.ts`](../../scripts/create-plugin.ts).
