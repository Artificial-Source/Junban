import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@legacy/index.css";
// Providers must resolve through the same overlaid legacy module paths that
// components import (relative ../../context/*), or React context identity breaks.
import { PluginProvider } from "@legacy/context/PluginContext.js";
import { SettingsProvider } from "@legacy/context/SettingsContext.js";
import { readFixture, type Phase7FixtureState, type Phase7SceneId } from "./fixture-state";
import { SceneRouter } from "./scenes";

const FIXED_NOW = new Date("2026-08-04T15:00:00.000Z");
const RealDate = Date;
class FixtureDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) {
      super(FIXED_NOW.getTime());
      return;
    }
    // @ts-expect-error Date constructor overload forwarding
    super(...args);
  }
  static now() {
    return FIXED_NOW.getTime();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).Date = FixtureDate;

function applyTheme(theme: Phase7FixtureState["theme"]) {
  const root = document.documentElement;
  root.classList.remove("dark", "nord", "light", "reduce-motion");
  if (theme === "dark") root.classList.add("dark");
  root.classList.add("reduce-motion");
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  document.body.classList.add("bg-surface", "text-on-surface", "antialiased");
}

function sceneFixture(scene: Phase7SceneId, theme: "light" | "dark"): Phase7FixtureState {
  const base = {
    ...readFixture(),
    scene,
    theme,
    communityPluginsEnabled: false,
    pluginLoadMode: "ready" as const,
    storeMode: "ready" as const,
    emptyInstalledPlugins: false,
    expandedPluginId: null,
    openSafetyDialog: false,
    openPermissionPluginId: null,
    openBrowser: false,
    searchQuery: "",
    browserSearchQuery: "",
    browserFilterTab: "all" as const,
    browserSelectedId: "markdown-export-pack",
  };

  switch (scene) {
    case "settings-extensions-main-desktop-light":
    case "settings-extensions-mobile-category-light":
    case "settings-extensions-mobile-detail-light":
      return { ...base, communityPluginsEnabled: false };
    case "settings-extensions-safety-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: false,
        openSafetyDialog: true,
      };
    case "settings-extensions-permission-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: false,
        openPermissionPluginId: "focus-helper",
      };
    case "registry-browser-list-detail-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: true,
        openBrowser: true,
        storeMode: "ready",
        // Avoid installed-only first-paint auto-select racing ahead of the store list.
        emptyInstalledPlugins: true,
        browserSelectedId: "markdown-export-pack",
      };
    case "registry-browser-empty-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: true,
        openBrowser: true,
        storeMode: "empty",
        emptyInstalledPlugins: true,
      };
    case "registry-browser-loading-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: true,
        openBrowser: true,
        storeMode: "loading",
      };
    case "registry-browser-error-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: true,
        openBrowser: true,
        storeMode: "error",
      };
    case "plugin-settings-pomodoro-desktop-light":
      return {
        ...base,
        communityPluginsEnabled: false,
        expandedPluginId: "pomodoro",
      };
    // browserSelectedId is consumed by PluginBrowser auto-select; installed sample-timer
    // remains first store row so detail/install chrome is stable.
    case "pomodoro-view-status-desktop-light":
      return { ...base, theme: "light" };
    case "pomodoro-view-status-desktop-dark":
      return { ...base, theme: "dark" };
    case "declarative-panel-action-desktop-light":
      return { ...base, theme: "light" };
    default:
      return base;
  }
}

function boot() {
  const params = new URLSearchParams(window.location.search);
  const scene = (params.get("scene") as Phase7SceneId) ?? "settings-extensions-main-desktop-light";
  const themeParam = (params.get("theme") as "light" | "dark") || undefined;
  const fixture = sceneFixture(scene, themeParam ?? (scene.includes("dark") ? "dark" : "light"));

  window.__PHASE7_FIXTURE__ = fixture;
  applyTheme(fixture.theme);

  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");

  createRoot(root).render(
    <StrictMode>
      <SettingsProvider>
        <PluginProvider>
          <SceneRouter />
        </PluginProvider>
      </SettingsProvider>
    </StrictMode>,
  );

  // Mark ready after first paint so Playwright can wait on deterministic mount.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.setAttribute("data-phase7-ready", "1");
    });
  });
}

boot();
