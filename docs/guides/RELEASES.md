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

Branch model:

- `developer` is the integration branch for day-to-day work.
- `main` is the production branch and should stay releasable.
- Version tags must be created from commits that are already on `main`.

1. Update versions with `pnpm release:prepare <version>`.
2. Move the relevant items from `Unreleased` into a new version section in `CHANGELOG.md`.
3. Merge or promote the release candidate into `main`.
4. Commit and tag the release as `v<version>` from `main`.
5. Push the tag so GitHub Actions re-runs the quality gate, verifies the tag commit is on `main`, then builds installers and updater metadata.
6. Review the draft GitHub release before publishing.

## CI/CD Flow

- `CI` runs on pushes to `developer` and `main`, on pull requests targeting those branches, and on manual dispatch.
- The required quality gate is `Lint, Typecheck & Test`.
- `Build Web App` runs after the quality gate to catch production build breaks before merge.
- `Dependency Review` runs on pull requests to flag risky dependency updates.
- `Release` can run from a pushed tag or manual dispatch, but it only proceeds when the tag resolves to a commit already present on `main`.

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
