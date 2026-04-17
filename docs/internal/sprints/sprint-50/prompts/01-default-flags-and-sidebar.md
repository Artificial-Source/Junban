# S50-P1: Flip Default Feature Flags + Sidebar Cleanup

## Context

You are working on ASF Junban, an AI-native task manager. The app currently shows too many features out of the box — 11 sidebar nav items, all feature flags ON. We're simplifying the first-run experience so new users see only the essentials.

**Tech stack:** React + TypeScript + Tailwind CSS, Vite bundler, Vitest tests, pnpm package manager.

**Key principle:** Existing users' settings are NOT affected. We're only changing the defaults that apply when a setting has never been set (first install).

## Phase 1: Flip Default Settings

**File:** `src/ui/context/SettingsContext.tsx`

### 1a. Add `feature_dopamine_menu` to the GeneralSettings interface

In the `GeneralSettings` interface (around line 4-50), add:

```typescript
feature_dopamine_menu: "true" | "false";
```

### 1b. Change DEFAULT_SETTINGS (around line 52-98)

Change these defaults from `"true"` to `"false"`:

```
feature_someday: "false",
feature_stats: "false",
feature_chords: "false",
feature_cancelled: "false",
feature_matrix: "false",
feature_calendar: "false",
feature_filters_labels: "false",
feature_completed: "false",
eat_the_frog_enabled: "false",
eat_the_frog_morning_only: "false",
nudge_enabled: "false",
nudge_overdue_alert: "false",
nudge_deadline_approaching: "false",
nudge_stale_tasks: "false",
nudge_empty_today: "false",
nudge_overloaded_day: "false",
```

Add the new flag:

```
feature_dopamine_menu: "false",
```

Keep these as `"true"` (core experience):

```
feature_sections: "true",
feature_kanban: "true",
feature_deadlines: "true",
feature_duration: "true",
feature_comments: "true",
```

**Before proceeding to Phase 2, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

## Phase 2: Wire Dopamine Menu to Feature Flag

### 2a. Add to NAV_FEATURE_MAP

**File:** `src/ui/components/sidebar/SidebarPrimitives.tsx` (around line 83-91)

Add `"dopamine-menu"` to the `NAV_FEATURE_MAP`:

```typescript
export const NAV_FEATURE_MAP: Record<string, keyof GeneralSettings> = {
  calendar: "feature_calendar",
  "filters-labels": "feature_filters_labels",
  completed: "feature_completed",
  cancelled: "feature_cancelled",
  matrix: "feature_matrix",
  stats: "feature_stats",
  someday: "feature_someday",
  "dopamine-menu": "feature_dopamine_menu",
};
```

### 2b. Add to FeaturesTab

**File:** `src/ui/views/settings/FeaturesTab.tsx`

Add the dopamine menu entry to the FEATURES array:

```typescript
{
  key: "feature_dopamine_menu",
  label: "Quick Wins / Dopamine Menu",
  description: "A fun way to pick easy tasks when you need a quick win",
},
```

**Before proceeding to Phase 3, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

## Phase 3: Clean Up Sidebar Sections

**File:** `src/ui/components/sidebar/ViewNavigation.tsx`

The sidebar has several collapsible sections that should only render when they have content. Check each section:

1. **Favorite Views** section — only render if `favoriteNavItems.length > 0`
2. **Favorites** (favorite projects) section — only render if `favoriteProjects.length > 0`
3. **My Views** (saved filters) section — only render if `savedFilters.length > 0`
4. **Tools** section — only render if there are active plugin panels (`panels.length > 0`) or plugin views in the tools slot (`viewsBySlot.tools.length > 0`)

Read the full `ViewNavigation.tsx` file to understand how sections are currently rendered, then add the appropriate conditional checks. These sections already have expand/collapse behavior — we're just hiding them entirely when empty.

## Phase 4: Add Feature Categories to FeaturesTab

**File:** `src/ui/views/settings/FeaturesTab.tsx`

Reorganize the features into labeled groups:

```typescript
const FEATURE_GROUPS = [
  {
    title: "Views",
    description: "Additional views in the sidebar",
    features: [
      { key: "feature_calendar", label: "Calendar", description: "..." },
      { key: "feature_completed", label: "Completed tasks", description: "..." },
      { key: "feature_cancelled", label: "Cancelled tasks", description: "..." },
      { key: "feature_someday", label: "Someday / Maybe", description: "..." },
      { key: "feature_matrix", label: "Eisenhower Matrix", description: "..." },
      { key: "feature_stats", label: "Productivity stats", description: "..." },
      { key: "feature_filters_labels", label: "Filters & Labels", description: "..." },
      { key: "feature_dopamine_menu", label: "Quick Wins", description: "..." },
    ],
  },
  {
    title: "Task Features",
    description: "Enhancements to task management",
    features: [
      { key: "feature_sections", label: "Project sections", description: "..." },
      { key: "feature_kanban", label: "Kanban / Board view", description: "..." },
      { key: "feature_duration", label: "Time estimates", description: "..." },
      { key: "feature_deadlines", label: "Deadlines", description: "..." },
      { key: "feature_comments", label: "Comments & activity", description: "..." },
    ],
  },
  {
    title: "Productivity",
    description: "Focus and productivity tools",
    features: [{ key: "feature_chords", label: "Keyboard chords", description: "..." }],
  },
];
```

Keep the existing descriptions from the current FEATURES array. Render each group with a heading and divider.

Add "Enable All" and "Reset to Defaults" buttons at the bottom:

- **Enable All** — sets every `feature_*` to `"true"`
- **Reset to Defaults** — sets every `feature_*` back to DEFAULT_SETTINGS values

Also add nudge and eat-the-frog toggles to the "Productivity" group:

- `eat_the_frog_enabled` — "Eat the Frog" — "Highlight your most-dreaded task each morning"
- `nudge_enabled` — "Smart Nudges" — "Contextual reminders about overdue tasks, deadlines, etc."

**After completing all phases, invoke the Code Reviewer sub-agent for a final pass over all changes. Verify:**

1. TypeScript compiles cleanly (`pnpm exec tsc --noEmit`)
2. ESLint passes (`pnpm exec eslint src/ui/context/SettingsContext.tsx src/ui/components/sidebar/SidebarPrimitives.tsx src/ui/views/settings/FeaturesTab.tsx src/ui/components/sidebar/ViewNavigation.tsx`)
3. All tests pass (`pnpm test`)
4. The new `feature_dopamine_menu` flag is properly typed, defaulted, wired to NAV_FEATURE_MAP, and togglable in FeaturesTab
5. Empty sidebar sections are hidden
