# Sprint S45 — Module Decomposition II (God File Cleanup)

## Goal

Split 7 god files (400–1175 lines each) into focused, single-responsibility modules. Pure structural refactoring — zero behavior changes, all existing exports preserved via re-exports.

## Threshold

Every `.ts`/`.tsx` file in `src/` should be under 400 lines. Files already decomposed in S38 are excluded.

## Items

| ID    | Item                       | Lines      | Target       | Status |
| ----- | -------------------------- | ---------- | ------------ | ------ |
| DX-08 | Split TimeblockingView.tsx | 1175 → 333 | 8-10 modules | done   |
| DX-09 | Split PluginBrowser.tsx    | 689 → 346  | 5 modules    | done   |
| DX-10 | Split AITab.tsx            | 637 → 326  | 4 modules    | done   |
| DX-11 | Split PluginCard.tsx       | 561 → 30   | 5 modules    | done   |
| DX-12 | Split ui/api/ai.ts         | 547 → 8    | 6 modules    | done   |
| DX-13 | Split AIContext.tsx        | 500 → 154  | 4-5 modules  | done   |
| DX-14 | Split AIChatPanel.tsx      | 484 → 328  | 5 modules    | done   |

## Constraints

- No behavior changes — pure structural refactoring
- All existing imports must keep working (re-export from original files)
- No new dependencies
- All tests must pass unchanged (`pnpm test`)
- TypeScript strict mode must pass (`pnpm check`)

## Dependencies

- S44 (Timeblocking UX Polish) should land first since it adds code to TimeblockingView.tsx

## Prompt

Single prompt: `prompts/01-module-decomposition-ii.md`
