# Product Roadmap

This page tracks Junban's milestone-level product direction.

For the current shipped snapshot, see [`status.md`](status.md). For scoped future-product planning, see [`prds/README.md`](prds/README.md).

Future milestones below intentionally stay summary-level; detailed scope lives in PRDs (product framing) and `docs/internal/` planning docs (execution detail).

## v0.1 — Foundation (MVP)

Core task management without plugins. A usable task manager.

Shipped foundation for local task management, desktop UI, CLI basics, parser-driven input, and core persistence.

## v0.2 — Polish

Refinements to the core experience before plugins.

Shipped recurring tasks, richer task editing/filtering, import/export, drag-and-drop reordering, theming, and undo/redo.

## v0.3 — AI Assistant

The conversational AI layer.

Shipped multi-provider AI chat, tool calling, voice input/output, dynamic model handling, and AI-assisted task workflows.

## v0.5 — Plugin System

The Obsidian-style plugin architecture.

Shipped the sandboxed plugin runtime, author-facing API, plugin registry/store flows, UI extension points, and permission-controlled plugin management.

## v0.7 — Markdown Storage

Alternative storage backend for portability.

Shipped the Markdown storage backend, shared storage abstraction, file-based organization, and import/export support for portable local-first data.

## v1.0 — Stable Release

Production-quality task manager with a stable plugin API.

Shipped the stable desktop release with plugin API guarantees, packaging/update flows, testing hardening, accessibility/performance work, and MCP integration.

## v1.1 — Timeblocking Plugin

Akiflow-inspired timeblocking as a first-class plugin. Validates plugin React rendering.

Shipped the first advanced built-in plugin with day/week timeline views, recurrence, focus integration, and richer plugin UI/runtime capabilities.

For shipped-product detail, use [`status.md`](status.md). For historical execution context, use [`../internal/planning/sprint-history.md`](../internal/planning/sprint-history.md).

## v1.2 — Calendar Integrations

External calendar sync via automation connectors (no native OAuth).

See [`prds/calendar-integrations.md`](prds/calendar-integrations.md).

## v1.5 — Junban Sync

Cross-device sync service (paid, optional — like Obsidian Sync).

See [`prds/junban-sync.md`](prds/junban-sync.md).

## v2.0 — Mobile

Native mobile apps + PWA (requires Junban Sync).

See [`prds/mobile-and-web.md`](prds/mobile-and-web.md).

## v3.0 — Web App

Full browser-based client (requires Junban Sync).

See [`prds/mobile-and-web.md`](prds/mobile-and-web.md).
