# Releases & Updates

This guide describes how ASF Junban desktop releases, in-app updates, changelog entries, and local data storage work today.

## What Ships to Users

- Desktop installers are published on the GitHub Releases page.
- Tauri update metadata is served from `releases/latest/download/latest.json`.
- The desktop app checks that metadata from `Settings -> About`.
- When an update is available, the app can download, install, and relaunch itself.

## Where User Data Lives

### Desktop App

- Primary database path: `AppData/ASF Junban/junban.db`
- This is the SQLite database used by packaged Tauri installs.
- The app creates the directory automatically on first run.

### Development / Server Mode

- Repo-run dev commands use `JUNBAN_PROFILE=dev` automatically.
- Default dev database path: `./data/dev/junban.db`
- Override with `DB_PATH` in `.env`
- If no profile is set, the fallback daily path remains `./data/junban.db`

### Markdown Storage Mode

- Optional alternative backend controlled by `STORAGE_MODE=markdown`
- Daily default markdown path: `./tasks/`
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
6. Push the tag so GitHub Actions builds installers and updater metadata.
7. Review the draft GitHub release before publishing.

## Branch Roles

- `developer` is the integration branch for active work.
- `main` is the production branch and the only branch that should receive release tags.
- The release workflow fails if a `v*` tag does not point to a commit in `main` history.

## Current Limits

- Update checks are desktop-only.
- Release notes shown in-app depend on the updater metadata / release body.
- We do not yet publish checksums or detached verification steps in the README.
- Linux package-manager based installs are not yet supported as an update channel.

## Alpha Checklist

- Confirm desktop install works on each target OS.
- Create, edit, complete, delete, and export real tasks using the packaged app.
- Verify data still exists after restart.
- Test one release-to-release in-app update on a real install.
- Review `CHANGELOG.md` before every tagged release.
