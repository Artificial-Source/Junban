# Frontend Preservation Map

Date: 2026-07-28
Legacy authority: private sibling repository at commit `5e2b2b5adc865f401843c5030285293c5fabccc5`

## Decision

The approved React interface is a design contract. Preserve its appearance while replacing its backend coupling deliberately. Do not bulk-copy the retired monorepo.

The live legacy UI already uses HTTP fetch in active paths. Its dormant direct/sql.js branch and Node desktop-server admission logic are not part of the new architecture.

## Copy as the visual source

Copy or deliberately reproduce these paths from the legacy repository:

- `index.html`: title, theme color, favicon links, and Outfit/Space Grotesk/Space Mono font declarations
- `public/images/**`: logos, favicons, Apple touch icon, and application icons
- `src/ui/index.css`
- `src/ui/themes/{light,dark,nord}.css`
- `src/ui/themes/manager.ts`
- relevant theme/color constants from `src/config/{themes,defaults}.ts`
- `src/ui/components/**`, `views/**`, `app/**`, `context/**`, `hooks/**`, `dnd/**`, `i18n/**`, and `errors/**`, but only phase-by-phase after their DTO and service boundaries exist
- presentation utilities for animation, calendar-day display, dates, formatting, sound, color, logging, performance, Tauri detection, URL sanitization, and client IDs
- the public screenshot set and screenshot generator
- the built-theme compatibility guard

The legacy UI contains about 281 files. Copying all of it before defining frontend contracts would not compile and would import old architecture accidentally.

## Adapt instead of copying unchanged

- Replace `src/ui/api/**` with a fetch-only client over the Rust server.
- Replace imports from legacy `core`, `application`, `storage`, `plugins`, and `ai` with frontend DTOs, generated contract types, or focused client-only helpers.
- Redesign desktop lifecycle and hosted-access integration around the Rust process; preserve visible controls and wording only where still truthful.
- Keep the Data screen's user workflows but make SQLite the sole live store and Markdown import/export only.
- Keep complete backup as a new-format Rust feature; do not import legacy restore-authority compatibility machinery.
- Rebind AI, voice, plugins, Quick Capture, notifications, and reminders to Rust services without changing their approved visual layouts.
- Replace Playwright's Node web-server setup with the Rust server.

## Never copy as architecture

- `src/ui/api/direct-services.ts`
- `public/sql-wasm/**`
- legacy `src/{api,application,bootstrap*,cli,core,db,desktop-server,mcp,server*,storage}/**`
- `vite-api-plugin.ts` and `vite-api-routes/**`
- packaged Node sidecar resources and scripts
- better-sqlite3, Drizzle, sql.js, or Markdown live-storage machinery
- legacy idempotency/receipt compatibility layers solely intended for old installations

Small pure client helpers may be rewritten under a frontend-owned `lib` boundary when rendering truly needs them. Domain authority remains Rust.

## Design and accessibility gates

Carry or recreate these contracts:

- README screenshot scenes, especially Today light/dark, Board, Matrix, Calendar, Task Detail, Stats, and Hosted Access
- theme and accent contrast matrix
- axe accessibility suite
- forced-colors and reduced-motion behavior
- keyboard focus and shortcut behavior
- roles and interaction tests for Sidebar, TaskItem/List/Detail, Command Palette, Focus Mode, onboarding, calendar, recurrence, mobile drawer, bottom navigation, and status bar

High-risk visual areas are theme tokens and relative accent colors, density/font settings, Today/Board/Matrix/Calendar, markdown task descriptions, sidebar/mobile layouts, command/focus overlays, onboarding theme cards, glass surfaces, scrollbars, and Quick Capture.

## Recommended visual migration order

1. Vite/React/Tailwind shell, fonts, icons, themes, and empty screenshot scene.
2. Fetch-only client plus Rust health/tasks/projects read slice.
3. App layout, sidebar, Today, Inbox, TaskItem, and Task Detail.
4. Mutations and undo/toast behavior.
5. Board, Matrix, Calendar, search, and advanced planning views.
6. Settings, accessibility matrix, and screenshot parity.
7. AI, voice, plugins, hosted access, and Quick Capture integrations.

Each visual phase compares at fixed desktop and mobile viewports. Intentional differences require explicit approval and regenerated evidence; backend-driven textual changes are not silently accepted as visual parity.
