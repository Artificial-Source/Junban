# V2-39: Joyful Micro-animations

## Context

ASF Junban is a local-first, AI-native task manager. Tech stack: Node 22+, TypeScript strict mode, React + Tailwind CSS, Vite, pnpm.

**Current state:** Animations use only Tailwind `transition-*` utilities. No animation library is installed. The goal is to add Framer Motion for polished completion animations, smooth view transitions, and playful micro-interactions — the "Amie/Things 3 feeling."

**Design philosophy:** Animations must be subtle and fast. They enhance UX, never distract. Spring physics preferred over linear easing. Every animation must respect `prefers-reduced-motion`.

### Key files

| File                                   | Role                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| `src/ui/components/TaskItem.tsx`       | Task rows — completion, deletion, reordering           |
| `src/ui/components/TaskList.tsx`       | List container — add/remove task animations            |
| `src/ui/components/Sidebar.tsx`        | Facade — internals in `src/ui/components/sidebar/`     |
| `src/ui/components/CommandPalette.tsx` | Modal overlay                                          |
| `src/ui/components/AIChatPanel.tsx`    | AI chat slide-in panel                                 |
| `src/ui/App.tsx`                       | Facade — internals in `src/ui/app/` (view transitions) |
| `src/ui/context/SettingsContext.tsx`   | Settings context (add `reducedMotion` here)            |
| `src/utils/sounds.ts`                  | Sound effects — sync animations with existing sounds   |

---

## Phase 1: Install + Setup

### 1.1 Install Framer Motion

```bash
pnpm add framer-motion
```

### 1.2 Create `src/ui/components/AnimatedPresence.tsx`

A wrapper component that provides Framer Motion's `AnimatePresence` with a `prefers-reduced-motion` check. When reduced motion is active (either OS preference or user setting), this component should render children without animation wrappers.

Requirements:

- Import `AnimatePresence` from `framer-motion`
- Read `reducedMotion` from settings context
- Also check `window.matchMedia('(prefers-reduced-motion: reduce)')` as a fallback
- When reduced motion is enabled, render children directly without `AnimatePresence`
- Export a `useReducedMotion` hook that combines the OS media query with the settings context value
- Named export only (no default export)

### 1.3 Create `src/ui/utils/animation-variants.ts`

Shared animation presets using Framer Motion's `Variants` type. All durations should be fast (150-300ms). Use spring physics where applicable.

Define these variant presets:

- **`fadeIn`** — opacity 0 → 1, duration 200ms
- **`fadeOut`** — opacity 1 → 0, duration 150ms
- **`slideInRight`** — x: 24 → 0, opacity 0 → 1, spring with stiffness ~300, damping ~30
- **`slideInLeft`** — x: -24 → 0, same spring config
- **`slideOutLeft`** — x: 0 → -100, opacity 1 → 0, duration 200ms
- **`scaleIn`** — scale: 0.95 → 1, opacity 0 → 1, spring with stiffness ~400, damping ~25
- **`scaleOut`** — scale: 1 → 0.95, opacity 1 → 0, duration 150ms
- **`listItem`** — enter: opacity 0 → 1, y: -8 → 0, spring; exit: opacity 1 → 0, height → 0, overflow hidden
- **`checkmark`** — pathLength 0 → 1, spring with stiffness ~400, damping ~20 (for SVG path animation)
- **`subtlePulse`** — scale: [1, 1.04, 1], loop, duration 2s (for priority badges)
- **`crossfade`** — opacity 0 → 1, duration 200ms (for view transitions)

Also export a `springPresets` object:

- `snappy`: stiffness 400, damping 25, mass 0.5
- `gentle`: stiffness 200, damping 20, mass 0.8
- `bouncy`: stiffness 500, damping 15, mass 0.5

### 1.4 Add `reducedMotion` setting

In the settings context (`src/ui/context/SettingsContext.tsx`):

- Add `reducedMotion: boolean` to the settings state
- Default: `true` if `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, otherwise `false`
- Persist to storage like other settings
- Add a toggle in the Appearance settings tab

### Code Reviewer Checkpoint

Before proceeding, verify:

- [ ] `pnpm build` succeeds with no errors
- [ ] `pnpm test` passes — no regressions
- [ ] `AnimatedPresence` properly short-circuits when reduced motion is on
- [ ] All animation variants use fast durations (< 300ms)
- [ ] No default exports — named exports only
- [ ] TypeScript strict mode satisfied — no `any` types

---

## Phase 2: Task Animations

### 2.1 Task Completion Animation (`TaskItem.tsx`)

When a task is completed:

1. Checkmark SVG path animates in using the `checkmark` variant (pathLength 0 → 1)
2. The task row text gets a subtle strikethrough animation (opacity transition on a pseudo-element or overlay)
3. After a short delay (~400ms), the row scales down slightly and fades out using `listItem` exit variant
4. Sync with existing completion sound effect in `src/utils/sounds.ts`

Implementation:

- Wrap TaskItem in `motion.div` with `layout` prop for smooth reorder animations
- Use `AnimatePresence` mode `"popLayout"` for exit animations
- The completion animation should feel satisfying — the checkmark "draws in" with spring physics
- Keep the component's existing structure; add motion props alongside existing Tailwind classes

### 2.2 Task Deletion Animation (`TaskItem.tsx`)

When a task is deleted:

- Slide out to the left using `slideOutLeft` variant
- Row height collapses smoothly after the slide
- Duration: ~200ms total

### 2.3 List Animations (`TaskList.tsx`)

- Wrap the task list in the `AnimatedPresence` component
- New tasks animate in using `listItem` enter variant (subtle slide-down + fade)
- Removed tasks use their exit animations from TaskItem
- Use `layout` prop on each item for smooth reorder transitions when tasks are sorted/filtered
- Stagger children entrance by 30ms when a list first loads (use `staggerChildren` in parent variant)

### Code Reviewer Checkpoint

Before proceeding, verify:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] Completion animation plays fully before the task is removed from the list
- [ ] No layout shift during animations — `layout` prop handles repositioning
- [ ] Animations are imperceptible with reduced motion enabled (instant transitions)
- [ ] Task keyboard navigation still works (arrow keys, enter to complete)
- [ ] No performance degradation with 100+ tasks in view

---

## Phase 3: View & Modal Transitions

### 3.1 View Transitions (`src/ui/app/`)

Add crossfade transitions between views (Inbox, Today, Upcoming, Project, etc.):

- Wrap the view renderer in `AnimatePresence` with `mode="wait"`
- Use `crossfade` variant — simple opacity transition, ~200ms
- Key the animated wrapper by the current route/view
- Keep it subtle — users switch views frequently, so transitions must be fast and non-jarring

### 3.2 Command Palette (`CommandPalette.tsx`)

- Backdrop: fade in from transparent to `bg-black/50`, duration 150ms
- Modal: `scaleIn` variant — scale from 0.95 → 1 with spring, starting from center
- Exit: `scaleOut` + backdrop fade, duration 150ms
- Use `AnimatePresence` for enter/exit

### 3.3 AI Chat Panel (`AIChatPanel.tsx`)

- Slide in from right using `slideInRight` variant
- Exit: slide out to right
- Width transition should be smooth (use `layout` or animate `width`)

### 3.4 Sidebar

In `src/ui/components/sidebar/`:

- Expand/collapse: animate width with spring physics (`gentle` preset)
- Section expand/collapse (project tree): animate height with `overflow: hidden`
- Navigation item hover: subtle background color transition (keep as Tailwind `transition-colors`)

### 3.5 Modal Dialogs

For any modal/dialog components:

- Use `scaleIn`/`scaleOut` with `springPresets.snappy`
- Backdrop fade, same as CommandPalette

### Code Reviewer Checkpoint

Before proceeding, verify:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] View transitions do not cause React key warnings or double-renders
- [ ] Command Palette open/close feels snappy (< 200ms perceived)
- [ ] Sidebar animation does not cause content reflow/jank
- [ ] All transitions disabled when reduced motion is on
- [ ] No flash of unstyled content during view transitions

---

## Phase 4: Micro-interactions

### 4.1 Button & Interactive Element Hover

- Add subtle scale on hover (1.02) and tap (0.98) to primary action buttons
- Use `motion.button` with `whileHover={{ scale: 1.02 }}` and `whileTap={{ scale: 0.98 }}`
- Apply to: FAB, primary action buttons, icon buttons in toolbar
- Do NOT apply to every button — only primary/important interactive elements
- Keep Tailwind hover styles (color changes) — this adds scale on top

### 4.2 Priority Badge Pulse

- P1 (urgent) tasks: subtle pulse animation on the priority badge using `subtlePulse` variant
- Only in `TaskItem.tsx` priority indicator
- Pulse should be very subtle (scale 1 → 1.04 → 1) and slow (2s loop)
- Disabled when reduced motion is on

### 4.3 Completion Celebration

When a task is completed, add a small particle burst effect:

- Use pure CSS keyframes (no additional library)
- Create `src/ui/components/CompletionBurst.tsx`
- 6-8 small dots that burst outward from the checkbox position and fade out
- Colors: match the current theme's accent color
- Duration: ~600ms
- Trigger alongside the checkmark animation
- This is the "delightful" moment — make it feel rewarding but not over the top

### 4.4 Sound Sync

Ensure animations are timed with existing sound effects:

- Completion sound should play at the start of the checkmark animation
- Use `requestAnimationFrame` to sync if needed
- Reference `src/utils/sounds.ts` for the existing sound API

### Code Reviewer Checkpoint

Before proceeding, verify:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] Hover animations do not cause layout shifts
- [ ] Priority pulse is subtle enough to not be distracting
- [ ] Completion burst particles clean up properly (no orphaned DOM nodes)
- [ ] Animations are GPU-accelerated (transform/opacity only, no width/height animation on frequent interactions)
- [ ] Reduced motion disables all micro-interactions

---

## Phase 5: Tests + Accessibility

### 5.1 Unit Tests for Animation Utilities

Create `tests/ui/utils/animation-variants.test.ts`:

- Test that all variant presets have valid `initial`, `animate`, and `exit` states
- Test that `springPresets` have valid stiffness/damping values
- Test that all durations are under 300ms (except looping animations)

### 5.2 AnimatedPresence Tests

Create `tests/ui/components/AnimatedPresence.test.tsx`:

- Test that children render without motion wrappers when reduced motion is enabled
- Test that `AnimatePresence` is used when reduced motion is disabled
- Test `useReducedMotion` hook returns correct values based on OS preference and settings

### 5.3 Accessibility Verification

- Verify `prefers-reduced-motion: reduce` media query is respected at every animation site
- Test with the `reducedMotion` setting toggled on — all animations should be instant/skipped
- No animation should convey information that isn't also conveyed without animation (e.g., completion state is shown by strikethrough text + status, not just the animation)

### 5.4 Performance Checks

- Run `pnpm build` and verify bundle size increase is reasonable (Framer Motion tree-shakes well)
- Manually verify no layout thrashing with browser DevTools Performance tab
- Animations should use `transform` and `opacity` only (GPU-composited properties)

### Code Reviewer Checkpoint

Before proceeding, verify:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes — all new tests green
- [ ] Bundle size increase is documented
- [ ] Reduced motion fully tested
- [ ] No accessibility regressions

---

## Definition of Done

- [ ] Framer Motion installed and configured
- [ ] `AnimatedPresence` wrapper with reduced-motion support
- [ ] Shared animation variants in `animation-variants.ts`
- [ ] `reducedMotion` setting in settings context (respects OS default)
- [ ] Task completion: checkmark draw-in + scale-down + fade-out + particle burst
- [ ] Task deletion: slide-out left with height collapse
- [ ] Task list: enter/exit animations with stagger on initial load
- [ ] Drag reorder: smooth layout animations
- [ ] View transitions: crossfade between routes (~200ms)
- [ ] Command Palette: scale-in/out with backdrop
- [ ] AI Chat Panel: slide-in from right
- [ ] Sidebar: smooth width expand/collapse
- [ ] Button hover: subtle scale on primary actions
- [ ] P1 priority badge: subtle pulse
- [ ] Completion celebration: CSS particle burst
- [ ] All animations synced with existing sound effects
- [ ] `prefers-reduced-motion` respected everywhere (OS + setting)
- [ ] Unit tests for variants and AnimatedPresence
- [ ] No layout shifts, no jank, no orphaned DOM nodes
- [ ] `pnpm build` succeeds, `pnpm test` passes
- [ ] Bundle size increase documented in sprint results

## Final Code Reviewer

Run through the complete checklist:

- [ ] `pnpm check` passes (lint + typecheck + test)
- [ ] No `any` types introduced
- [ ] No default exports — named exports only
- [ ] All new files follow project structure conventions
- [ ] Conventional commit: `feat(ui): add Framer Motion micro-animations (V2-39)`
- [ ] Animations feel "Amie/Things 3" — satisfying, fast, never in the way
- [ ] Reduced motion is a first-class concern, not an afterthought
- [ ] No new dependencies beyond `framer-motion`
