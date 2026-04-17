# Epics

High-level work streams. Each epic maps to one or more sprints.

## Active Epics

### Calendar Integrations

**Sprints:** TBD
**Goal:** External calendar sync via automation connectors (n8n, Activepieces, Pipedream). No native OAuth.
**Status:** Backlog

## Completed Epics

### DX — Module Decomposition III + Provider Expansion

**Sprint:** S50–S51
**Goal:** Fix dev server issues, decompose 12 god files (800+ LOC), add 7 new AI providers (DeepSeek, Gemini, Mistral, Kimi, DashScope, Groq, ZAI), add OpenAI OAuth support.
**Status:** Complete (2455 tests, 202 test files). 12 providers total, 38 MCP tools, OAuth for OpenAI.

### AI Auto-scheduling

**Sprint:** S49
**Goal:** AI-powered optimal task placement on the timeblocking timeline. Hybrid heuristic scoring (priority×0.4, urgency×0.35, energy×0.25) + greedy bin-packing. Suggest and auto modes. Ghost block preview UI.
**Status:** Complete (2386 tests, 199 test files). Design doc + scheduling engine + 2 AI tools + preview UI.

### Motivation Engine

**Sprint:** S48
**Goal:** Engagement features: Eat the Frog (dread-based priority), Dopamine Menu (quick wins), Task Jar (random pick), joyful micro-animations (Framer Motion).
**Status:** Complete (2386 tests, 199 test files). dreadLevel field, DreadLevelSelector, EatTheFrog section, DopamineMenu view, TaskJar component, Framer Motion animations with reduced-motion support.

### AI Intelligence Tools

**Sprint:** S47
**Goal:** Three high-value AI tools: time estimation (track actuals vs estimates), weekly review & analytics, meeting notes → task extraction.
**Status:** Complete (2386 tests, 199 test files). Timer module, `~30m` parser syntax, 3 new AI tools, WeeklyReviewModal, ExtractTasksModal.

### Housekeeping + Global Quick Capture

**Sprint:** S46
**Goal:** Clean up roadmap tracking, expand E2E coverage, ship Global Quick Capture (Tauri system-wide hotkey).
**Status:** Complete (2386 tests, 199 test files). Roadmap v1.1 ticked, E2E expanded, tauri-plugin-global-shortcut, QuickCapture view + settings.

### DX — Module Decomposition II

**Sprint:** S45
**Goal:** Split 7 god files (400–1175 lines) into focused modules. All files under 400 lines. Zero behavior changes.
**Status:** Complete (2159 tests, 181 test files). All 7 files decomposed, largest now 346 lines.

### Timeblocking UX Polish + AI Tools

**Sprints:** S44
**Goal:** Fix sidebar integration (drag, context menus), add context menus throughout timeblocking plugin, make tasks clickable, register AI tools for block CRUD.
**Status:** Complete (2159 tests, 181 test files).

### Timeblocking Plugin

**Sprints:** S38–S43
**Goal:** Akiflow-inspired timeblocking as a first-class plugin. Validates plugin React rendering.
**Status:** Complete (2146 tests, 180 test files). S38 DX decomposition, S39 plugin React rendering, S40 core data model, S41 day view, S42 week view + slots, S43 polish + E2E.

### DX — Module Decomposition

**Sprint:** S38
**Goal:** Split 7 files (800–1474 lines each) into focused modules. No behavior changes.
**Status:** Complete (7/7 items, 1956 tests unchanged)

### v1.0 Stable Release

**Sprints:** S0–S37
**Goal:** Production-quality local-first task manager with AI assistant, plugin system, voice I/O, and Tauri desktop app.
**Status:** Complete (37 sprints, 1796+ tests, 251 features)
