# Roadmap

## v0.1 — Foundation (MVP)

Core task management without plugins. A usable task manager.

- [x] Project scaffold (package.json, tsconfig, linting, formatting)
- [x] Core infrastructure (logger, config, validation, ID generation)
- [x] Database schema and migrations (Drizzle + SQLite)
- [x] Task CRUD (create, read, update, delete, complete)
- [x] Project management (create, list, archive)
- [x] Tag system (create, assign, filter)
- [x] Priority levels (P1–P4 with sorting)
- [x] Due dates with time support
- [x] Natural language task input (chrono-node + custom grammar)
- [x] Basic React UI: inbox, today, upcoming views
- [x] Sidebar navigation
- [x] Keyboard-first navigation
- [x] Command palette (Ctrl+K)
- [x] Light/dark theme
- [x] CLI companion: `add`, `list`, `done`, `edit`, `delete` commands
- [x] Unit tests for core logic and parser
- [x] Documentation: all docs complete

## v0.2 — Polish

Refinements to the core experience before plugins.

- [x] Recurring tasks (daily, weekly, monthly, custom)
- [x] Task search and filtering (by project, tag, priority, date range)
- [x] Bulk operations (complete all, move to project, tag multiple)
- [x] Drag-and-drop task reordering
- [x] Task descriptions (longer notes below the title)
- [x] Undo/redo for task operations
- [x] Custom CSS theme support
- [x] Keyboard shortcut customization
- [x] Data export (JSON, Markdown, CSV)
- [x] Data import (Todoist JSON, plain text)

## v0.3 — AI Assistant

The conversational AI layer.

- [x] AI provider abstraction interface
- [x] OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, DeepSeek, Gemini, Mistral, Kimi, DashScope, Groq, ZAI providers
- [x] AI chat panel in sidebar with SSE streaming
- [x] Chat session management and persistence
- [x] AI tool definitions (task CRUD, scheduling, reminders)
- [x] Context injection (tasks, projects, priorities, schedule)
- [x] Natural language task creation via AI
- [x] AI follow-up questions and priority suggestions
- [x] Voice input (speech-to-text → AI chat)
- [x] Voice output (text-to-speech for responses)
- [x] Bidirectional voice mode (VAD + push-to-talk)
- [x] Provider settings UI (select provider, enter API keys)
- [x] Custom AI provider plugin support (BYOM)
- [x] Dynamic model discovery (fetch from provider APIs)
- [x] Error handling with retry, timeout, graceful degradation
- [x] Pluggable LLM core (LLMPipeline, LLMExecutor, ToolRegistry)
- [x] Intelligence tools (pattern analysis, workload, smart organize, energy recommendations)
- [x] Voice provider abstraction (STT/TTS with browser, Groq, local adapters)

## v0.5 — Plugin System

The Obsidian-style plugin architecture.

- [x] Plugin manifest schema and validation
- [x] Plugin settings manager
- [x] Plugin registry search
- [x] Plugin loader (discovery, validation, loading)
- [x] Plugin lifecycle management (load, unload, enable, disable)
- [x] Sandboxed plugin execution environment
- [x] Plugin API surface: task read/write, events, commands
- [x] Plugin UI extension points: sidebar panels, views, status bar
- [x] Plugin settings system (defined in manifest, managed by Saydo)
- [x] Plugin-specific storage (isolated key-value store)
- [x] Community plugin registry (sources.json)
- [x] Plugin store view (browse, install, configure, remove)
- [x] Built-in example plugin (Pomodoro timer)
- [x] Plugin API documentation and examples
- [x] Plugin permission model (approve on install)

## v0.7 — Markdown Storage

Alternative storage backend for portability.

- [x] Markdown storage backend (YAML frontmatter + body)
- [x] Storage interface abstraction (SQLite and Markdown share API)
- [x] File-based project organization (one directory per project)
- [x] Storage mode switching in settings
- [x] Markdown import/export
- [x] Git-friendly file format (minimal diffs on updates)

## v1.0 — Stable Release

Production-quality task manager with a stable plugin API.

- [x] Stable Plugin API (v1 — breaking changes require major version)
- [x] Tauri desktop app packaging (macOS, Windows, Linux)
- [x] Auto-update mechanism
- [x] Performance optimization (large task lists, many plugins)
- [x] Accessibility audit (screen readers, keyboard-only use)
- [x] Comprehensive test suite (unit, component, integration)
- [x] CI/CD pipeline (lint, typecheck, test, build, release)
- [x] First batch of community plugins published
- [x] MCP server for external AI agent integration (Claude Desktop, custom agents)

## v1.1 — Timeblocking Plugin

Akiflow-inspired timeblocking as a first-class plugin. Validates plugin React rendering.

- [x] Plugin system: React component rendering (`contentType: "react"`)
- [x] Plugin system: network permission wiring
- [x] Plugin system: expanded task event bus
- [x] TimeBlock & TimeSlot data model with recurrence
- [x] Day timeline view with drag-and-drop (create, move, resize blocks)
- [x] Week timeline view with N-day support (1–7 columns)
- [x] TimeSlot containers (hold multiple tasks, progress tracking)
- [x] Split view layout (task list + timeline side-by-side)
- [x] Recurring blocks (daily, weekly, monthly)
- [x] Replan Undone Tasks (reschedule incomplete blocks)
- [x] Plugin settings (work hours, default duration, grid interval)
- [x] Keyboard shortcuts (D/W/1-7, T for today, arrows to navigate)
- [x] Focus mode integration (pin current block)

## v1.2 — Calendar Integrations

External calendar sync via automation connectors (no native OAuth).

- [ ] Webhook/API endpoint for time block CRUD events
- [ ] n8n / Activepieces / Pipedream connector documentation
- [ ] ICS export of time blocks
- [ ] Lock block → calendar event (public/private/busy)
- [ ] Two-way sync via automation platform (pull external events)

## v1.5 — Saydo Sync

Cross-device sync service (paid, optional — like Obsidian Sync).

- [ ] Sync server architecture (ASF-hosted)
- [ ] User accounts and authentication
- [ ] End-to-end encrypted task sync
- [ ] Conflict resolution for concurrent edits
- [ ] Sync client in desktop app
- [ ] Subscription management and billing

## v2.0 — Mobile

Native mobile apps + PWA (requires Saydo Sync).

- [ ] React Native iOS app
- [ ] React Native Android app
- [ ] PWA for browser-based mobile access
- [ ] Push notifications for reminders
- [ ] Mobile-optimized UI

## v3.0 — Web App

Full browser-based client (requires Saydo Sync).

- [ ] Web client (React, same codebase where possible)
- [ ] Collaborative features (shared projects, team sync)
- [ ] Enterprise tier (SSO, admin controls, audit logs)

---

## Current Status

| Area | Done | Remaining | Status |
|------|------|-----------|--------|
| Foundation & Infrastructure | 16/16 | 0 | Complete |
| Core — Task CRUD | 19/19 | 0 | Complete |
| Parser & NLP | 8/8 | 0 | Complete |
| UI — Views & Components | 40/41 | 1 | Logo design pending |
| CLI | 7/8 | 1 | Fuzzy picker idea |
| Plugin System | 21/21 | 0 | Complete |
| AI Assistant | 55/67 | 12 | 12 providers, 38 MCP tools, OAuth, ideas pending |
| Storage & Data | 13/13 | 0 | Complete |
| Testing | 10/10 | 0 | 202 test files, 2455 tests |
| Hardening & Quality | 17/17 | 0 | Complete |
| Frontend Enhancements | 25/25 | 0 | Complete |
| QA — Bugs | 17/17 | 0 | Complete |
| Documentation | 15/15 | 0 | Complete |
| **Total** | **263/277** | **14** | **95% complete** |

### What's Fully Done

- Task CRUD with subtasks, templates, recurrence, filters, priorities
- SQLite + Markdown dual storage backends
- ~70+ React components, 19+ views + 10 settings tabs, 17 hooks, 9 contexts
- AI assistant with 38 tools, 12 providers (OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, DeepSeek, Gemini, Mistral, Kimi, DashScope, Groq, ZAI), OpenAI OAuth, chat persistence
- Voice I/O: 8 adapters (STT/TTS), VAD, Web Workers, voice call mode
- Plugin system with sandboxing, permissions, lifecycle, registry
- Timeblocking plugin: day/week views, DnD, recurrence, AI auto-scheduling
- Motivation engine: Eat the Frog, Dopamine Menu, Task Jar, Framer Motion animations
- MCP server: 38 tools + 8 resources + 3 prompts (Claude Desktop integration)
- CLI companion with 5 commands
- Tauri desktop app scaffold + auto-updater + global quick capture
- CI/CD pipeline (GitHub Actions)
- Design token system, accessibility audit, performance optimization
- Kanban board, calendar views, matrix view, stats dashboard
- Task comments, activity tracking, daily/weekly review rituals
- Responsive mobile UI, sound effects, saved filters
- 202 test files, 2455 passing tests (including 33+ Playwright E2E spec files)

### Ideas (need scoping)

| ID | Item | Area |
|----|------|------|
| A-41 | Energy-aware suggestions (enhanced) | AI Tools |
| A-42 | Habit / recurring task intelligence | AI Tools |
| A-43 | Project planning from description | AI Tools |
| A-44 | Adaptive learning (preference tracking) | AI Tools |
| A-48 | Plugin-contributed AI tools | AI Tools |
| A-18 | AI reminders via integrations | Integrations |
| A-45 | ICS calendar export/import | Integrations |
| U-35 | Design proper SVG logo | UI |
| L-08 | Interactive CLI task picker | CLI |

### Plugin Ideas

- Calendar sync via automation connectors (n8n, Activepieces, Pipedream, Make) — v1.2
- CalDAV sync (Nextcloud, iCloud, Google Calendar)
- Git sync (free alternative to Saydo Sync)
- WebDAV sync (self-hosted)
- Time tracking with reports
- Habit tracker with streaks
- Discord reminder bot
- Webhooks (trigger on task events)
- Email-to-task
- Browser extension (quick-add)
- Widget support (system tray / menu bar)

---

## Sprint History

51 sprints completed across ~23 months of development.

| Sprint | Theme | Tests |
|--------|-------|-------|
| S0 | Scaffold | 171 |
| S1 | First Blood (DB wiring) | 219 |
| S2 | Feel Good (polish) | 246 |
| S3 | Plugins: Foundation | 275 |
| S4 | Plugins: UI | 297 |
| S5 | AI: Foundation | 321 |
| S6 | AI: Intelligence | 333 |
| S7 | CI/CD & Release | 333 |
| S8 | Styling & Desktop App | 333 |
| S9 | Power User | 387 |
| S10 | Milestone Closure | 424 |
| S11 | Markdown Storage | 528 |
| S12 | Hardening | 528 |
| S13 | v1.0 Release | 549 |
| S14 | Design System | 549 |
| S15 | Sub-tasks & Focus Mode | 574 |
| S16 | Templates & NL Queries | 610 |
| S17 | AI Error Handling | 620 |
| S18 | Dynamic Model Discovery | 630 |
| S19 | Reminders | 663 |
| S20 | Pluggable LLM Core | 682 |
| S21 | Voice Integration | 735 |
| S22 | AI Intelligence Tools | 772 |
| S23 | Rebrand (Docket → Saydo) | 772 |
| S24 | Local Voice Models | 813 |
| S25 | Project & Reminder Tools | 857 |
| S26 | Inworld TTS & Mobile UI | 960 |
| S27 | Settings & AI Quick Wins | 960 |
| S28 | Sound Effects | 988 |
| S29 | Voice Call & Tag Tools | 1018 |
| S30-31 | GitHub Issues batch | 1018+ |
| S32 | Frontend Enhancements | 1018+ |
| S33 | QA & Polish | 1773 |
| S34 | Plugin Slot System | 1773 |
| S35 | Big Features | 1774 |
| S36 | Bug Fixes | 1785 |
| S37 | Core UI Enhancements | 1796 |
| S38 | Module Decomposition (DX-01–07) | 1956 |
| S39 | Plugin React Rendering | 1956+ |
| S40 | Timeblocking Data Model | 1956+ |
| S41 | Timeblocking Day View | 1956+ |
| S42 | Timeblocking Week View | 1956+ |
| S43 | Timeblocking Polish + E2E | 2146 |
| S44 | Module Decomposition II (DX-08–14) | 2159 |
| S45 | Lint Cleanup | 2159 |
| S46 | Housekeeping + Global Quick Capture | 2386 |
| S47 | AI Intelligence Tools (time estimation, weekly review, meeting notes) | 2386 |
| S48 | Motivation Engine (Eat the Frog, Dopamine Menu, Task Jar, animations) | 2386 |
| S49 | AI Auto-scheduling | 2386 |
| S50 | Clean Slate + 7 New Providers + OAuth | 2455 |
| S51 | Module Decomposition III (DX-15–25) | 2455 |

### Known Technical Debt

1. `src/main.ts:24` — TODO: Start UI or CLI based on context (currently assumes UI)
2. E2E tests expanded (33+ Playwright spec files) — continue expanding coverage
3. No `.env` committed — only `.env.example` exists
4. ~~`auto_schedule_day` + `reschedule_day` not available in MCP~~ — Fixed: MCP server now loads plugins
