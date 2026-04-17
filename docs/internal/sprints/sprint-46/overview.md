# Sprint S46 — Housekeeping + Global Quick Capture

## Goal

Clean up roadmap tracking, expand E2E test coverage for key views, and ship the Global Quick Capture feature (Tauri system-wide hotkey for instant task entry).

## Items

| ID    | Item                                                                | Status |
| ----- | ------------------------------------------------------------------- | ------ |
| HK-01 | Tick v1.1 roadmap checkboxes (timeblocking done)                    | done   |
| HK-02 | Expand E2E test coverage (Today, Inbox, Project, Settings, AI Chat) | done   |
| V2-18 | Global Quick Capture (Tauri system-wide hotkey)                     | done   |

## Constraints

- V2-18 requires Tauri APIs — won't work in browser dev mode
- E2E tests should use existing Playwright setup from `tests/e2e/`
- Roadmap update is a docs-only change

## Prompts

- `prompts/01-housekeeping.md` — Roadmap cleanup + E2E expansion
- `prompts/02-global-quick-capture.md` — Tauri system-wide hotkey feature
