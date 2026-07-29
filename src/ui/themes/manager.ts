/** Theme manager — handles loading and switching between Light/Dark/Nord themes. */

const STORAGE_KEY = "junban-theme";

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
