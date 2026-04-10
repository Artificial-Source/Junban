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

## Calendar Subviews

Calendar-specific files live in `src/ui/views/calendar/`.

Current structure includes:

- day view
- week view
- month view
- calendar navigation hook(s)

The parent `Calendar.tsx` coordinates mode switching and top-level navigation; the subviews handle the actual calendar layouts.

## Settings Surfaces

`src/ui/views/Settings.tsx` is the main settings shell.

- The primary split is now `Essentials` vs `Advanced`.
- `Essentials` keeps baseline task-app preferences like date/time and task defaults.
- `Advanced` collects optional workflow tweaks like quick capture, sound, notifications, nudges, and feature toggles so first-run settings feel lighter.
- The surrounding tab labels are intentionally product-facing: `AI`, `Voice`, `Extensions`, `Templates`, `Data`, and `About`.
- First-run copy intentionally nudges users toward the `Minimal` preset, and `Templates` now sits later in the settings flow so it does not crowd the first-run essentials.

It is responsible for:

- desktop modal layout
- mobile drill-down layout
- tab switching
- lazy tab loading

Settings tab implementations live in `src/ui/views/settings/`.

Current tab areas include:

- essentials
- appearance
- advanced
- keyboard
- templates
- AI
- voice
- extensions
- data
- about

When changing settings UX, update this doc and `docs/frontend/CONTEXT.md` if the provider wiring or feature-scoped mounting model changes.

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

- `docs/frontend/COMPONENTS.md`
- `docs/frontend/CONTEXT.md`
- `docs/frontend/HOOKS.md`
- `docs/frontend/API_LAYER.md`
- `docs/backend/PLUGINS.md`
- `docs/guides/ARCHITECTURE.md`
