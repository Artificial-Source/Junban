/** Theme manager — handles loading and switching between Light/Dark/Nord themes. */

const STORAGE_KEY = "junban-theme";

/**
 * Default decorative accent color. The legacy runtime applied this persisted
 * `accent_color` default via SettingsContext at startup; the stylesheet's
 * `@supports` block then derived the action/hover/foreground variants from it.
 * Phase 1 has no settings UI, so the default is applied unconditionally to
 * match the approved (blue) rendering in both light and dark themes.
 */
const DEFAULT_ACCENT_COLOR = "#3b82f6";

export type ThemeId = "light" | "dark" | "nord";

const DARK_THEMES: ReadonlySet<string> = new Set(["dark", "nord"]);

/** Apply the theme class to the document root. */
export function applyThemeClass(themeId: ThemeId): void {
  const root = document.documentElement;
  root.classList.remove("dark", "nord");
  if (DARK_THEMES.has(themeId)) {
    root.classList.add(themeId);
  }
}

/**
 * Apply the default accent color to the document root, mirroring the legacy
 * SettingsContext startup behavior. Clears any inline hover derivative so the
 * stylesheet-owned `@supports` derivation wins for both themes.
 */
export function applyDefaultAccentColor(): void {
  const root = document.documentElement;
  root.style.removeProperty("--color-accent-hover");
  root.style.setProperty("--color-accent", DEFAULT_ACCENT_COLOR);
}

/** Read the persisted theme, defaulting to "dark" if unset. */
export function getStoredTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "nord") return stored;
  return "dark";
}

/** Persist and apply a theme choice. */
export function setStoredTheme(themeId: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, themeId);
  applyThemeClass(themeId);
}

/** Initialize the theme on first load from persisted preference. */
export function initTheme(): ThemeId {
  const theme = getStoredTheme();
  applyThemeClass(theme);
  return theme;
}
