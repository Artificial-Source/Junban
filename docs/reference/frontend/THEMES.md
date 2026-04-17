# Frontend Themes Reference

> The theme system: manager, CSS files, and token/class application details.

---

## Architecture Overview

The theme system uses CSS custom properties (design tokens) defined in theme-specific CSS files. A `ThemeManager` class handles switching between themes at runtime by toggling CSS classes on `<html>`. The system supports three built-in themes (Light, Dark, Nord) plus a "System" option that follows the OS preference.

```
src/config/themes.ts          -- Theme definitions (id, name, type)
src/ui/themes/manager.ts      -- ThemeManager class (runtime switching)
src/ui/themes/light.css        -- Light theme tokens (default)
src/ui/themes/dark.css         -- Dark theme tokens (override via .dark class)
src/ui/themes/nord.css         -- Nord theme tokens (override via .nord class)
src/ui/index.css               -- Imports all theme CSS, defines animations and utilities
```

---

## Theme Definitions

### src/config/themes.ts

- **Purpose:** Defines the `Theme` interface and the `BUILT_IN_THEMES` array.
- **Key Exports:**
  - `Theme` interface: `{ id: string; name: string; type: "light" | "dark" }`
  - `BUILT_IN_THEMES: Theme[]`
- **Built-in Themes:**
  - `{ id: "light", name: "Light", type: "light" }`
  - `{ id: "dark", name: "Dark", type: "dark" }`
  - `{ id: "nord", name: "Nord", type: "dark" }`
- **Used By:** `ThemeManager`, `AppearanceTab.tsx`

---

## Theme Manager

### src/ui/themes/manager.ts

- **Purpose:** Runtime theme management. Handles loading, switching, toggling, and persisting the active theme.
- **Key Exports:**
  - `ThemeManager` class
  - `themeManager` singleton instance
- **API:**
  - `getCurrent(): string` -- returns current theme ID (or `"system"`)
  - `setTheme(themeId: string): void` -- switch to a theme by ID
  - `toggle(): void` -- toggle between light and dark
  - `listThemes(): Theme[]` -- returns all built-in themes
- **Persistence:** Uses `localStorage` key `"junban-theme"`. The `"system"` option removes the key (so system preference is the default).
- **System Theme Detection:** Listens to `prefers-color-scheme: dark` media query. When current theme is `"system"`, responds to OS dark/light mode changes in real time.
- **Theme Application Logic:**
  1. Remove variant classes (e.g., `"nord"`) from `<html>`
  2. If `"system"`, check `prefers-color-scheme` and add/remove `"dark"` class accordingly
  3. If a specific theme:
     - If `type === "dark"`, add `"dark"` class
     - If `type === "light"`, remove `"dark"` class
     - If theme ID is not `"light"` or `"dark"`, add the theme ID as a class (e.g., `"nord"`)
- **Used By:** `AppearanceTab.tsx` (settings), `useAppCommands.ts` (toggle command), `main.tsx` (import triggers constructor)

---

## CSS Theme Files

### Design Token System

All themes define the same set of CSS custom properties (design tokens). The light theme defines them as defaults in a `@theme` block. Dark and Nord themes override them via class selectors.

**Token Categories:**

| Token                          | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `--color-surface`              | Primary background                         |
| `--color-surface-secondary`    | Secondary background (sidebar, cards)      |
| `--color-surface-tertiary`     | Tertiary background (inputs, hover states) |
| `--color-on-surface`           | Primary text color                         |
| `--color-on-surface-secondary` | Secondary text color                       |
| `--color-on-surface-muted`     | Muted/disabled text                        |
| `--color-border`               | Border color (rgba for transparency)       |
| `--color-accent`               | Primary accent color (buttons, links)      |
| `--color-accent-hover`         | Accent hover state                         |
| `--color-success`              | Success color (green)                      |
| `--color-warning`              | Warning color (yellow/amber)               |
| `--color-error`                | Error/danger color (red)                   |
| `--color-priority-1`           | P1 Urgent color                            |
| `--color-priority-2`           | P2 High color                              |
| `--color-priority-3`           | P3 Medium color                            |
| `--color-priority-4`           | P4 Low color                               |
| `--color-glass`                | Glass/frosted background                   |
| `--color-glass-border`         | Glass border                               |
| `--radius-sm/md/lg`            | Border radius values                       |
| `--width-sidebar`              | Sidebar width (16rem)                      |
| `--height-bottom-nav`          | Mobile bottom nav height (3.5rem)          |

---

### src/ui/themes/light.css

- **Purpose:** Default light theme. Defines all design tokens as base values using `@theme` block.
- **Selector:** `@theme` (root-level defaults)
- **Color Palette:**
  - Surface: whites and light grays (`#ffffff`, `#f5f5f7`, `#e8e8ed`)
  - Text: dark grays (`#1d1d1f`, `#6e6e73`, `#aeaeb2`)
  - Border: `rgba(0, 0, 0, 0.08)` (subtle black)
  - Accent: `#BF5AF2` (purple)
  - Success: `#28a745`, Warning: `#e6a817`, Error: `#dc3545`

---

### src/ui/themes/dark.css

- **Purpose:** Dark theme overrides. Applied when `<html>` has the `dark` class.
- **Selector:** `.dark { ... }`
- **Color Palette:**
  - Surface: near-blacks (`#0a0a0a`, `#141414`, `#1a1a1a`)
  - Text: light grays (`#e8e8e8`, `#a0a0a0`, `#585858`)
  - Border: `rgba(255, 255, 255, 0.08)` (subtle white)
  - Accent: `#BF5AF2` (same purple as light)
  - Success: `#30D158`, Warning: `#FFD60A`, Error: `#FF453A` (brighter for dark backgrounds)

---

### src/ui/themes/nord.css

- **Purpose:** Nord color scheme theme. A dark theme variant using the Nord palette. Applied when `<html>` has the `nord` class (always combined with `dark`).
- **Selector:** `.nord { ... }`
- **Color Palette:**
  - Surface: Nord polar night (`#2E3440`, `#3B4252`, `#434C5E`)
  - Text: Nord snow storm (`#ECEFF4`, `#D8DEE9`, `#4C566A`)
  - Border: `rgba(216, 222, 233, 0.1)` (subtle snow)
  - Accent: `#88C0D0` (Nord frost -- teal/cyan)
  - Success: `#A3BE8C` (Nord aurora green), Warning: `#EBCB8B` (yellow), Error: `#BF616A` (red)

---

## Dynamic Accent Color

The accent color can be overridden by the user via Settings > Appearance. `SettingsContext` updates `--color-accent` and `--color-accent-hover` at runtime, while this file set defines the baseline theme tokens.

For exact accent override logic (`darkenColor`, CSS variable writes), use `src/ui/context/SettingsContext.tsx` as the source of truth.

The 8 preset accent colors come from `DEFAULT_PROJECT_COLORS` in `src/config/defaults.ts`:
`#ef4444` (Red), `#f59e0b` (Amber), `#10b981` (Emerald), `#3b82f6` (Blue), `#8b5cf6` (Purple), `#ec4899` (Pink), `#06b6d4` (Cyan), `#84cc16` (Lime).

---

## Global CSS Utilities

### src/ui/index.css

- **Purpose:** Root CSS file that imports Tailwind CSS and all theme files, defines custom fonts, density/font-size utility classes, and entrance animations.
- **Imports:**
  - `tailwindcss`
  - `./themes/light.css`
  - `./themes/dark.css`
  - `./themes/nord.css`
- **Custom Fonts:**
  - `Outfit` (variable weight, primary UI font)
  - `Space Grotesk` (variable weight, headings)
  - `Space Mono` (monospace, code)
- **Density System:**
  - `.density-compact` -- reduces padding by scaling (0.85x)
  - `.density-comfortable` -- increases padding by scaling (1.15x)
- **Font Size Variants:**
  - `.font-small` -- 14px base
  - `.font-large` -- 18px base
  - Default is 16px
- **Reduce Motion:**
  - `.reduce-motion` -- sets `transition-duration: 0.01ms !important` and `animation-duration: 0.01ms !important` on all elements
- **Entrance Animations (6):**
  - `fade-in` -- opacity 0 to 1
  - `slide-up-fade` -- translate Y + fade
  - `scale-fade-in` -- scale 0.95 + fade
  - `drop-fade-in` -- translate Y from above + fade
  - `toast-in` -- translate X from right + fade (for toast notifications)
  - `pop-in` -- scale 0 to 1 (for FAB)
