import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  SlidersHorizontal,
  Palette,
  Bell,
  Bot,
  Terminal,
  Keyboard,
  Database,
  Info,
  FileText,
  ArrowLeft,
  ChevronRight,
  Tags,
  Wrench,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { AboutTab } from "./settings/AboutTab.js";
import { AgentToolsTab } from "./settings/AgentToolsTab.js";
import { AITab } from "./settings/AITab.js";
import { AlertsTab } from "./settings/AlertsTab.js";
import { AppearanceTab } from "./settings/AppearanceTab.js";
import { DataTab } from "./settings/DataTab.js";
import { FeaturesTab } from "./settings/FeaturesTab.js";
import { FiltersLabelsTab } from "./settings/FiltersLabelsTab.js";
import { GeneralTab } from "./settings/GeneralTab.js";
import { KeyboardTab } from "./settings/KeyboardTab.js";
import { TemplatesTab } from "./settings/TemplatesTab.js";
import type { SettingsTab } from "./settings/types.js";
import { endNamedPerfSpan, markPerf } from "../../utils/perf.js";

export type { SettingsTab };

interface SettingsProps {
  activeTab?: SettingsTab;
  onClose: () => void;
  mutationsBlocked?: boolean;
}

interface TabMeta {
  id: SettingsTab;
  label: string;
  subtitle?: string;
  icon: React.ReactNode;
  mobileIcon: React.ReactNode;
}

const TABS: TabMeta[] = [
  {
    id: "general",
    label: "Essentials",
    subtitle: "Everyday task basics",
    icon: <SlidersHorizontal className="w-4 h-4" />,
    mobileIcon: <SlidersHorizontal className="w-5 h-5" />,
  },
  {
    id: "appearance",
    label: "Appearance",
    subtitle: "Theme & layout",
    icon: <Palette className="w-4 h-4" />,
    mobileIcon: <Palette className="w-5 h-5" />,
  },
  {
    id: "alerts",
    label: "Alerts",
    subtitle: "Notifications & sounds",
    icon: <Bell className="w-4 h-4" />,
    mobileIcon: <Bell className="w-5 h-5" />,
  },
  {
    id: "filters",
    label: "Filters & Labels",
    subtitle: "Saved filters and tags",
    icon: <Tags className="w-4 h-4" />,
    mobileIcon: <Tags className="w-5 h-5" />,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    subtitle: "Shortcuts",
    icon: <Keyboard className="w-4 h-4" />,
    mobileIcon: <Keyboard className="w-5 h-5" />,
  },
  {
    id: "templates",
    label: "Templates",
    subtitle: "Repeatable tasks",
    icon: <FileText className="w-4 h-4" />,
    mobileIcon: <FileText className="w-5 h-5" />,
  },
  {
    id: "ai",
    label: "AI",
    subtitle: "Chat, models & providers",
    icon: <Bot className="w-4 h-4" />,
    mobileIcon: <Bot className="w-5 h-5" />,
  },
  {
    id: "agent-tools",
    label: "Agent Tools",
    subtitle: "CLI & MCP setup",
    icon: <Terminal className="w-4 h-4" />,
    mobileIcon: <Terminal className="w-5 h-5" />,
  },
  {
    id: "data",
    label: "Data",
    subtitle: "Backup & transfer",
    icon: <Database className="w-4 h-4" />,
    mobileIcon: <Database className="w-5 h-5" />,
  },
  {
    id: "features",
    label: "Advanced",
    subtitle: "Feature flags & developer tools",
    icon: <Wrench className="w-4 h-4" />,
    mobileIcon: <Wrench className="w-5 h-5" />,
  },
  {
    id: "about",
    label: "About",
    subtitle: "Version & system info",
    icon: <Info className="w-4 h-4" />,
    mobileIcon: <Info className="w-5 h-5" />,
  },
];

// Sections for the mobile index page
const MOBILE_SECTIONS: { label: string; tabs: SettingsTab[] }[] = [
  { label: "Everyday", tabs: ["general", "appearance", "alerts", "filters"] },
  { label: "Workflow", tabs: ["keyboard", "templates"] },
  { label: "AI & Agents", tabs: ["ai", "agent-tools"] },
  { label: "System", tabs: ["data", "features", "about"] },
];

const REMOTE_ADMIN_TABS = new Set<SettingsTab>(["data", "about"]);

function sanitizeSettingsTab(tab: SettingsTab | null | undefined): SettingsTab {
  if (tab === "plugins") return "general";
  if (tab === "voice") return "ai";
  return tab ?? "general";
}

function renderTabContent(tab: SettingsTab, mutationsBlocked: boolean) {
  const errorFallback = (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-error">
      Failed to load this settings tab. Refresh and try again.
    </div>
  );
  const wrap = (content: React.ReactNode) => (
    <ErrorBoundary key={tab} fallback={errorFallback}>
      {content}
    </ErrorBoundary>
  );

  switch (tab) {
    case "general":
      return wrap(<GeneralTab />);
    case "appearance":
      return wrap(<AppearanceTab />);
    case "alerts":
      return wrap(<AlertsTab />);
    case "filters":
      return wrap(<FiltersLabelsTab />);
    case "features":
      return wrap(<FeaturesTab />);
    case "ai":
      return wrap(<AITab />);
    case "voice":
      return wrap(<AITab />);
    case "agent-tools":
      return wrap(<AgentToolsTab />);
    case "templates":
      return wrap(<TemplatesTab />);
    case "keyboard":
      return wrap(<KeyboardTab />);
    case "data":
      return wrap(<DataTab mutationsBlocked={mutationsBlocked} />);
    case "about":
      return wrap(<AboutTab />);
  }
}

export function Settings({
  activeTab: initialTab,
  onClose,
  mutationsBlocked = false,
}: SettingsProps) {
  const isMobile = useIsMobile();
  const { readOnly } = useGeneralSettings();
  const settingsReadOnly = mutationsBlocked || readOnly;
  const safeInitialTab = sanitizeSettingsTab(initialTab);
  // Settings manages its own tab state. The initialTab prop is used only on mount
  // (or when changed from outside, e.g. command palette "Open AI settings").
  const [activeTab, setActiveTab] = useState<SettingsTab>(safeInitialTab);
  // null = show the mobile index page; a tab id = show that tab's content
  const [mobileSelectedTab, setMobileSelectedTab] = useState<SettingsTab | null>(
    isMobile && safeInitialTab !== "general" ? safeInitialTab : null,
  );

  // Refs for focus management
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const isTabBlocked = useCallback(
    (tab: SettingsTab) => settingsReadOnly && !REMOTE_ADMIN_TABS.has(tab),
    [settingsReadOnly],
  );

  // Sync if the caller changes initialTab after mount (e.g. re-opening at a different tab)
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab);
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab);
    if (initialTab) {
      const nextTab = sanitizeSettingsTab(initialTab);
      setActiveTab(nextTab);
      if (isMobile && nextTab !== "general") {
        setMobileSelectedTab(nextTab);
      }
    }
  }

  const handleTabChange = (tab: SettingsTab) => {
    setActiveTab(tab);
    if (isMobile) {
      setMobileSelectedTab(tab);
    }
  };

  const handleMobileBack = () => {
    setMobileSelectedTab(null);
  };

  useEffect(() => {
    markPerf("junban:settings-visible");
    endNamedPerfSpan("junban:settings-open", { tab: activeTab });
  }, [activeTab]);

  useEffect(() => {
    if (!settingsReadOnly) {
      return;
    }

    if (!REMOTE_ADMIN_TABS.has(activeTab)) {
      setActiveTab("data");
    }

    if (isMobile && mobileSelectedTab !== null && !REMOTE_ADMIN_TABS.has(mobileSelectedTab)) {
      setMobileSelectedTab("data");
    }
  }, [activeTab, isMobile, mobileSelectedTab, settingsReadOnly]);

  // Focus management: store previous focus and restore on close
  useEffect(() => {
    // Store the previously focused element when modal opens
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus the close button when modal opens (desktop only, mobile handles its own focus)
    if (!isMobile && closeButtonRef.current) {
      setTimeout(() => closeButtonRef.current?.focus(), 0);
    }

    return () => {
      // Restore focus when modal closes
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === "function") {
        setTimeout(() => previousFocusRef.current?.focus(), 0);
      }
    };
  }, [isMobile]);

  // Focus trap: keep focus within the modal (only tabbable, visible, enabled elements)
  const handleModalKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !modalRef.current) return;

    const candidates = modalRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href]:not([disabled]), input:not([disabled]):not([type="hidden"]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    // Filter out visually hidden elements (hidden attribute or computed display: none / visibility: hidden)
    const focusableElements = Array.from(candidates).filter((el) => {
      // Skip elements with hidden attribute
      if (el.hasAttribute("hidden")) return false;
      // Skip file inputs (even if not disabled, they may be visually hidden)
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "file") return false;
      // Skip elements with hidden ancestor or computed styles
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return true;
    });

    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift + Tab
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      // Tab
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isMobile && mobileSelectedTab !== null) {
          setMobileSelectedTab(null);
        } else {
          onClose();
        }
      }
    },
    [onClose, isMobile, mobileSelectedTab],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // ── Mobile layout ──
  if (isMobile) {
    // Drilled into a specific tab
    if (mobileSelectedTab !== null) {
      const tabMeta = TABS.find((t) => t.id === mobileSelectedTab);
      return (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-settings-tab-title"
          className="fixed inset-0 z-50 bg-surface flex flex-col pb-[var(--height-bottom-nav)]"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
            <button
              onClick={handleMobileBack}
              aria-label="Back to settings"
              className="p-2.5 -ml-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 id="mobile-settings-tab-title" className="text-lg font-bold text-on-surface">
              {tabMeta?.label ?? "Settings"}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {renderTabContent(mobileSelectedTab, mutationsBlocked)}
          </div>
        </div>
      );
    }

    // Index page
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-settings-title"
        className="fixed inset-0 z-50 bg-surface flex flex-col pb-[var(--height-bottom-nav)]"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-2.5 -ml-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-2 focus:ring-offset-surface"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 id="mobile-settings-title" className="text-lg font-bold text-on-surface">
            Settings
          </h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {settingsReadOnly && (
            <p
              id="settings-read-only-note"
              role="status"
              aria-live="polite"
              className="px-5 pt-4 text-xs text-warning"
            >
              Settings are read-only while remote access is running. Use Data to administer remote
              access.
            </p>
          )}
          {MOBILE_SECTIONS.map((section) => (
            <div key={section.label}>
              <h3 className="text-xs font-semibold text-accent uppercase tracking-wider px-5 pt-5 pb-2">
                {section.label}
              </h3>
              <div>
                {section.tabs.map((tabId) => {
                  const tab = TABS.find((t) => t.id === tabId)!;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => handleTabChange(tab.id)}
                      disabled={isTabBlocked(tab.id)}
                      aria-describedby={
                        isTabBlocked(tab.id) ? "settings-read-only-note" : undefined
                      }
                      className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-surface-secondary active:bg-surface-tertiary transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="w-10 h-10 rounded-xl bg-surface-tertiary flex items-center justify-center text-on-surface-secondary flex-shrink-0">
                        {tab.mobileIcon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-on-surface block">
                          {tab.label}
                        </span>
                        {tab.subtitle && (
                          <span className="text-xs text-on-surface-muted block mt-0.5">
                            {tab.subtitle}
                          </span>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-on-surface-muted flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Desktop layout with modal dialog semantics ──
  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
      onKeyDown={handleModalKeyDown}
    >
      <div className="bg-surface rounded-xl shadow-xl border border-border max-w-[960px] w-[90vw] h-[85vh] max-h-[800px] flex flex-row overflow-hidden">
        {/* Left sidebar nav */}
        <div className="w-60 flex-shrink-0 border-r border-border bg-surface-secondary p-4 flex flex-col">
          <h2 id="settings-title" className="text-lg font-bold text-on-surface mb-4 px-2">
            Settings
          </h2>
          {settingsReadOnly && (
            <p id="settings-read-only-note" className="mb-3 px-2 text-xs text-warning">
              Settings are read-only while remote access is running. Open Data to administer remote
              access.
            </p>
          )}
          <nav aria-label="Settings tabs" className="flex-1">
            <ul className="space-y-0.5">
              {TABS.map((tab) => (
                <li key={tab.id}>
                  <button
                    onClick={() => handleTabChange(tab.id)}
                    disabled={isTabBlocked(tab.id)}
                    aria-describedby={isTabBlocked(tab.id) ? "settings-read-only-note" : undefined}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
                      activeTab === tab.id
                        ? "bg-accent/10 text-accent font-medium"
                        : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h3 className="text-base font-semibold text-on-surface">
              {TABS.find((t) => t.id === activeTab)?.label ?? "Settings"}
            </h3>
            <button
              ref={closeButtonRef}
              onClick={onClose}
              aria-label="Close settings"
              className="p-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {renderTabContent(activeTab, mutationsBlocked)}
          </div>
        </div>
      </div>
    </div>
  );
}
