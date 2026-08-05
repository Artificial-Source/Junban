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
import { PluginsTab } from "@legacy/views/settings/PluginsTab.js";
import { PluginBrowser } from "@legacy/components/PluginBrowser.js";
import { PluginPanel } from "@legacy/components/PluginPanel.js";
import { StatusBar } from "@legacy/components/StatusBar.js";
import {
  StructuredContentRenderer,
  type StructuredContent,
} from "@legacy/components/StructuredContentRenderer.js";
import {
  FIXTURE_COPY,
  fixtureDeclarativePanelContent,
  fixturePomodoroStructuredContent,
  readFixture,
  type Phase7SceneId,
} from "./fixture-state";

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
      className={`bg-surface text-on-surface overflow-hidden ${className}`}
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

function DesktopSettingsChrome({
  children,
  width = 1280,
  height = 900,
}: {
  children: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <Shell width={width} height={height} className="flex items-center justify-center p-6">
      <div
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        className="flex h-full w-full max-w-[960px] flex-row overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
      >
        <div className="flex w-60 flex-shrink-0 flex-col border-r border-border bg-surface-secondary p-4">
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

function MobileSettingsIndex({ width = 390, height = 844 }: { width?: number; height?: number }) {
  return (
    <Shell width={width} height={height} className="flex flex-col bg-surface">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button type="button" aria-label="Close settings" className="-ml-1.5 rounded-md p-2.5">
          <ArrowLeft aria-hidden="true" className="h-5 w-5 text-on-surface-secondary" />
        </button>
        <h2 className="text-lg font-bold text-on-surface">Settings</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {MOBILE_SECTIONS.map((section) => (
          <section key={section.label}>
            <h3 className="px-5 pb-2 pt-5 text-xs font-semibold uppercase tracking-wider text-on-surface-secondary">
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
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-on-surface-secondary">
                    {tabId === "plugins" ? (
                      <Puzzle className="h-5 w-5" />
                    ) : (
                      <SettingsIcon className="h-5 w-5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-on-surface">{tab.label}</span>
                    {tab.subtitle && (
                      <span className="mt-0.5 block text-xs text-on-surface-muted">
                        {tab.subtitle}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-4 w-4 flex-shrink-0 text-on-surface-muted"
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

function MobileSettingsDetail({
  children,
  width = 390,
  height = 844,
}: {
  children: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <Shell width={width} height={height} className="flex flex-col bg-surface">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-3">
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

function ContributionWorkspace({
  width,
  height,
  darkFrame = false,
}: {
  width: number;
  height: number;
  darkFrame?: boolean;
}) {
  const content = fixturePomodoroStructuredContent() as StructuredContent;
  return (
    <Shell width={width} height={height} className="flex flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 border-r border-border bg-surface-secondary/40 p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
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
            <StructuredContentRenderer content={content} onCommand={() => undefined} />
          </div>
        </main>
      </div>
      <StatusBar />
    </Shell>
  );
}

function DeclarativePanelScene({
  width = 1280,
  height = 900,
}: {
  width?: number;
  height?: number;
}) {
  const content = fixtureDeclarativePanelContent() as StructuredContent;
  return (
    <Shell width={width} height={height} className="flex">
      <div className="flex-1 border-r border-border bg-surface-secondary/20 p-6">
        <h1 className="text-lg font-semibold text-on-surface mb-2">Today</h1>
        <p className="text-sm text-on-surface-muted">Workspace chrome (fixture frame)</p>
      </div>
      <aside className="w-[360px] h-full flex flex-col bg-surface border-l border-border">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface">Sidebar</h2>
        </div>
        <div className="p-4 flex-1 overflow-auto">
          <PluginPanel pluginId="example-plugin" title={FIXTURE_COPY.panelTitle}>
            <StructuredContentRenderer content={content} onCommand={() => undefined} />
          </PluginPanel>
        </div>
        <StatusBar />
      </aside>
    </Shell>
  );
}

function BrowserOnlyScene() {
  // Real PluginBrowser; fixture storeMode drives loading/empty/error/ready.
  return (
    <Shell width={1280} height={900} className="relative bg-black/40">
      <PluginBrowser open onClose={() => undefined} />
    </Shell>
  );
}

/** Keep dynamic PluginCard/PluginDetail gradient utility classes in the CSS graph. */
function GradientSafelist() {
  return (
    <div
      aria-hidden="true"
      className="hidden bg-gradient-to-r from-violet-500 to-purple-600 from-blue-500 to-cyan-500 from-emerald-500 to-teal-500 from-orange-500 to-amber-500 from-rose-500 to-pink-500 from-indigo-500 to-blue-500 from-fuchsia-500 to-purple-500 from-sky-500 to-indigo-500 from-lime-500 to-green-500 from-red-500 to-orange-500 from-teal-500 to-cyan-500 from-pink-500 to-rose-500"
    />
  );
}

export function SceneRouter() {
  const fixture = readFixture();
  const scene = fixture.scene as Phase7SceneId;

  const body = (() => {
    switch (scene) {
      case "settings-extensions-main-desktop-light":
        return (
          <DesktopSettingsChrome>
            <PluginsTab />
          </DesktopSettingsChrome>
        );
      case "settings-extensions-safety-desktop-light":
      case "settings-extensions-permission-desktop-light":
      case "plugin-settings-pomodoro-desktop-light":
        // Fixture-seeded PluginsTab overlay opens safety/permission/expand state.
        return (
          <DesktopSettingsChrome>
            <PluginsTab />
          </DesktopSettingsChrome>
        );
      case "registry-browser-list-detail-desktop-light":
      case "registry-browser-empty-desktop-light":
      case "registry-browser-loading-desktop-light":
      case "registry-browser-error-desktop-light":
        return <BrowserOnlyScene />;
      case "pomodoro-view-status-desktop-light":
        return <ContributionWorkspace width={1440} height={900} />;
      case "pomodoro-view-status-desktop-dark":
        return <ContributionWorkspace width={1440} height={900} darkFrame />;
      case "declarative-panel-action-desktop-light":
        return <DeclarativePanelScene />;
      case "settings-extensions-mobile-category-light":
        return <MobileSettingsIndex />;
      case "settings-extensions-mobile-detail-light":
        return (
          <MobileSettingsDetail>
            <PluginsTab />
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
  })();

  return (
    <>
      <GradientSafelist />
      {body}
    </>
  );
}
