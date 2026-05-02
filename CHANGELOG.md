# Changelog

All notable changes to Junban are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes yet.

## [1.0.7] — 2026-05-02

Patch release to fix the packaged Linux backend startup and simplify release publishing.

### Fixed

- Packaged Linux builds now materialize the sidecar `node_modules` package entries so Tauri bundles can resolve dependencies such as `hono` at runtime.
- Sidecar validation now rejects symlink-only package entries that Linux bundles can omit.

### Changed

- The release workflow now publishes Linux installers independently instead of blocking Ubuntu releases on Windows or macOS packaging failures.

## [1.0.6] — 2026-05-01

Patch release to publish the current packaged desktop build and installer flow.

### Added

- **Linux installer helper** — `scripts/install-linux.sh` installs the latest `.deb` on Debian/Ubuntu or the latest AppImage on other Linux distributions.

### Fixed

- Published desktop installers now use the visible app name `Junban` instead of stale `ASF Junban` release branding.
- Packaged desktop installs now ship the sidecar-backed local backend runtime so the installed app can load tasks instead of using the stale direct browser database path from `v1.0.5`.
- The release workflow now rejects uploaded installer asset names that still contain stale visible `ASF Junban` branding.

## [1.0.5] — 2026-04-18

Maintenance release with desktop packaging and product cleanup before the sidecar-backed desktop runtime.

### Added

- **DevOps hardening** — graceful shutdown (SIGTERM/SIGINT) with plugin unload, uncaught exception handlers, Husky + lint-staged pre-commit hooks, `.nvmrc` for Node 22, Dependabot config, `.github/SECURITY.md` vulnerability reporting policy
- **OpenRouter model filtering** — model dropdown dynamically filters to tool-capable models only (via `supported_parameters.includes("tools")`), sorted alphabetically with clean display names
- **API key encryption** — AES-256-GCM encryption for API keys at rest
- **Plugin system** — production-ready loader, sandbox, CLI scaffolding, lifecycle tests, API docs
- **Swarm audit** — 10-round automated code quality audit with all fixes applied

### Changed

- Linux daily Node/server/CLI storage now follows XDG data defaults (`$XDG_DATA_HOME/junban/` or `~/.local/share/junban/`).
- Removed `.swarm/` audit artifacts and `.mcp.json` from git tracking
- Updated all README screenshots to reflect current UI state

## [1.0.2] — 2026-04-17

Patch release to restore updater artifact generation and allow the release workflow to validate draft assets before publish.

### Fixed

- Desktop builds now generate updater artifacts and signatures by enabling `bundle.createUpdaterArtifacts` in the Tauri config.
- Release validation can now inspect draft releases using the workflow token before publish.

## [1.0.1] — 2026-04-17

Patch release to correct desktop packaging and release metadata after the stale pre-Junban public release.

### Fixed

- Desktop release metadata now ships as `Junban` / `asf-junban` instead of stale `Saydo` identifiers.
- Release workflow now blocks publishing if tagged package metadata or uploaded assets still contain pre-Junban branding.
- Draft releases now require `latest.json` updater metadata before publish.
- README and release documentation now show the current packaged desktop download and install flow.

## [1.0.0] — 2026-02-28

First stable public release.

### Added

- **Core task management** — CRUD, sub-tasks, recurring tasks, priorities (P1–P4), due dates with time, reminders, descriptions, comments, activity tracking
- **Natural language input** — `buy milk tomorrow 3pm p1 #groceries +shopping` parsed via chrono-node + custom grammar
- **Project & tag system** — project sections, tag colors, filtering by any combination
- **Dual storage backends** — SQLite (default, via Drizzle ORM) and Markdown files with YAML frontmatter, sharing the same `IStorage` interface
- **AI assistant** — sidebar chat with 34 built-in tools: task/project/tag CRUD, reminders, task breakdown, duplicate detection, overcommitment checks, pattern analysis, workload detection, smart organization, energy-based scheduling, daily planning, productivity stats
- **8 LLM providers** — OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and OpenAI-compatible; pluggable pipeline with middleware (retry, timeout)
- **Voice I/O** — 8 adapters across 6 providers: Browser Speech API, Groq (Whisper STT + PlayAI TTS), Inworld AI TTS, Whisper local STT, Kokoro local TTS (Web Worker), Piper local TTS
- **Voice call mode** — hands-free AI conversation with VAD (voice activity detection), smart endpoint detection, grace period buffering
- **Plugin system** — Manifest validation, sandboxed execution, lifecycle hooks, command/panel/view registration, per-plugin settings and storage, community registry
- **Built-in Pomodoro plugin** — example plugin demonstrating the full API
- **MCP server** — 34 tools, 8 resources, 3 prompts exposed over stdio for Claude Desktop and custom AI agents
- **CLI companion** — `junban add`, `junban list`, `junban done`, `junban edit`, `junban delete`
- **Views** — Inbox, Today, Upcoming, Project, Board (Kanban), Calendar (month/week/day/agenda), Eisenhower Matrix, Stats dashboard, Completed, Cancelled, Someday, Filters & Labels, individual task pages
- **UI features** — command palette (Ctrl+K), global search, keyboard-first navigation, drag-and-drop reordering, bulk operations, focus mode, responsive mobile UI (bottom nav, drawer, FAB), markdown descriptions
- **Settings** — 10 tabs: general, appearance, features, AI, voice, plugins, templates, keyboard shortcuts, data, about
- **Themes** — light, dark, Nord; CSS design token system with custom theme support
- **Sound effects** — Web Audio API feedback for task create/complete/delete/reminder with per-event toggles
- **Undo/redo** — full stack for task mutations with UI integration
- **Data portability** — export to JSON, CSV, Markdown; import from Todoist JSON and plain text
- **Tauri desktop app** — cross-platform (macOS, Windows, Linux) with auto-updater
- **Workload capacity bar** — Today view shows estimated time vs daily capacity
- **Project progress** — completion ring in project header, mini progress bar in sidebar

### Changed

- Rebranded from "ASF Docket" to "Junban" (Sprint 23) — all identifiers, DB filenames, localStorage keys, CLI commands updated
- Replaced raw `AppServices.queries` with `IStorage` abstraction (Sprint 11) for dual-backend support
- Structured logger (`createLogger`) replaces raw `console.log` across voice subsystem

### Fixed

- Task undo-delete now preserves all fields including tags, comments, and activity
- Undo-complete clears `completedAt` timestamp
- `[BLANK_AUDIO]` from STT filtered before sending to AI
- Voice call mode prevents duplicate auto-speak via `voiceCallActiveRef`
- Markdown backend sorts YAML frontmatter keys alphabetically for git-friendly diffs

[1.0.0]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.0
[1.0.1]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.1
[1.0.2]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.2
[1.0.5]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.5
[1.0.6]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.6
[1.0.7]: https://github.com/Artificial-Source/Junban/releases/tag/v1.0.7
