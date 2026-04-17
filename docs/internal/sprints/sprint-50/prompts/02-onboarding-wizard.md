# S50-P2: Enhanced Quick Start Wizard (5-Step Onboarding)

## Context

You are working on ASF Junban, an AI-native task manager. The current onboarding is a 3-step modal that says "welcome / NLP input / done" — it's too brief and doesn't help users customize their experience.

**Tech stack:** React + TypeScript + Tailwind CSS, Lucide icons, Vite bundler, Vitest tests, pnpm.

We're replacing it with a 5-step wizard that lets users pick their look and feature level.

## File to Modify

`src/ui/components/OnboardingModal.tsx` — complete rewrite.

## Current Onboarding

Read the file first. It's a 3-step modal with simple next/back/skip navigation. The `onComplete` callback is called when the user finishes or skips.

## New 5-Step Wizard Design

### Step 1: Welcome

- Icon: Sparkles (lucide-react)
- Title: "Welcome to Junban"
- Subtitle: "Your task manager. Simple, smart, yours."
- Visual: Centered icon with accent glow
- Just a "Get Started" button (no skip on this step)

### Step 2: Pick Your Look

- Title: "Pick your look"
- Three theme cards side by side (or stacked on mobile):
  - **Light** — white card preview with sun icon
  - **Dark** — dark card preview with moon icon
  - **Nord** — nord-colored card preview with mountain/snowflake icon
- Below: Accent color picker — show 6-8 preset accent colors as circles (reuse the color palette from AddProjectModal). The current DEFAULT_PROJECT_COLORS from `src/config/defaults.ts` is a good source.
- Selection applies immediately (call `updateSetting("accent_color", color)` and apply theme)
- For theme switching, use the same mechanism the app uses. Check how themes are applied — read `src/ui/themes/manager.ts` to understand the theme switching API. The Settings > Appearance tab (`src/ui/views/settings/AppearanceTab.tsx`) already does this — reuse that pattern.

### Step 3: Choose Your Style

- Title: "How much do you want to see?"
- Three radio-style cards:

**Minimal** (default, pre-selected):

- Icon: Minus or Layout (lucide)
- Label: "Minimal"
- Description: "Just the essentials — Inbox, Today, Upcoming"
- Features enabled: feature_sections, feature_kanban, feature_deadlines, feature_duration, feature_comments
- Everything else OFF

**Standard**:

- Icon: LayoutGrid or Layers (lucide)
- Label: "Standard"
- Description: "Core views plus calendar, completed tasks, and stats"
- Additional features ON: feature_calendar, feature_completed, feature_stats, feature_someday, nudge_enabled, nudge_overdue_alert, nudge_deadline_approaching

**Power User**:

- Icon: Rocket or Zap (lucide)
- Label: "Everything"
- Description: "All views and productivity features enabled"
- ALL feature*\* flags ON, all nudge*\* ON, eat_the_frog_enabled ON, feature_chords ON

### Step 4: AI Assistant (Optional)

- Title: "AI Assistant"
- Subtitle: "Junban has a built-in AI that can help manage your tasks. You can set this up now or later in Settings."
- Two options:
  - **"Set up later"** button (secondary style) — skips, moves to step 5
  - **"I'll configure it now"** button (primary style) — sets a flag, moves to step 5. After onboarding closes, the app should open Settings > AI tab. To do this, pass an `onRequestOpenSettings?: (tab: string) => void` prop to OnboardingModal.
- Show a small preview/illustration of the AI chat (just decorative, not functional)
- This step should feel light — no forms, no API key input. Just awareness.

### Step 5: You're Ready

- Icon: CheckCircle2 (lucide)
- Title: "You're all set!"
- Subtitle: "Start adding tasks. Discover more features anytime in Settings."
- Three quick tips as small cards:
  - "Type naturally: 'buy milk tomorrow p1 #groceries'"
  - "Press Ctrl+K for the command palette"
  - "Explore plugins in Settings for more power"
- "Start using Junban" button (primary, accent colored)

## Implementation Notes

### Props Interface

```typescript
interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
  onRequestOpenSettings?: (tab: string) => void;
}
```

### State

```typescript
const [step, setStep] = useState(0);
const [selectedTheme, setSelectedTheme] = useState<"light" | "dark" | "nord">("light");
const [selectedAccent, setSelectedAccent] = useState("#3b82f6");
const [selectedPreset, setSelectedPreset] = useState<"minimal" | "standard" | "power">("minimal");
const [wantsAI, setWantsAI] = useState(false);
```

### Applying Settings

Use `useGeneralSettings()` from `src/ui/context/SettingsContext.tsx` to call `updateSetting()`.

When the user clicks "Start using Junban" on the final step:

1. Apply the selected preset's feature flags via `updateSetting()` for each flag
2. Apply theme and accent color
3. Call `onComplete()`
4. If `wantsAI`, call `onRequestOpenSettings?.("ai")`

### Preset Application

Create a helper function:

```typescript
const PRESETS = {
  minimal: {
    feature_calendar: "false",
    feature_filters_labels: "false",
    feature_completed: "false",
    feature_cancelled: "false",
    feature_matrix: "false",
    feature_stats: "false",
    feature_someday: "false",
    feature_chords: "false",
    feature_dopamine_menu: "false",
    eat_the_frog_enabled: "false",
    nudge_enabled: "false",
  },
  standard: {
    feature_calendar: "true",
    feature_filters_labels: "false",
    feature_completed: "true",
    feature_cancelled: "false",
    feature_matrix: "false",
    feature_stats: "true",
    feature_someday: "true",
    feature_chords: "false",
    feature_dopamine_menu: "false",
    eat_the_frog_enabled: "false",
    nudge_enabled: "true",
    nudge_overdue_alert: "true",
    nudge_deadline_approaching: "true",
    nudge_stale_tasks: "false",
    nudge_empty_today: "false",
    nudge_overloaded_day: "false",
  },
  power: {
    feature_calendar: "true",
    feature_filters_labels: "true",
    feature_completed: "true",
    feature_cancelled: "true",
    feature_matrix: "true",
    feature_stats: "true",
    feature_someday: "true",
    feature_chords: "true",
    feature_dopamine_menu: "true",
    eat_the_frog_enabled: "true",
    eat_the_frog_morning_only: "true",
    nudge_enabled: "true",
    nudge_overdue_alert: "true",
    nudge_deadline_approaching: "true",
    nudge_stale_tasks: "true",
    nudge_empty_today: "true",
    nudge_overloaded_day: "true",
  },
} as const;
```

### Styling

- Use the same modal backdrop as the current onboarding: `fixed inset-0 z-50 bg-black/40 backdrop-blur-sm`
- Card width: `max-w-lg` (slightly wider than current `max-w-md` to fit theme cards)
- Progress indicator: keep the dots from the current design (they look good)
- Animate step transitions with a subtle fade (CSS transition or simple conditional rendering)
- Theme preview cards: 120px wide, rounded-xl, with a mini mock of a task list (just colored rectangles)
- Accent color circles: 28px, same style as AddProjectModal color picker
- Preset cards: bordered, clickable, with a radio-dot indicator and subtle accent border when selected
- All cards should have hover states
- Responsive: on mobile (< 640px), stack theme cards vertically

### App.tsx Integration

The parent `App.tsx` (around line 1017-1023) renders the OnboardingModal. You need to:

1. Add the `onRequestOpenSettings` prop — when called, it should navigate to settings and select the specified tab. Look at how `App.tsx` currently opens settings to understand the pattern.

## Testing

After implementation:

1. `pnpm exec tsc --noEmit` — no type errors
2. `pnpm exec eslint src/ui/components/OnboardingModal.tsx` — no lint errors
3. `pnpm test` — all tests pass
4. Verify the preset maps reference only valid setting keys from GeneralSettings

**After completing all work, invoke the Code Reviewer sub-agent for a final pass over all changes. Verify type safety, consistent styling, and that the wizard correctly applies all settings on completion.**
