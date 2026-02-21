# Project Status

Quick-reference for what's done, what's in progress, and what's still missing. Updated 2026-02-21.

## Completion Overview

| Area | Done | Remaining | Status |
|------|------|-----------|--------|
| Foundation & Infrastructure | 16/16 | 0 | Complete |
| Core — Task CRUD | 15/15 | 0 | Complete |
| Parser & NLP | 7/7 | 0 | Complete |
| UI — Views & Components | 34/35 | 1 | Logo design pending |
| CLI | 7/8 | 1 | Fuzzy picker idea |
| Plugin System | 20/20 | 0 | Complete |
| AI Assistant | 45/57 | 12 | Core done; ideas pending |
| Storage & Data | 12/12 | 0 | Complete |
| Testing | 10/10 | 0 | 94 test files, 1000+ tests |
| Hardening & Quality | 17/17 | 0 | Complete |
| Frontend Enhancements | 23/23 | 0 | Complete |
| Documentation | 15/15 | 0 | Complete |
| **Total** | **221/235** | **14** | **94% complete** |

## What's Fully Done

- Task CRUD with subtasks, templates, recurrence, filters, priorities
- SQLite + Markdown dual storage backends
- 54 React components, 24 views, 13 hooks, 6 contexts
- AI assistant with 25 tools, 8 providers, chat persistence
- Voice I/O: 8 adapters (STT/TTS), VAD, Web Workers
- Plugin system with sandboxing, permissions, lifecycle, registry
- CLI companion with 5 commands
- Tauri desktop app scaffold + auto-updater
- CI/CD pipeline (GitHub Actions)
- Design token system, accessibility audit, performance optimization
- 94 test files, 1000+ passing tests

## What's Missing

### Ready to Build (well-defined, can start immediately)

| ID | Item | Area | Effort |
|----|------|------|--------|
| U-35 | Design proper SVG logo | UI | S |

### Ideas (need scoping before implementation)

#### AI Tools — High Value
| ID | Item | Why |
|----|------|-----|
| A-32 | Morning briefing / daily plan (`plan_my_day` tool) | Users expect this from a smart task manager. Sunsama-inspired. |
| A-33 | Daily review / shutdown (`daily_review` tool) | End-of-day reflection. Pairs with A-32. |
| A-37 | Weekly review & analytics (`weekly_review` tool) | Completion rates, trends, neglected projects. |
| A-39 | Meeting notes to tasks (`extract_tasks_from_text` tool) | Paste text, get structured tasks. High utility. |
| A-36 | AI time estimation (`estimatedMinutes` field) | Track estimates vs actuals. Schema change needed. |

#### AI Tools — Medium Value
| ID | Item | Why |
|----|------|-----|
| A-35 | Smart nudges / proactive alerts | Overdue warnings, deadline approaching, stale tasks. Rule-based, no LLM. |
| A-41 | Energy-aware suggestions (enhanced) | Peak hours in settings, time-of-day recommendations. |
| A-42 | Habit / recurring task intelligence | Detect cadence patterns, suggest recurring tasks. |
| A-43 | Project planning from description | "Plan a product launch" -> full project with tasks. |
| A-44 | Adaptive learning (preference tracking) | Track accept/reject of AI suggestions. |
| A-48 | Plugin-contributed AI tools | Let plugins register custom tools at runtime. Architecture already supports this. |

#### Integration Ideas
| ID | Item | Why |
|----|------|-----|
| A-18 | AI reminders via integrations | Discord bot, Google Calendar, etc. |
| A-45 | ICS calendar export/import | .ics files for calendar interop. |
| A-47 | Auto-scheduling into time blocks | Algorithmic scheduling. Motion/Morgen-inspired. |
| L-08 | Interactive CLI task picker | Fuzzy find for CLI. |

### Future Milestones (not started)

#### v1.5 — Saydo Sync
- Sync server architecture (ASF-hosted)
- User accounts and authentication
- End-to-end encrypted task sync
- Conflict resolution for concurrent edits
- Sync client in desktop app
- Subscription management and billing

#### v2.0 — Mobile
- React Native iOS app
- React Native Android app
- PWA for browser-based mobile access
- Push notifications for reminders
- Mobile-optimized UI (responsive layout already done)

#### v3.0 — Web App
- Full browser-based client
- Collaborative features (shared projects, team sync)
- Enterprise tier (SSO, admin controls, audit logs)

### Plugin Ideas (community or built-in)
- CalDAV sync plugin (Nextcloud, iCloud, Google Calendar)
- Git sync plugin (free alternative to Saydo Sync)
- WebDAV sync plugin (self-hosted)
- Kanban board plugin (column-based views)
- Time tracking plugin (with reports)
- Habit tracker plugin (streaks)
- Discord reminder plugin
- Webhooks plugin (trigger on task events)
- Email-to-task plugin
- Browser extension (quick-add)
- Widget support (system tray / menu bar)

## Sprint History

32 sprints completed. See [SPRINTS.md](../planning/SPRINTS.md) for full history.

| Sprint | Theme | Tests After |
|--------|-------|-------------|
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
| S23 | Rebrand (Docket -> Saydo) | 772 |
| S24 | Local Voice Models | 813 |
| S25 | Project & Reminder Tools | 857 |
| S26 | Inworld TTS & Mobile UI | 960 |
| S27 | Settings & AI Quick Wins | 960 |
| S28 | Sound Effects | 988 |
| S29 | Voice Call & Tag Tools | 1018 |
| S30-31 | GitHub Issues batch | 1018+ |
| S32 | Frontend Enhancements | 1018+ |

## Known Technical Debt

1. **`src/main.ts:24`** — TODO: Start UI or CLI based on context (currently assumes UI)
2. **Roadmap `v1.5` line** — "Local AI voice models" marked as "testing in progress" but actually done (S24)
3. **No E2E tests** — Unit/integration coverage is strong but no Playwright/Cypress browser tests yet
4. **No `.env` committed** — Only `.env.example` exists; new devs need to create `.env` manually
