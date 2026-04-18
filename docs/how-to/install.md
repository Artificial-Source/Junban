# How to install Junban

Use this page when you want to get Junban installed for local use.

## What you get

- A local web app you can run from source (`pnpm dev` / `pnpm dev:full`)
- Optional desktop app workflow with Tauri (`pnpm tauri:dev`, `pnpm tauri:build`)
- CLI and MCP entrypoints from the same source tree

## Install options

### Option A: Use published desktop installer (fastest for use)

If you just want to run the app and not modify source, use the release page:

- [GitHub Releases](https://github.com/Artificial-Source-Foundation/Junban/releases/latest)

Assets include `.exe/.msi` for Windows, `.dmg` for macOS, and `.deb`/`.AppImage` for Linux.

### Option B: Run from source (developer and power-user path)

1. Install prerequisites from [Local Development Setup](../guides/SETUP.md).
2. Clone and install:

   ```bash
   git clone https://github.com/Artificial-Source-Foundation/Junban.git
   cd Junban
   pnpm install
   ```

3. If you want a local config file for frontend-side defaults, copy the example environment file:

    ```bash
    cp .env.example .env
    ```

   The current Node entrypoints still read `process.env` directly, so non-default values for `pnpm db:migrate`, `pnpm server`, `pnpm cli`, and `pnpm mcp` should be exported in your shell or passed inline.

4. Prepare the default SQLite development database:

    ```bash
    mkdir -p data/dev
    pnpm db:migrate
    ```

5. Start either:

   - Web only: `pnpm dev`
   - Full stack (UI + standalone API): `pnpm dev:full`

   (See [How to run Junban locally](run-locally.md).)

## Optional desktop prerequisites

Install these only if you want `pnpm tauri:dev` or `pnpm tauri:build`:

- Rust (stable)
- Tauri CLI 2.x

When installed, you can use the desktop scripts listed in `package.json` and referenced in [Local Development Setup](../guides/SETUP.md).

## Notes

- The install path is project-local. Source-run data is isolated under `data/dev` via default profile behavior.
- The data location for your packaged desktop install is managed by Tauri AppData, not this repository tree.

## Next steps

- Configure storage, logging, and ports in [How to configure Junban](configure.md).
- Run your first workflow from [First-run tutorial](../tutorials/first-run.md).
