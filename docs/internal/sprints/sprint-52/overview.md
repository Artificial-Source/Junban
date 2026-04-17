# Sprint 52 — Responsive UI Polish

## Goal

Make all views and components fully responsive across phone (320-480px), tablet (768-1024px), and desktop (1024px+). Currently only the core layout (sidebar → drawer, bottom nav) is responsive; individual views have fixed widths, hardcoded grids, and missing breakpoints.

## Agents

| Agent | Scope                          | Files                                                                                              |
| ----- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| R-01  | Views: Board, Matrix, Stats    | Board.tsx, Matrix.tsx, Stats.tsx                                                                   |
| R-02  | Calendar views (week + month)  | CalendarWeekView.tsx, CalendarMonthView.tsx                                                        |
| R-03  | Timeblocking plugin responsive | TimeblockingView.tsx, DayTimeline.tsx, WeekTimeline.tsx                                            |
| R-04  | Panels, modals, detail views   | TaskDetailPanel.tsx, AIChatPanel.tsx, DailyPlanningModal.tsx, WeeklyReviewModal.tsx, Settings tabs |

## Acceptance Criteria

- All views usable on 375px viewport (iPhone SE)
- No horizontal scroll on any view at 375px
- Touch targets minimum 44px
- Grids collapse appropriately (7-col → scrollable or stacked)
- Modals don't overlap bottom nav bar
- All changes are Tailwind classes only (no new CSS files)
