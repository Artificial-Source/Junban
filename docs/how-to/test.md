# Run tests for Junban

This page is a task-focused guide for running validation checks after code or configuration changes.

## Fast path commands

Use these scripts from the repo root:

```bash
pnpm test             # Vitest (unit + ui + plugin-ui projects)
pnpm test:watch       # Watch mode for Vitest
pnpm test:coverage    # Vitest with coverage
pnpm test:e2e         # Playwright browser tests
pnpm test:perf        # Playwright performance spec
pnpm check            # lint + format:check + typecheck + test
```

## What each test stack checks

- **Vitest (`pnpm test`)** reads `vitest.config.ts` and runs three projects:
  - `unit` (`tests/**/*.test.ts`, `tests/**/*.test.tsx` excluding ui-focused test trees)
  - `ui` (`tests/ui/**/*.test.ts`, `tests/ui/**/*.test.tsx`)
  - `plugin-ui` (`tests/**/components/**/*.test.tsx`)
- **Playwright (`pnpm test:e2e`)** runs tests from `tests/e2e` using `playwright.config.ts`.
- **Performance (`pnpm test:perf`)** is a specific Playwright spec for performance (`tests/e2e/performance.spec.ts`).
- **`pnpm check`** includes the repository validation set from `package.json` (`lint`, `format:check`, `typecheck`, `test`).

## Typical quick flow for feature changes

1. Run targeted unit tests by command change area (`pnpm test`) to validate behavior.
2. If you touched UI behavior, run at least `pnpm test` and `pnpm test:e2e`.
3. Before handing off, run `pnpm check`.

## Helpful verification targets

- MCP behavior changes: `tests/mcp/*.test.ts`
- Plugin runtime-facing behavior: `tests/ui/api/plugins.test.ts`, `tests/ui/api/plugins.policy-sync.test.ts`
- Storage/backend regressions: `tests/storage/**/*.test.ts`, `tests/db/**/*.test.ts`

## Related docs

- Test runner config: [`../../vitest.config.ts`](../../vitest.config.ts)
- Browser test config: [`../../playwright.config.ts`](../../playwright.config.ts)
- Development setup (profile defaults and scripts): [`../guides/SETUP.md`](../guides/SETUP.md)
