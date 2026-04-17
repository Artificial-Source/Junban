# Maintainer Workflow

This guide is the repo-level quick reference for maintainers operating Junban without GitHub branch protection rules.

## Branch Roles

- `developer` is the integration branch for normal work.
- `main` is the production branch.
- Release tags (`v<version>`) must be created from commits on `main`.

## Normal Flow

1. Ask contributors to open normal feature, fix, docs, plugin, and test PRs against `developer`.
2. Keep `main` reserved for release promotions and production hotfixes.
3. Merge `developer` into `main` only when the release candidate is ready.
4. Tag the merged `main` commit as `v<version>` to publish installers and updater metadata.

## Production Hotfixes

1. Branch from `main`.
2. Keep the fix as small as possible.
3. Merge the hotfix into `main`.
4. Merge or cherry-pick the same fix back into `developer` immediately after.

## Maintainer Checklist

Before merging into `developer`:

- Confirm the PR is not really a release promotion or production hotfix.
- Confirm CI passed.
- Confirm docs were updated when behavior, APIs, workflows, or structure changed.
- Confirm documentation routing follows `docs/README.md` and the domain indexes (`docs/reference/README.md`, `docs/product/README.md`, and `docs/internal/README.md`) when relevant.

Before merging into `main`:

- Confirm the PR is either a promotion from `developer` or a true production hotfix.
- Confirm release notes / changelog updates are included when preparing a release.
- Confirm the PR template branch checklist was completed accurately.

Before tagging a release:

- Confirm the target commit is already on `main`.
- Confirm the version and `CHANGELOG.md` entries are correct.
- Confirm the desktop release is intended to go public.
- Review legacy compatibility stubs and decide whether they should be retained or retired for the next cycle.

## GitHub Templates In This Repo

- Default PR template: `.github/pull_request_template.md`
- Release promotion PR template: `.github/PULL_REQUEST_TEMPLATE/release_promotion.md`
- Production hotfix PR template: `.github/PULL_REQUEST_TEMPLATE/production_hotfix.md`
- Release tracking issue template: `.github/ISSUE_TEMPLATE/release_tracking.yml`
- Production hotfix issue template: `.github/ISSUE_TEMPLATE/production_hotfix.yml`

Use the specialized PR templates when opening release-promotion or hotfix PRs so the branch flow is explicit during review.

Recommended labels for maintainers:

- `release`
- `hotfix`
- `bug`
- `enhancement`

Issue templates can suggest labels in-repo, but the labels themselves still need to exist in GitHub repository settings.
