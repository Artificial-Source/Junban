# How to install Junban

Use this page when you want to get Junban installed for local use.

## What you get

- A local web app you can run from source (`pnpm dev` / `pnpm dev:full`)
- Optional desktop app workflow with Tauri (`pnpm tauri:dev`, `pnpm tauri:build`)
- CLI and MCP entrypoints from the same source tree, plus packaged `junban` and `junban-mcp` commands after a built install

## Install options

### Option A: Use published desktop installer (fastest for use)

If you just want to run the app and not modify source, use the release page:

- [GitHub Releases](https://github.com/Artificial-Source/Junban/releases/latest)

Assets include `.exe/.msi` for Windows, `.dmg` for macOS, and `.deb`/`.AppImage` for Linux.

On Linux, run the installer helper to fetch the latest release and choose the right asset for your distro:

```bash
install_script="$(mktemp)"
curl -fsSL -o "$install_script" https://raw.githubusercontent.com/Artificial-Source/Junban/main/scripts/install-linux.sh
sh "$install_script"
rm -f "$install_script"
```

The helper installs the `.deb` on Debian/Ubuntu systems and installs the portable AppImage under `~/Applications` elsewhere. The `.deb` path explains and asks before using `sudo` because `apt-get` installs a system package. Use the AppImage path for an install under your home directory without `sudo`.

You can force either path with an explicit argument:

```bash
install_script="$(mktemp)"
curl -fsSL -o "$install_script" https://raw.githubusercontent.com/Artificial-Source/Junban/main/scripts/install-linux.sh
sh "$install_script" --deb # or: --appimage
rm -f "$install_script"
```

### Option B: Run from source (developer and power-user path)

1. Install prerequisites from [Local Development Setup](../guides/SETUP.md).
2. Clone and install:

   ```bash
   git clone https://github.com/Artificial-Source/Junban.git
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
- In the app, Settings → Agent Tools can copy or download the MCP config and a short agent skill file for other AI assistants.

## Upgrading an existing desktop install

- Packaged desktop builds now run through a bundled localhost Node sidecar backend.
- Normal upgrades still keep the same AppData SQLite database (`AppData/Junban/junban.db`), so you should not need export/import or manual schema steps just because of the desktop-backend shift.
- Source-run dev data under `data/dev/` remains separate from packaged AppData data.
- Existing desktop compatibility/grandfathering behavior for legacy built-in plugins is unchanged by this runtime change.

## If the packaged desktop app says the backend failed to start

1. Fully quit the app and launch it again.
2. Reinstall from the latest release if the app was partially updated or unpacked incorrectly.
3. Make sure local loopback traffic (`127.0.0.1` / `localhost`) is not being blocked by firewall or endpoint-security tooling.
4. Keep your AppData database in place unless you already have a backup and a separate reason to suspect database corruption.

## Next steps

- Configure storage, logging, and ports in [How to configure Junban](configure.md).
- Run your first workflow from [First-run tutorial](../tutorials/first-run.md).
