/**
 * Query-scoped Phase 7 visual scene harness.
 * Activated solely by visual-fixture=phase-7&scene=<id>. Offline, fixed clock.
 */

import { useEffect, useMemo } from "react";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Database,
  FileText,
  Info,
  Keyboard,
  Mic,
  Palette,
  Puzzle,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from "lucide-react";
import {
  applyPhase7VisualEnvironment,
  PHASE7_SCENE_META,
  type Phase7SceneId,
} from "../../lib/phase7VisualFixture";
import { DeclarativeRenderer } from "../DeclarativeRenderer";
import { PluginBrowser } from "../components/PluginBrowser";
import { PluginPanel } from "../contributions";
import { PluginsTab } from "../PluginsTab";
import {
  FIXTURE_COPY,
  fixtureDeclarativePanelSurface,
  fixtureInstalledPlugins,
  fixturePomodoroSettingValues,
  fixturePomodoroSurface,
  fixtureStorePlugins,
  POMODORO_SETTINGS,
} from "./fixtureData";

function Shell({
  children,
  width,
  height,
  className = "",
}: {
  children: React.ReactNode;
  width: number;
  height: number;
  className?: string;
}) {
  return (
    <div
      data-testid="phase7-scene-root"
      className={`overflow-hidden bg-surface text-on-surface ${className}`}
      style={{ width, height }}
    >
      {children}
    </div>
  );
}

const DESKTOP_TABS: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "Essentials", icon: <SettingsIcon size={16} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
  { id: "features", label: "Advanced", icon: <Sparkles size={16} /> },
  { id: "keyboard", label: "Keyboard", icon: <Keyboard size={16} /> },
  { id: "templates", label: "Templates", icon: <FileText size={16} /> },
  { id: "ai", label: "AI Assistant", icon: <Bot size={16} /> },
  { id: "voice", label: "Voice", icon: <Mic size={16} /> },
  { id: "plugins", label: "Extensions", icon: <Puzzle size={16} /> },
  { id: "data", label: "Data", icon: <Database size={16} /> },
  { id: "about", label: "About", icon: <Info size={16} /> },
];

const MOBILE_SECTIONS: { label: string; tabs: string[] }[] = [
  { label: "Preferences", tabs: ["general", "appearance", "features", "keyboard", "templates"] },
  { label: "Intelligence", tabs: ["ai", "voice"] },
  { label: "Extensions", tabs: ["plugins"] },
  { label: "System", tabs: ["data", "about"] },
];

const MOBILE_TAB_META: Record<string, { label: string; subtitle?: string }> = {
  general: { label: "Essentials", subtitle: "Defaults and sounds" },
  appearance: { label: "Appearance", subtitle: "Theme and density" },
  features: { label: "Advanced", subtitle: "Optional surfaces" },
  keyboard: { label: "Keyboard", subtitle: "Shortcuts" },
  templates: { label: "Templates", subtitle: "Task templates" },
  ai: { label: "AI Assistant", subtitle: "Providers and models" },
  voice: { label: "Voice", subtitle: "Speech input and output" },
  plugins: { label: "Extensions", subtitle: "Built-in and community plugins" },
  data: { label: "Data", subtitle: "Backup and restore" },
  about: { label: "About", subtitle: "Version and diagnostics" },
};

function DesktopSettingsChrome({ children }: { children: React.ReactNode }) {
  return (
    <Shell width={1280} height={900} className="flex items-center justify-center p-6">
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        className="flex h-full w-full max-w-[960px] flex-row overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
      >
        <div className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-secondary p-4">
          <h2 className="mb-4 px-2 text-lg font-bold text-on-surface">Settings</h2>
          <nav aria-label="Settings tabs" className="flex-1">
            <ul className="space-y-0.5">
              {DESKTOP_TABS.map((tab) => {
                const active = tab.id === "plugins";
                return (
                  <li key={tab.id}>
                    <div
                      aria-current={active ? "page" : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
                        active
                          ? "border-l-2 border-accent-action bg-surface-tertiary font-medium text-on-surface"
                          : "text-on-surface-secondary"
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </div>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h3 className="text-base font-semibold text-on-surface">Extensions</h3>
            <button
              type="button"
              aria-label="Close settings"
              className="rounded-md p-1.5 text-on-surface-secondary"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto p-6">
            {children}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function MobileSettingsIndex() {
  return (
    <Shell width={390} height={844} className="flex flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" aria-label="Close settings" className="-ml-1.5 rounded-md p-2.5">
          <ArrowLeft aria-hidden="true" className="h-5 w-5 text-on-surface-secondary" />
        </button>
        <h2 className="text-lg font-bold text-on-surface">Settings</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {MOBILE_SECTIONS.map((section) => (
          <section key={section.label}>
            <h3 className="px-5 pt-5 pb-2 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
              {section.label}
            </h3>
            {section.tabs.map((tabId) => {
              const tab = MOBILE_TAB_META[tabId]!;
              const active = tabId === "plugins";
              return (
                <div
                  key={tabId}
                  data-settings-mobile-tab={tabId}
                  className={`flex w-full items-center gap-4 px-5 py-3.5 text-left ${
                    active ? "bg-surface-secondary" : ""
                  }`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-on-surface-secondary">
                    {tabId === "plugins" ? (
                      <Puzzle className="h-5 w-5" />
                    ) : (
                      <SettingsIcon className="h-5 w-5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-on-surface">{tab.label}</span>
                    {tab.subtitle ? (
                      <span className="mt-0.5 block text-xs text-on-surface-muted">
                        {tab.subtitle}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-on-surface-muted"
                  />
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </Shell>
  );
}

function MobileSettingsDetail({ children }: { children: React.ReactNode }) {
  return (
    <Shell width={390} height={844} className="flex flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" aria-label="Back to settings" className="-ml-1.5 rounded-md p-2.5">
          <ArrowLeft aria-hidden="true" className="h-5 w-5 text-on-surface-secondary" />
        </button>
        <h2 className="text-lg font-bold text-on-surface">Extensions</h2>
      </div>
      <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto p-4">
        {children}
      </div>
    </Shell>
  );
}

function StatusBarReady() {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-surface-secondary/50 px-3 py-1.5 text-xs text-on-surface-secondary">
      <span aria-hidden="true">○</span>
      <span>Ready</span>
    </div>
  );
}

function ContributionWorkspace({ darkFrame = false }: { darkFrame?: boolean }) {
  const surface = fixturePomodoroSurface();
  return (
    <Shell width={1440} height={900} className="flex flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-2 border-r border-border bg-surface-secondary/40 p-4">
          <p className="text-xs font-semibold tracking-wide text-on-surface-muted uppercase">
            Tools
          </p>
          <div className="rounded-lg bg-accent-action/10 px-3 py-2 text-sm font-medium text-accent-foreground">
            Pomodoro
          </div>
          <div className="px-3 py-2 text-sm text-on-surface-secondary">Quick Wins</div>
          <div className="px-3 py-2 text-sm text-on-surface-secondary">Stats</div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border px-6 py-4">
            <h1 className="text-lg font-semibold text-on-surface">Pomodoro</h1>
            <p className="text-xs text-on-surface-muted">
              Structured plugin view{darkFrame ? " (dark)" : ""}
            </p>
          </header>
          <div className="flex flex-1 items-center justify-center p-8">
            <DeclarativeRenderer surface={surface} onAction={() => undefined} />
          </div>
        </main>
      </div>
      <StatusBarReady />
    </Shell>
  );
}

function DeclarativePanelScene() {
  const surface = fixtureDeclarativePanelSurface();
  return (
    <Shell width={1280} height={900} className="flex">
      <div className="flex-1 border-r border-border bg-surface-secondary/20 p-6">
        <h1 className="mb-2 text-lg font-semibold text-on-surface">Today</h1>
        <p className="text-sm text-on-surface-muted">Workspace chrome (fixture frame)</p>
      </div>
      <aside className="flex h-full w-[360px] flex-col border-l border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-on-surface">Sidebar</h2>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <PluginPanel title={FIXTURE_COPY.panelTitle}>
            <DeclarativeRenderer surface={surface} onAction={() => undefined} />
          </PluginPanel>
        </div>
        <StatusBarReady />
      </aside>
    </Shell>
  );
}

function pluginsFixtureFor(scene: Phase7SceneId) {
  const plugins = fixtureInstalledPlugins();
  const base = {
    plugins,
    communityEnabled: false,
    loadMode: "ready" as const,
    settingDeclarations: { pomodoro: POMODORO_SETTINGS },
    settingValues: { pomodoro: fixturePomodoroSettingValues() },
    browserEntries: fixtureStorePlugins(),
    browserMode: "ready" as const,
    browserSelectedId: "markdown-export-pack",
  };
  switch (scene) {
    case "settings-extensions-safety-desktop-light":
      return { ...base, openSafetyDialog: true };
    case "settings-extensions-permission-desktop-light":
      return { ...base, openPermissionPluginId: "focus-helper" };
    case "plugin-settings-pomodoro-desktop-light":
      return { ...base, expandedPluginId: "pomodoro" };
    default:
      return base;
  }
}

function browserScene(mode: "ready" | "empty" | "loading" | "error") {
  // Error authority still lists installed plugins under the registry failure banner.
  const installed = mode === "empty" || mode === "loading" ? [] : fixtureInstalledPlugins();
  const selected = mode === "ready" ? "markdown-export-pack" : mode === "error" ? "pomodoro" : null;
  return (
    <Shell width={1280} height={900} className="relative bg-black/40">
      <PluginBrowser
        open
        onClose={() => undefined}
        installedPlugins={installed}
        fixtureEntries={fixtureStorePlugins()}
        fixtureMode={mode}
        initialSelectedId={selected}
      />
    </Shell>
  );
}

export function Phase7VisualRoot({ scene }: { scene: Phase7SceneId }) {
  applyPhase7VisualEnvironment(scene);

  useEffect(() => {
    applyPhase7VisualEnvironment(scene);
    document.documentElement.dataset.phase7Ready = "1";
    return () => {
      delete document.documentElement.dataset.phase7Ready;
    };
  }, [scene]);

  const body = useMemo(() => {
    switch (scene) {
      case "settings-extensions-main-desktop-light":
      case "settings-extensions-safety-desktop-light":
      case "settings-extensions-permission-desktop-light":
      case "plugin-settings-pomodoro-desktop-light":
        return (
          <DesktopSettingsChrome>
            <PluginsTab fixture={pluginsFixtureFor(scene)} />
          </DesktopSettingsChrome>
        );
      case "registry-browser-list-detail-desktop-light":
        return browserScene("ready");
      case "registry-browser-empty-desktop-light":
        return browserScene("empty");
      case "registry-browser-loading-desktop-light":
        return browserScene("loading");
      case "registry-browser-error-desktop-light":
        return browserScene("error");
      case "pomodoro-view-status-desktop-light":
        return <ContributionWorkspace />;
      case "pomodoro-view-status-desktop-dark":
        return <ContributionWorkspace darkFrame />;
      case "declarative-panel-action-desktop-light":
        return <DeclarativePanelScene />;
      case "settings-extensions-mobile-category-light":
        return <MobileSettingsIndex />;
      case "settings-extensions-mobile-detail-light":
        return (
          <MobileSettingsDetail>
            <PluginsTab fixture={pluginsFixtureFor("settings-extensions-main-desktop-light")} />
          </MobileSettingsDetail>
        );
      default: {
        const _exhaustive: never = scene;
        return (
          <Shell width={800} height={600}>
            <p>Unknown scene {String(_exhaustive)}</p>
          </Shell>
        );
      }
    }
  }, [scene]);

  // Keep gradient utility classes in the CSS graph for PluginCard headers.
  return (
    <>
      <div
        aria-hidden="true"
        className="hidden bg-gradient-to-r from-violet-500 to-purple-600 from-blue-500 to-cyan-500 from-emerald-500 to-teal-500 from-emerald-400 to-teal-400 from-teal-400 to-emerald-400 from-orange-500 to-amber-500 from-rose-500 to-pink-500 from-indigo-500 to-blue-500 from-fuchsia-500 to-purple-500 from-sky-500 to-indigo-500 from-lime-500 to-green-500 from-red-500 to-orange-500 from-teal-500 to-cyan-500 from-pink-500 to-rose-500"
      />
      {body}
    </>
  );
}

// Silence unused meta import lint when tree-shaken differently.
void PHASE7_SCENE_META;
