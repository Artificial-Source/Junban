import { BUILT_IN_THEMES, type Theme, type CustomTheme } from "../../config/themes.js";
import { api } from "../api.js";

const STORAGE_KEY = "docket-theme";
const CUSTOM_THEMES_INDEX_KEY = "custom_themes_index";
const CUSTOM_THEME_PREFIX = "custom_theme:";

/** Theme manager — handles loading, switching, and custom theme support. */
export class ThemeManager {
  private currentTheme: string;
  customThemes: CustomTheme[] = [];

  constructor() {
    const stored = localStorage.getItem(STORAGE_KEY);
    this.currentTheme = stored ?? "light";
    this.applyTheme();
  }

  /** Get the currently active theme ID. */
  getCurrent(): string {
    return this.currentTheme;
  }

  /** Switch to a different theme by ID. */
  setTheme(themeId: string): void {
    // Check built-in themes first
    const builtIn = BUILT_IN_THEMES.find((t) => t.id === themeId);
    if (builtIn) {
      this.currentTheme = themeId;
      localStorage.setItem(STORAGE_KEY, themeId);
      this.clearCustomCSS();
      this.applyTheme();
      return;
    }

    // Check custom themes
    const custom = this.customThemes.find((t) => t.id === themeId);
    if (custom) {
      this.currentTheme = themeId;
      localStorage.setItem(STORAGE_KEY, themeId);
      this.applyCustomTheme(custom);
      return;
    }

    console.warn(`Unknown theme: ${themeId}`);
  }

  /** Toggle between light and dark themes. */
  toggle(): void {
    this.setTheme(this.currentTheme === "dark" ? "light" : "dark");
  }

  /** List all available themes (built-in + custom). */
  listThemes(): Theme[] {
    const customAsThemes: Theme[] = this.customThemes.map((ct) => ({
      id: ct.id,
      name: ct.name,
      type: ct.type,
    }));
    return [...BUILT_IN_THEMES, ...customAsThemes];
  }

  /** Load custom themes from app settings. */
  async loadCustomThemes(): Promise<void> {
    try {
      const indexJson = await api.getAppSetting(CUSTOM_THEMES_INDEX_KEY);
      if (!indexJson) {
        this.customThemes = [];
        return;
      }

      const ids: string[] = JSON.parse(indexJson);
      const themes: CustomTheme[] = [];

      for (const id of ids) {
        const themeJson = await api.getAppSetting(`${CUSTOM_THEME_PREFIX}${id}`);
        if (themeJson) {
          try {
            themes.push(JSON.parse(themeJson));
          } catch {
            // Skip malformed entries
          }
        }
      }

      this.customThemes = themes;

      // Re-apply current theme in case it's a custom one that was just loaded
      if (this.currentTheme.startsWith("custom-")) {
        const custom = this.customThemes.find((t) => t.id === this.currentTheme);
        if (custom) {
          this.applyCustomTheme(custom);
        }
      }
    } catch {
      this.customThemes = [];
    }
  }

  /** Save a custom theme (create or update). */
  async saveCustomTheme(theme: CustomTheme): Promise<void> {
    // Save the theme data
    await api.setAppSetting(`${CUSTOM_THEME_PREFIX}${theme.id}`, JSON.stringify(theme));

    // Update index
    const existingIndex = this.customThemes.findIndex((t) => t.id === theme.id);
    if (existingIndex >= 0) {
      this.customThemes[existingIndex] = theme;
    } else {
      this.customThemes.push(theme);
    }

    const ids = this.customThemes.map((t) => t.id);
    await api.setAppSetting(CUSTOM_THEMES_INDEX_KEY, JSON.stringify(ids));
  }

  /** Delete a custom theme. */
  async deleteCustomTheme(id: string): Promise<void> {
    // Remove from settings
    await api.setAppSetting(`${CUSTOM_THEME_PREFIX}${id}`, "");

    // Update local list
    this.customThemes = this.customThemes.filter((t) => t.id !== id);

    // Update index
    const ids = this.customThemes.map((t) => t.id);
    await api.setAppSetting(CUSTOM_THEMES_INDEX_KEY, JSON.stringify(ids));

    // If the deleted theme was active, switch to light
    if (this.currentTheme === id) {
      this.setTheme("light");
    }
  }

  /** Apply a custom theme by injecting CSS variable overrides. */
  applyCustomTheme(theme: CustomTheme): void {
    // Apply dark class based on theme type
    if (theme.type === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    // Inject CSS variable overrides
    let styleEl = document.getElementById("docket-custom-theme") as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "docket-custom-theme";
      document.head.appendChild(styleEl);
    }

    const declarations = Object.entries(theme.variables)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join("\n");

    styleEl.textContent = `:root {\n${declarations}\n}`;
  }

  /** Remove custom CSS variable overrides. */
  clearCustomCSS(): void {
    const styleEl = document.getElementById("docket-custom-theme");
    if (styleEl) {
      styleEl.remove();
    }
  }

  /** Apply CSS variables in real-time for live preview (does not persist). */
  previewVariables(variables: Record<string, string>): void {
    for (const [key, value] of Object.entries(variables)) {
      document.documentElement.style.setProperty(key, value);
    }
  }

  /** Clear live preview variables. */
  clearPreview(): void {
    const root = document.documentElement;
    // Remove inline styles set during preview
    root.removeAttribute("style");
  }

  private applyTheme(): void {
    const theme = BUILT_IN_THEMES.find((t) => t.id === this.currentTheme);
    if (!theme) return;

    if (theme.type === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }
}

export const themeManager = new ThemeManager();
