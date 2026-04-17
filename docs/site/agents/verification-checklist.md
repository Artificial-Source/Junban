# Agent Verification Checklist

Canonical source: [`../../guides/CONTRIBUTING.md`](../../guides/CONTRIBUTING.md)

Use this checklist before handing off AI-agent-authored changes.

## 1) Choose checks based on blast radius

- Docs-only changes: `pnpm docs:check`
- Typical code change: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
- Full local quality gate: `pnpm check`
- Changes touching runtime entrypoints or build wiring: add `pnpm build`
- Changes touching browser flows: run `pnpm dev` (and `pnpm dev:full` when backend path matters)

## 2) Runtime split verification

- If change touches `src/bootstrap.ts`, verify Node paths (server/CLI/MCP as relevant).
- If change touches `src/bootstrap-web.ts` or `src/ui/`, verify direct-services constraints separately (SQLite/sql.js path, no Node-only imports).
- If change touches shell/desktop runtime behavior, validate backend-backed shell flow with `pnpm tauri:dev`.
- If change touches `src/ui/api/direct-services.ts`, `src/bootstrap-web.ts`, or built-in plugin web-runtime behavior (`src/plugins/builtin/`), run focused direct-services checks in addition to shell checks.
- If AI/provider/tool behavior changed, verify both Node and browser registration/loading paths where applicable.

## 3) Docs routing verification

- Confirm `docs/site/` pages still act as summaries/routes, not canonical truth.
- For behavior/API/workflow changes, update mapped canonical docs from `docs/README.md` ownership map in the same PR.
- Keep one visible canonical-source line per published page.

## 4) Command set commonly expected in PR readiness

```bash
pnpm docs:check
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

Run additional targeted commands (`pnpm test:e2e`, `pnpm mcp`, `pnpm cli`) when the changed area depends on them.
