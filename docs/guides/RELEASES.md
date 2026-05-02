# Releases & Updates

This guide describes how Junban desktop releases, in-app updates, changelog entries, and local data storage work today.

## What Ships to Users

- Linux desktop installers are published on the GitHub Releases page.
- Linux users can download and run `scripts/install-linux.sh` from the raw GitHub URL to install the latest `.deb` on Debian/Ubuntu or the latest AppImage elsewhere. The `.deb` path may ask for `sudo`; the AppImage path installs under the user's home directory without `sudo`.
- Tauri update metadata is served from `releases/latest/download/latest.json`.
- The desktop app checks that metadata from `Settings -> About`.
- When an update is available, the app can download, install, and relaunch itself.
- The release workflow now fails if package metadata still uses pre-Junban branding, if uploaded Linux installer asset names still expose stale visible `ASF Junban` branding, or if `latest.json` is missing from the draft release.

## Branding Boundaries

- User-visible names should be `Junban` in window titles, launcher entries, installer asset names, and release titles.
- Technical identifiers such as the npm/Cargo package name `asf-junban` and bundle identifier `com.asf.junban` intentionally keep the owner namespace for upgrade continuity and collision avoidance.

## Where User Data Lives

### Desktop App

- Primary database path: `AppData/Junban/junban.db`
- This is the SQLite database used by packaged Tauri installs, including the current sidecar-backed desktop runtime.
- The app creates the directory automatically on first run.

## Desktop Backend Upgrade Notes

- Packaged desktop releases now bundle the Node backend as a localhost sidecar.
- Existing packaged installs still use the same AppData SQLite file, so normal upgrades should migrate in place without export/import or manual database moves.
- Repo dev/profile data (`./data/dev/junban.db`, `./tasks/dev/`) stays separate from packaged AppData data; do not treat source-run dev data as the packaged upgrade path.
- Existing desktop grandfathering/compatibility behavior for legacy built-in plugins is unchanged by this runtime shift.
- If an upgraded packaged build reports that the desktop backend is unavailable, validate the bundled sidecar assets first and avoid deleting the AppData database unless you have a backup and a separate reason to suspect database corruption.

### Development / Server Mode

- Repo-run dev commands use `JUNBAN_PROFILE=dev` automatically.
- Default dev database path: `./data/dev/junban.db`
- Override with `DB_PATH` in `.env`
- If no profile is set, `daily` is used. On Linux, unset daily paths follow XDG data defaults: `$XDG_DATA_HOME/junban/junban.db` or `~/.local/share/junban/junban.db`. On other platforms, the fallback daily path remains `./data/junban.db`.

### Markdown Storage Mode

- Optional alternative backend controlled by `STORAGE_MODE=markdown`
- Daily default markdown path on Linux: `$XDG_DATA_HOME/junban/tasks` or `~/.local/share/junban/tasks`
- Set `MARKDOWN_PATH=./tasks/` explicitly if you want repo-local daily Markdown storage on Linux.
- Daily default markdown path on other platforms: `./tasks/`
- Dev-profile default markdown path: `./tasks/dev/`
- Switching backends does not migrate data automatically; use export/import when changing modes.

## Changelog Source of Truth

- `CHANGELOG.md` is the internal and public source of truth.
- Entries are versioned using Keep a Changelog sections.
- GitHub release notes should match the relevant version section from `CHANGELOG.md`.

## Release Flow

1. Merge day-to-day work into `developer` until the release candidate is stable.
2. Open a promotion PR from `developer` into `main`.
3. Update versions with `pnpm release:prepare <version>` and move the relevant items from `Unreleased` into a new version section in `CHANGELOG.md` as part of that promotion.
4. Merge the promotion PR into `main`.
5. Tag the merged `main` commit as `v<version>`.
6. Push the tag so GitHub Actions builds Linux installers and updater metadata.
7. Let the release workflow verify the tagged commit branding metadata and the uploaded draft assets.
8. Review the draft GitHub release before publishing.

## Branch Roles

- `developer` is the integration branch for active work.
- `main` is the production branch and the only branch that should receive release tags.
- The release workflow fails if a `v*` tag does not point to a commit in `main` history.

## CI/CD Flow

- `CI` runs on pushes to `developer` and `main`, and on pull requests targeting those branches.
- The required quality gate is `Lint, Typecheck, Test & Packaging Smoke`.
- Normal CI now runs `pnpm build`, `pnpm tauri:prepare-sidecar`, and `pnpm tauri:validate-sidecar` so pull requests fail before merge if the packaged desktop sidecar cannot be staged correctly.
- Local `pnpm tauri:build` runs the same sidecar validation before Tauri bundles desktop artifacts.
- `Dependency Review` runs on pull requests to flag risky dependency updates.
- `Release` can run from a pushed tag or manual dispatch, but it only proceeds when the tag resolves to a commit already present on `main`.
- `Release` now also verifies package metadata still says `Junban`, blocks stale visible `ASF Junban` Linux installer asset names, and confirms the draft release includes `.deb`, AppImage, and `latest.json` assets before publishing.

## Current Limits

- Update checks are desktop-only.
- Release notes shown in-app depend on the updater metadata / release body.
- Automated release publishing is Linux-only for now. Windows and macOS builds should move to separate optional workflows once their packaging path is stable.
- We do not yet publish checksums or detached verification steps in the README.
- Linux package-manager based installs are not yet supported as an update channel; the install helper fetches release assets but does not configure an apt/yum/dnf repository.

## Alpha Checklist

- Confirm desktop install works on each target OS.
- Confirm the packaged app reaches a ready desktop-backend state after install/update (not just the splash/error shell).
- Create, edit, complete, delete, and export real tasks using the packaged app.
- Verify data still exists after restart.
- Verify an upgrade from the previous packaged release keeps the existing AppData database without manual migration steps.
- If packaging/runtime code changed, run `pnpm tauri:prepare-sidecar && pnpm tauri:validate-sidecar` before tagging and confirm CI passed the same smoke validation. The validation smoke now covers both a fresh packaged startup and a legacy schemaful AppData-style database that lacks `__drizzle_migrations`, so the upgrade path stays exercised alongside the clean-install path.
- Test one release-to-release in-app update on a real install.
- Review `CHANGELOG.md` before every tagged release.
