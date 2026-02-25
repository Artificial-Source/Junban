# Sprints

Two-week sprint cycles. Each sprint has a clear goal and pulls items from the [Backlog](BACKLOG.md).

## How Sprints Work

- **Duration**: 2 weeks
- **Planning**: Select items from backlog at sprint start, assign to sprint column in BACKLOG.md
- **Daily work**: Pick the next `ready` item, mark `in-progress`, complete it
- **Review**: At sprint end, update items to `done`, write retro notes, plan next sprint
- **Carry-over**: Incomplete items return to backlog or carry into the next sprint

### Sprint Sizing

| Size | Effort | Example |
|------|--------|---------|
| S | < 2 hours | Wire a single service to DB, add a test file |
| M | 2–6 hours | Build a complete view, implement a CLI command end-to-end |
| L | 1–2 days | Plugin loader with validation, keyboard navigation system |
| XL | 3–5 days | Sandbox implementation, storage abstraction layer |

---

## Sprint History

36 sprints completed. Individual sprint details are in [`sprints/`](sprints/).

| Sprint | Theme | Tests | Details |
|--------|-------|-------|---------|
| [S0](sprints/S00-scaffold.md) | Scaffold | 171 | Project structure, docs, config, parser, test suite |
| [S1](sprints/S01-first-blood.md) | First Blood | 219 | DB wiring, task CRUD, UI + CLI functional |
| [S2](sprints/S02-feel-good.md) | Feel Good | 246 | Keyboard nav, command palette, themes, task editor |
| [S3](sprints/S03-plugins-foundation.md) | Plugins: Foundation | 275 | Loader, sandbox, lifecycle, event bus, storage |
| [S4](sprints/S04-plugins-ui.md) | Plugins: UI | 297 | Panels, views, status bar, commands, Pomodoro |
| [S5](sprints/S05-ai-foundation.md) | AI: Foundation | 321 | 5 providers, SSE streaming, task CRUD tools |
| [S6](sprints/S06-ai-intelligence.md) | AI: Intelligence | 333 | Context injection, chat persistence, voice input |
| [S7](sprints/S07-cicd.md) | CI/CD | 333 | GitHub Actions, ESLint 9, Prettier |
| [S8](sprints/S08-styling-desktop.md) | Styling & Desktop | 333 | Tailwind fix, Tauri v2, sql.js WASM |
| [S9](sprints/S09-power-user.md) | Power User | 387 | Bulk ops, DnD, undo/redo, BYOM, data export |
| [S10](sprints/S10-milestone-closure.md) | Milestone Closure | 424 | Data import, custom themes, plugin install |
| [S11](sprints/S11-markdown-storage.md) | Markdown Storage | 528 | IStorage interface, Markdown backend |
| [S12](sprints/S12-hardening.md) | Hardening | 528 | Error handling, performance, accessibility |
| [S13](sprints/S13-v1-release.md) | v1.0 Release | 549 | API versioning, Tauri updater, release workflow |
| [S14](sprints/S14-design-system.md) | Design System | 549 | Semantic tokens, component redesign, Settings tabs |
| [S15](sprints/S15-subtasks-focus.md) | Sub-tasks & Focus | 574 | Hierarchical subtasks, FocusMode |
| [S16](sprints/S16-templates-queries.md) | Templates & Queries | 610 | Task templates, NL query bar |
| [S17](sprints/S17-ai-errors.md) | AI Error Handling | 620 | Error classification, retry, streaming timeouts |
| [S18](sprints/S18-model-discovery.md) | Model Discovery | 630 | Dynamic model lists from provider APIs |
| [S19](sprints/S19-reminders.md) | Reminders | 663 | remindAt column, useReminders hook |
| [S20](sprints/S20-pluggable-llm.md) | Pluggable LLM | 682 | LLMPipeline, ToolRegistry, provider registry |
| [S21](sprints/S21-voice.md) | Voice Integration | 735 | STT/TTS abstraction, VAD, hands-free mode |
| [S22](sprints/S22-ai-tools.md) | AI Intelligence Tools | 772 | Pattern analysis, workload, energy recommendations |
| [S23](sprints/S23-rebrand.md) | Rebrand (Saydo) | 772 | Docket → Saydo across entire codebase |
| [S24](sprints/S24-local-voice.md) | Local Voice Models | 813 | Piper TTS, Kokoro Web Worker |
| [S25](sprints/S25-project-reminder-tools.md) | Project & Reminder Tools | 857 | 5 project + 4 reminder AI tools |
| [S26](sprints/S26-inworld-mobile.md) | Inworld TTS & Mobile | 960 | Inworld TTS, mobile UI, SettingsContext |
| [S27](sprints/S27-settings-ai.md) | Settings & AI Quick Wins | 960 | GeneralTab, 3 AI productivity tools |
| [S28](sprints/S28-sound-effects.md) | Sound Effects | 988 | Web Audio API sound effects |
| [S29](sprints/S29-voice-call-search.md) | Voice Call & Search | 1018 | Voice call mode, SearchModal, tag tools |
| [S30-31](sprints/S30-31-github-issues.md) | GitHub Issues | 1018+ | 15 GitHub issues closed |
| [S32](sprints/S32-frontend-enhancements.md) | Frontend Enhancements | 1018+ | 23 UI polish items |
| [S33](sprints/S33-qa-polish.md) | QA & Polish | 1773 | 13 bugs, 2 AI tools, Today redesign |
| [S34](sprints/S34-plugin-slot-system.md) | Plugin Slot System | 1773 | View slots, structured content, Pomodoro rewrite |
| [S35](sprints/S35-big-features.md) | Big Features | 1774 | Kanban board, stats, comments, sections, cancelled/someday views |
| [S36](sprints/S36-bug-fixes.md) | Bug Fixes | 1785 | NLP deadline keyword, context menu wiring, ultrawide max-width |
| S37 | Core UI Enhancements | 1796 | Markdown descriptions, workload capacity bar, project progress tracking |

---

## Future Sprints (Unscheduled)

See [BACKLOG.md](BACKLOG.md) for all items.

| Sprint | Theme | Key Items |
|--------|-------|-----------|
| S36+ | Saydo Sync | Sync server, user accounts, E2E encryption |
