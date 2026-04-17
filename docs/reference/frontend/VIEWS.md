# Frontend Views Reference

This document describes the view layer under `src/ui/views/`. It focuses on responsibilities, routing shape, and composition boundaries rather than exact line counts or implementation inventories.

## What Counts As A View

In Junban, a view is a screen-level component responsible for composing existing UI building blocks into a routed experience.

Views usually:

- receive filtered app data and action callbacks
- choose the right layout for a feature
- coordinate feature-level subcomponents
- avoid owning core business rules directly

Most reusable UI pieces should still live in `src/ui/components/` or `src/ui/views/<feature>/` helpers rather than inside a giant route component.

## Main View Areas

The view layer currently includes:

- task-list and planning views
- project-specific views
- calendar views
- settings surfaces
- AI and plugin-owned view surfaces
- lightweight utility views such as quick capture

## Core Routed Views

### Inbox

`src/ui/views/Inbox.tsx`

Purpose:

- default task capture and inbox processing surface
- unscheduled or unassigned task work

Typical composition:

- task input
- task list
- inbox-specific filtering and counts

### Today

`src/ui/views/Today.tsx`

Purpose:

- day-focused work surface
- due-today and overdue task handling
- daily workload and capacity feedback

Related local helpers live in `src/ui/views/today/`.

### Upcoming

`src/ui/views/Upcoming.tsx`

Purpose:

- forward-looking date-based planning
- grouping by upcoming due dates
- rescheduling and overdue handling

### Project

`src/ui/views/Project.tsx`

Purpose:

- project-specific work surface
- layout selection for different project views
- section-aware project organization

Related helpers live in `src/ui/views/project/`.

### Board

`src/ui/views/Board.tsx`

Purpose:

- kanban-style task organization for project work
- drag-and-drop movement between sections/columns

### Calendar

`src/ui/views/Calendar.tsx`

Purpose:

- date-driven task planning and navigation
- day/week/month mode coordination

Related subviews and hooks live in `src/ui/views/calendar/`.

Calendar helper files:

| File                                             | Responsibility                        |
| ------------------------------------------------ | ------------------------------------- |
| `src/ui/views/calendar/CalendarDayView.tsx`      | Day-mode calendar layout              |
| `src/ui/views/calendar/CalendarWeekView.tsx`     | Week-mode calendar layout             |
| `src/ui/views/calendar/CalendarMonthView.tsx`    | Month-mode calendar layout            |
| `src/ui/views/calendar/useCalendarNavigation.ts` | Shared calendar date-navigation logic |

## Built-In Plugin-Backed Views

These views are routed through the app shell but conceptually behave like built-in plugin surfaces.
Keep their routing assumptions aligned with the `plugin-view` notes in [`HOOKS.md`](HOOKS.md) and with plugin view registration behavior.

### Matrix

`src/ui/views/Matrix.tsx`

Purpose:

- Eisenhower-style priority organization

### Stats

`src/ui/views/Stats.tsx`

Purpose:

- productivity and completion metrics
- visual summary of work patterns

### Completed

`src/ui/views/Completed.tsx`

Purpose:

- history view for completed work

### Cancelled

`src/ui/views/Cancelled.tsx`

Purpose:

- archived/cancelled work review and recovery

### Someday

`src/ui/views/Someday.tsx`

Purpose:

- parked work and maybe-later tasks

### Filters And Labels

`src/ui/views/FiltersLabels.tsx`

Purpose:

- saved filters and label/tag management

### Filter View

`src/ui/views/FilterView.tsx`

Purpose:

- render the result of a selected saved or generated filter

### Task Page

`src/ui/views/TaskPage.tsx`

Purpose:

- full-page task detail editing and navigation

### Dopamine Menu

`src/ui/views/DopamineMenu.tsx`

Purpose:

- low-friction, quick-win task selection

### Quick Capture

`src/ui/views/QuickCapture.tsx`

Purpose:

- stripped-down capture flow for the quick-capture window
- minimal chrome, optimized for rapid entry

## AI And Plugin Views

### AI Chat

`src/ui/views/AIChat.tsx`

Purpose:

- full-screen AI chat surface
- wraps shared AI chat UI in routed view form

Important note:

- AI providers are feature-scoped, so AI surfaces should preserve lazy mounting patterns where possible.

### Plugin View

`src/ui/views/PluginView.tsx`

Purpose:

- render a plugin-registered custom view
- bridge plugin UI registrations into the routed app shell

This view should stay aligned with the plugin UI registry and plugin API surface.

## Settings Surfaces

`src/ui/views/Settings.tsx` is the main settings shell.

- The primary split is now `Essentials` vs `Features`.
- `Essentials` keeps baseline task-app preferences like date/time, task defaults, and filters/labels management.
- `Features` collects optional workflow tweaks like quick capture, sound, notifications, nudges, and feature toggles so first-run settings feel lighter.
- The surrounding tab labels are intentionally product-facing: `Filters & Labels`, `AI`, `Voice`, `Templates`, `Data`, and `About`. The plugin-management settings surface remains implemented in the codebase but is intentionally hidden from the MVP UI.
- First-run copy intentionally nudges users toward the `Minimal` preset, and `Templates` now sits later in the settings flow so it does not crowd the first-run essentials.

It is responsible for:

- desktop modal layout
- mobile drill-down layout
- tab switching
- lazy tab loading

Settings tab implementations live in `src/ui/views/settings/`.

Current tab implementations:

| File                                      | Responsibility                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/ui/views/settings/GeneralTab.tsx`    | Core essentials such as date/time, task defaults, startup, notifications, sounds, and nudges |
| `src/ui/views/settings/AppearanceTab.tsx` | Theme, density, font, and other visual preferences                                           |
| `src/ui/views/settings/FiltersLabelsTab.tsx` | Saved filter and label management moved into Settings                                      |
| `src/ui/views/settings/FeaturesTab.tsx`   | Optional workflow toggles and feature-level settings                                         |
| `src/ui/views/settings/KeyboardTab.tsx`   | Shortcut customization                                                                       |
| `src/ui/views/settings/TemplatesTab.tsx`  | Template management                                                                          |
| `src/ui/views/settings/AITab.tsx`         | AI provider, briefing, memory, and instruction settings                                      |
| `src/ui/views/settings/VoiceTab.tsx`      | Voice provider, microphone, and local model settings                                         |
| `src/ui/views/settings/DataTab.tsx`       | Import, export, and storage/data actions                                                     |
| `src/ui/views/settings/AboutTab.tsx`      | Version, update, and about information                                                       |

Important helper directories:

| Path                                   | Responsibility                                     |
| -------------------------------------- | -------------------------------------------------- |
| `src/ui/views/settings/general/`       | Smaller settings sections used by `GeneralTab.tsx` |
| `src/ui/views/settings/ai/`            | AI settings subsections and constants              |
| `src/ui/views/settings/voice/`         | Voice settings subsections                         |
| `src/ui/views/settings/components.tsx` | Shared settings UI building blocks                 |

Today view helpers:

| File                                         | Responsibility                            |
| -------------------------------------------- | ----------------------------------------- |
| `src/ui/views/today/TodayHeader.tsx`         | Today header and summary controls         |
| `src/ui/views/today/TodayTaskList.tsx`       | Task list rendering for the Today surface |
| `src/ui/views/today/WorkloadCapacityBar.tsx` | Workload/capacity visualization           |
| `src/ui/views/today/useWeeklyReviewData.ts`  | Weekly-review data shaping                |
| `src/ui/views/today/today-utils.ts`          | Shared Today view helpers                 |

Project view helpers:

| File                                       | Responsibility                                |
| ------------------------------------------ | --------------------------------------------- |
| `src/ui/views/project/ProjectHeader.tsx`   | Project-level header, actions, and metadata   |
| `src/ui/views/project/ProjectSections.tsx` | Section-aware project layout and organization |

When changing settings UX, update this doc and `docs/reference/frontend/CONTEXT.md` if the provider wiring or feature-scoped mounting model changes.

## Routing And Composition Notes

Routing is coordinated above the views, primarily through the app shell and routing hooks rather than each individual view owning its own router.

In practice, views should assume they are being composed by:

- `src/ui/App.tsx`
- `src/ui/app/AppLayout.tsx`
- related app-level hooks such as routing and app-state hooks

When a view starts growing substantial internal structure, prefer moving feature-specific helpers into a sibling folder under `src/ui/views/` rather than inflating the main route component.

## Design Constraints

When editing views:

1. Keep business logic in core/services or dedicated hooks.
2. Keep reusable UI in components or feature helpers, not duplicated across views.
3. Verify mobile behavior as well as desktop behavior.
4. Check keyboard interactions for views that participate in app navigation or task workflows.
5. Preserve feature-scoped AI and voice mounting where relevant.

## Related Docs

- `docs/reference/frontend/COMPONENTS.md`
- `docs/reference/frontend/CONTEXT.md`
- `docs/reference/frontend/HOOKS.md`
- `docs/reference/frontend/API_LAYER.md`
- `docs/reference/backend/PLUGINS.md`
- `docs/guides/ARCHITECTURE.md`
