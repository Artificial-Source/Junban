## Release Promotion

- [ ] Source branch is `developer`
- [ ] Target branch is `main`
- [ ] Release scope has been stabilized on `developer`

## Release Preparation

- [ ] Ran `pnpm release:prepare <version>` or updated versions intentionally
- [ ] Moved release notes from `Unreleased` into a versioned `CHANGELOG.md` section
- [ ] Confirmed the version in `src-tauri/tauri.conf.json` and package metadata is correct

## Verification

- [ ] `pnpm check`
- [ ] Desktop packaging or release-specific verification completed if needed
- [ ] In-app updater impact reviewed for this release

## After Merge

- [ ] Tag the merged `main` commit as `v<version>`
- [ ] Push the tag to trigger the release workflow
- [ ] Review the draft GitHub release before publishing

## Notes

-
