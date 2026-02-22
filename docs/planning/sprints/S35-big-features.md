# Sprint 35 — "Big Features"

**Goal**: Add major v2.0 features — kanban board, productivity stats, comments/activity, cancelled/someday views, deadlines, and comprehensive test coverage.

| ID | Item | Status |
|----|------|--------|
| C-16 | Project sections service (CRUD + reordering) | done |
| C-17 | Productivity stats service (streaks, daily metrics) | done |
| C-18 | Task comments and activity tracking | done |
| C-19 | Task deadlines and time estimates fields | done |
| P-08 | NLP deadline and duration parsing (~30m, deadline:fri) | done |
| D-13 | DB migration: daily_stats, sections, task_comments, task_activity tables | done |
| U-36 | Board / Kanban view with DnD Kit drag-and-drop | done |
| U-37 | Cancelled tasks view with restore functionality | done |
| U-38 | Someday / Maybe view for parked tasks | done |
| U-39 | Stats / Productivity view (cards + 7-day bar chart) | done |
| U-40 | ChordIndicator component for multi-key shortcuts | done |
| U-41 | Features settings tab (9 toggleable features) | done |
| A-58 | Productivity stats AI tool (get_productivity_stats) | done |
| — | Comments, sections, stats API modules (dual Tauri/web) | done |
| — | Storage interface + SQLite/Markdown backend extensions | done |
| — | 80+ new unit/component tests | done |
| — | 12 Playwright E2E spec files | done |
| — | Fix all lint errors and apply Prettier formatting | done |

**Result**: Nine v2.0 Tier 1 features shipped in one sprint. Kanban board with drag-and-drop sections, productivity stats with streak tracking, task comments and activity log, cancelled/someday views, deadline and duration support. 1774 passing tests across 153 test files. CI lint errors resolved.
