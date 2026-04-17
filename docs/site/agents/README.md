# Junban for AI Agents

Canonical source: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)

This page is a fast routing layer for coding agents working in this repository.

Use this publication layer to orient quickly, then follow canonical docs for behavior and contract-level truth.

## First look

- Agent quick-start and repo map: [`../../../AGENTS.md`](../../../AGENTS.md)
- Project-level development guide: [`../../../CLAUDE.md`](../../../CLAUDE.md)
- Canonical docs index and ownership map: [`../../README.md`](../../README.md)

## Milestone 3 agent pages

- Entrypoints by process/runtime: [`entrypoints.md`](entrypoints.md)
- Runtime split constraints (Node, browser, Tauri shell, packaged Tauri/webview direct-services): [`runtime-splits.md`](runtime-splits.md)
- Verification checklist before handoff: [`verification-checklist.md`](verification-checklist.md)

## Composition roots

- **Browser inline dev (`pnpm dev`)** (`vite` + inline API middleware):
  - `src/ui/main.tsx`
  - `vite.config.ts`
  - `vite-api-plugin.ts`
  - `src/bootstrap.ts`
- **Browser standalone-backend dev (`pnpm dev:full`)** (`src/server.ts` + Vite):
  - `src/ui/main.tsx`
  - `src/server.ts`
  - `src/bootstrap.ts`
- **Tauri shell / backend-backed mode (`pnpm tauri:dev`):**
  - `src/ui/main.tsx`
  - `src/server.ts`
  - `src/bootstrap.ts`
- **Packaged Tauri/webview direct-services path (`bootstrap-web.ts`):**
  - `src/ui/main.tsx`
  - `src/bootstrap-web.ts`
  - `src/bootstrap-web-ai-runtime.ts`
- **Node/runtime entrypoints for non-browser hosts:**
  - `src/main.ts`
  - `src/bootstrap.ts`
  - `src/cli/index.ts`
  - `src/mcp/server.ts`
- **Route module note:** `src/api/` contains Hono route-module implementations mounted by `src/server.ts` for backend-backed flows (`pnpm dev:full`, `pnpm tauri:dev`); inline browser dev (`pnpm dev`) is served through `vite-api-plugin.ts` + `vite-api-routes/*`, while both paths still share `src/bootstrap.ts`.

## Canonical deep dives

- Architecture and system shape: [`../../guides/ARCHITECTURE.md`](../../guides/ARCHITECTURE.md)
- Setup and run commands: [`../../guides/SETUP.md`](../../guides/SETUP.md)
- Contribution and CI expectations: [`../../guides/CONTRIBUTING.md`](../../guides/CONTRIBUTING.md)
- Technical-reference routing: [`../../reference/README.md`](../../reference/README.md)

## Guardrails

- Treat `docs/site/` as publication-only docs.
- Route behavioral and API truth to canonical docs in `docs/guides/`, `docs/reference/`, and `docs/product/`.
- Do not use `docs/internal/` as a published source.
- Avoid brittle inventories; prefer durable descriptions unless a count is intentionally tracked canonically.
