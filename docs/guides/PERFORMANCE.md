# Performance Guide

> Startup and runtime performance notes for Junban contributors.

## Goals

- Keep the default Inbox startup path lean.
- Prefer rendering a usable shell first, then hydrating optional features.
- Keep AI, voice, drag-and-drop, and heavy view code off the default startup path unless they are actively needed.

## Current Startup Strategy

### Render First

- The app renders immediately instead of hiding the full tree behind a settings fade-in.
- Main-view loading uses `ViewSkeleton` instead of plain text fallbacks.
- `TaskContext` schedules its first refresh just after initial paint so the shell can appear quickly.

### Defer Optional Features

- `AIProvider` and `VoiceProvider` are feature-scoped, not app-global.
- Web AI runtime creation is behind `bootstrap-web-ai-runtime.ts`, which is loaded only when AI features are actually used.
- Voice provider registries and local voice providers load on demand.
- `TaskList` starts with a lightweight base list and upgrades to the enhanced drag/drop + virtualized list later.
- Sidebar drag-and-drop is lazy and interaction-driven.

### Keep Shared Startup Helpers Small

- `src/ui/api/helpers.ts` only contains lightweight shared API helpers.
- `src/ui/api/direct-services.ts` owns lazy in-process service bootstrap for Tauri mode.
- `src/ui/api/index.ts` is intentionally non-AI so common UI codepaths do not pull AI modules into the default graph.

## Startup Priorities

### Eager on Startup

- Settings batch load
- Tasks refresh
- Projects and tags
- Plugin list and plugin views

These are kept early because they affect routing, core navigation, or the first useful task UI.

### Deferred on Startup

- AI config hydration
- Plugin commands, status bar items, and panels
- Reminder polling first check
- Custom keyboard shortcut overrides
- Nudge evaluation

These use a short timeout and/or idle scheduling because they are useful soon after startup, but not required for first paint.

## Asset Strategy

- Prefer small SVG or PNG assets on the startup path.
- Avoid heavyweight favicon fallbacks on first load.
- Keep startup logos lightweight.
- Narrow Google Fonts weights and use `display=swap`.

## Component Guidance

- Prefer CSS transitions/animations for startup-critical UI.
- Avoid bringing `framer-motion`, `@dnd-kit`, or virtualization into the default route unless the feature is visible and interactive immediately.
- If a feature can render a simple version first, do that and upgrade later.

## Measurement Workflow

Use the production preview build for meaningful measurements.

```bash
pnpm build
npx vite preview --host 127.0.0.1
npx --yes lighthouse "http://127.0.0.1:4173/#/inbox" --preset=desktop --quiet --chrome-flags="--headless=new --no-sandbox"
```

Check:

- earliest network requests
- largest startup requests
- FCP / LCP
- whether a change removed work from the startup path, not just moved code around

## Automated Benchmarks

Junban also ships a Playwright-based benchmark pass for the most important user-facing flows:

```bash
pnpm test:perf
```

The benchmark suite currently records and budgets:

- empty-start startup (`junban:startup`)
- initial task refresh (`junban:tasks-refresh`)
- startup with a seeded task dataset
- task creation latency (`junban:task-create`)
- task completion latency (`junban:task-complete`)
- settings open latency (`junban:settings-open`)
- route transition latency (`junban:route-change`)

Metrics are collected through a lightweight in-browser performance registry exposed as `window.__JUNBAN_PERF__`, backed by `src/utils/perf.ts`. The Playwright test attaches the raw JSON results to the test output so regressions are easier to inspect.

## Current Low-Risk Optimizations

The current startup path also includes a few small scheduling optimizations aimed at weaker machines:

- initial task refresh uses a much shorter idle timeout so Inbox becomes useful sooner
- blocked-task relation hydration starts earlier after first paint
- onboarding and saved-filter hydration use shorter deferred timeouts so UI state stabilizes sooner without moving them onto the critical render path

## Recent Results

The current production preview baseline is approximately:

- Performance: `100`
- FCP: `~552ms`
- LCP: `~685ms`
- TBT: `0ms`
- CLS: `0`

Remaining early requests are mostly the core startup bundles, fonts, plugin/view hydration, and a few stubborn lazy-feature chunks that are now in diminishing-returns territory.

## When To Update This Doc

Update this guide when:

- startup loading policy changes
- a previously eager feature becomes deferred
- a new heavyweight dependency is added to startup-critical UI
- measurement workflow or baseline expectations change
