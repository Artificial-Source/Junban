/** Theme manager for server-confirmed Light/Dark/Nord/System appearance. */

const STORAGE_KEY = "junban-theme";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_ACCENT_COLOR = "#3b82f6";

export type ThemeId = "system" | "light" | "dark" | "nord";
export type ResolvedThemeId = Exclude<ThemeId, "system">;

type CompatibleMediaQueryList = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

let trackedSystemQuery: CompatibleMediaQueryList | null = null;
let trackedSystemListener: ((event: MediaQueryListEvent) => void) | null = null;
let trackedWithLegacyListener = false;

function applyResolvedTheme(themeId: ResolvedThemeId): void {
  const root = document.documentElement;
  root.classList.remove("dark", "nord");
  if (themeId === "dark" || themeId === "nord") root.classList.add(themeId);
}

function stopSystemTracking(): void {
  if (trackedSystemQuery && trackedSystemListener) {
    if (trackedWithLegacyListener) {
      trackedSystemQuery.removeListener?.(trackedSystemListener);
    } else {
      trackedSystemQuery.removeEventListener?.("change", trackedSystemListener);
    }
  }
  trackedSystemQuery = null;
  trackedSystemListener = null;
  trackedWithLegacyListener = false;
}

/** Apply a theme choice, resolving and tracking System through matchMedia. */
export function applyThemeClass(themeId: ThemeId): void {
  stopSystemTracking();
  if (themeId !== "system") {
    applyResolvedTheme(themeId);
    return;
  }

  if (typeof window.matchMedia !== "function") {
    applyResolvedTheme("light");
    return;
  }
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  applyResolvedTheme(query.matches ? "dark" : "light");
  const listener = (event: MediaQueryListEvent) => {
    applyResolvedTheme(event.matches ? "dark" : "light");
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    trackedSystemQuery = query;
    trackedSystemListener = listener;
  } else if (typeof (query as CompatibleMediaQueryList).addListener === "function") {
    const compatibleQuery = query as CompatibleMediaQueryList;
    compatibleQuery.addListener?.(listener);
    trackedSystemQuery = compatibleQuery;
    trackedSystemListener = listener;
    trackedWithLegacyListener = true;
  }
}

/** Apply the first-paint accent hint until confirmed settings load. */
export function applyDefaultAccentColor(): void {
  const root = document.documentElement;
  root.style.removeProperty("--color-accent-hover");
  root.style.setProperty("--color-accent", DEFAULT_ACCENT_COLOR);
}

/** Read the first-paint theme hint; the server remains authoritative. */
export function getStoredTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "system" || stored === "light" || stored === "dark" || stored === "nord") {
    return stored;
  }
  return "system";
}

/** Persist and apply a first-paint theme hint. */
export function setStoredTheme(themeId: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, themeId);
  applyThemeClass(themeId);
}

/** Initialize first-paint appearance from the cached server-confirmed theme. */
export function initTheme(): ThemeId {
  const theme = getStoredTheme();
  applyThemeClass(theme);
  return theme;
}

export type AppearanceApplication = {
  theme: ThemeId;
  accent: string;
  density: "compact" | "default" | "comfortable";
  font_size: "small" | "medium" | "large";
  font_family: "outfit" | "inter" | "system";
  reduced_motion: boolean;
};

/** Apply an authoritative appearance payload after a successful server read. */
export function applyAppearance(appearance: AppearanceApplication): void {
  applyThemeClass(appearance.theme);
  try {
    localStorage.setItem(STORAGE_KEY, appearance.theme);
  } catch {
    // First-paint caching is optional in quota-constrained/private contexts.
  }

  const root = document.documentElement;
  root.style.removeProperty("--color-accent-hover");
  root.style.setProperty("--color-accent", appearance.accent);
  root.dataset.density = appearance.density;
  root.dataset.fontSize = appearance.font_size;
  root.dataset.fontFamily = appearance.font_family;
  root.classList.toggle("reduce-motion", appearance.reduced_motion);
}
