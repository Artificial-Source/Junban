# Developer Getting Started

Canonical source: [`../../guides/SETUP.md`](../../guides/SETUP.md)

This page is a fast path to running Junban locally and understanding which runtime path you are working in.

## 1) Prerequisites

- Node.js 22+
- pnpm 10+
- Git 2.x

For desktop app development, also install Rust and Tauri CLI.

For full install details, use the canonical setup guide: [`../../guides/SETUP.md`](../../guides/SETUP.md).

## 2) First local run

```bash
pnpm install
cp .env.example .env
mkdir -p data/dev
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173`.

## 3) Understand the runtime split early

Junban has four major execution modes in development and direct-service flows:

- **Browser inline-backend mode** (`pnpm dev`): Vite frontend with inline API plugin (`VITE_USE_BACKEND` is false).
- **Browser standalone-backend mode** (`pnpm dev:full`): Vite frontend talking to a separate `src/server.ts` process (`VITE_USE_BACKEND=true`).
- **Packaged Tauri/webview runtime** (`src/ui/api/direct-services.ts` + `src/bootstrap-web.ts`): in-process webview path used in packaged shells with direct services, `sql.js`-based persistence, and no backend HTTP from UI.
- **Tauri shell dev mode** (`pnpm tauri:dev`): desktop shell startup with backend-backed API flow (`VITE_USE_BACKEND=true`) and the `src/server.ts` + `src/bootstrap.ts` stack.

Key constraints:

- Markdown storage is Node-only.
- Backend-backed modes depend on Node process capabilities and `src/bootstrap.ts` graph.
- Direct-services mode depends on in-process browser/Tauri wiring and `bootstrap-web.ts` behavior.

If your change crosses boundaries (for example UI + CLI + MCP behavior), verify the relevant modes for the change.

## 4) Pick the right dev mode

- `pnpm dev`: browser inline-backend mode.
- `pnpm dev:full`: browser standalone-backend mode.
- `pnpm server`: standalone backend server.
- `pnpm tauri:dev`: desktop shell with backend-backed API runtime.

Direct-services mode (`src/ui/api/direct-services.ts` + `src/bootstrap-web.ts`) is not switched on by a dedicated `pnpm` flag; validate it via targeted checks when you touch direct-service code.

Use `dev`/`dev:full` to validate browser/server modes, `tauri:dev` for shell lifecycle/runtime, and direct-services targeted checks when needed.

Use `dev:full` when your change depends on HTTP API behavior; otherwise `dev` is often faster.

## 5) Daily quality checks

Run the smallest useful checks while iterating, then run the full gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

## 6) Where to go next

- Architecture overview: [`architecture.md`](architecture.md)
- Command reference: [`commands.md`](commands.md)
- Plugin developer guide: [`plugins.md`](plugins.md)
- MCP developer guide: [`mcp.md`](mcp.md)
- Full canonical reference index: [`../../reference/README.md`](../../reference/README.md)
