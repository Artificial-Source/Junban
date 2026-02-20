import { useState, useEffect, useCallback } from "react";
import {
  X,
  SlidersHorizontal,
  Palette,
  Bot,
  Mic,
  Puzzle,
  Keyboard,
  Database,
  Info,
  FileText,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import { GeneralTab } from "./settings/GeneralTab.js";
import { AppearanceTab } from "./settings/AppearanceTab.js";
import { AITab } from "./settings/AITab.js";
import { VoiceTab } from "./settings/VoiceTab.js";
import { PluginsTab } from "./settings/PluginsTab.js";
import { TemplatesTab } from "./settings/TemplatesTab.js";
import { KeyboardTab } from "./settings/KeyboardTab.js";
import { DataTab } from "./settings/DataTab.js";
import { AboutTab } from "./settings/AboutTab.js";
import { useIsMobile } from "../hooks/useIsMobile.js";
import type { SettingsTab } from "./settings/types.js";

export type { SettingsTab };

interface SettingsProps {
  activeTab?: SettingsTab;
  onActiveTabChange?: (tab: SettingsTab) => void;
  onClose: () => void;
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
    label: "General",
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
    id: "ai",
    label: "AI Assistant",
    subtitle: "Models & providers",
    icon: <Bot className="w-4 h-4" />,
    mobileIcon: <Bot className="w-5 h-5" />,
  },
  {
    id: "voice",
    label: "Voice",
    subtitle: "Speech & microphone",
    icon: <Mic className="w-4 h-4" />,
    mobileIcon: <Mic className="w-5 h-5" />,
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: <Puzzle className="w-4 h-4" />,
    mobileIcon: <Puzzle className="w-5 h-5" />,
  },
  {
    id: "templates",
    label: "Templates",
    icon: <FileText className="w-4 h-4" />,
    mobileIcon: <FileText className="w-5 h-5" />,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    subtitle: "Shortcuts",
    icon: <Keyboard className="w-4 h-4" />,
    mobileIcon: <Keyboard className="w-5 h-5" />,
  },
  {
    id: "data",
    label: "Data",
    subtitle: "Import & export",
    icon: <Database className="w-4 h-4" />,
    mobileIcon: <Database className="w-5 h-5" />,
  },
  {
    id: "about",
    label: "About",
    icon: <Info className="w-4 h-4" />,
    mobileIcon: <Info className="w-5 h-5" />,
  },
];

// Sections for the mobile index page
const MOBILE_SECTIONS: { label: string; tabs: SettingsTab[] }[] = [
  { label: "General", tabs: ["general", "appearance", "keyboard", "data"] },
  { label: "AI & Voice", tabs: ["ai", "voice"] },
  { label: "Extensions", tabs: ["plugins", "templates"] },
  { label: "Info", tabs: ["about"] },
];

function renderTabContent(tab: SettingsTab) {
  switch (tab) {
    case "general":
      return <GeneralTab />;
    case "appearance":
      return <AppearanceTab />;
    case "ai":
      return <AITab />;
    case "voice":
      return <VoiceTab />;
    case "plugins":
      return <PluginsTab />;
    case "templates":
      return <TemplatesTab />;
    case "keyboard":
      return <KeyboardTab />;
    case "data":
      return <DataTab />;
    case "about":
      return <AboutTab />;
  }
}

export function Settings({
  activeTab: controlledActiveTab,
  onActiveTabChange,
  onClose,
}: SettingsProps) {
  const isMobile = useIsMobile();
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>("general");
  // null = show the mobile index page; a tab id = show that tab's content
  const [mobileSelectedTab, setMobileSelectedTab] = useState<SettingsTab | null>(null);
  const activeTab = controlledActiveTab ?? internalActiveTab;

  // Deep-link: if the caller changes the controlled tab after mount (e.g. "Open AI settings"),
  // drill into that tab on mobile
  const [prevControlledTab, setPrevControlledTab] = useState(controlledActiveTab);
  if (controlledActiveTab !== prevControlledTab) {
    setPrevControlledTab(controlledActiveTab);
    if (isMobile && controlledActiveTab && controlledActiveTab !== "general") {
      setMobileSelectedTab(controlledActiveTab);
    }
  }

  const handleTabChange = (tab: SettingsTab) => {
    if (controlledActiveTab === undefined) {
      setInternalActiveTab(tab);
    }
    onActiveTabChange?.(tab);
    if (isMobile) {
      setMobileSelectedTab(tab);
    }
  };

  const handleMobileBack = () => {
    setMobileSelectedTab(null);
  };

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
        <div className="fixed inset-0 z-50 bg-surface flex flex-col">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
            <button
              onClick={handleMobileBack}
              aria-label="Back to settings"
              className="p-1.5 -ml-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h2 className="text-lg font-bold text-on-surface">{tabMeta?.label ?? "Settings"}</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{renderTabContent(mobileSelectedTab)}</div>
        </div>
      );
    }

    // Index page
    return (
      <div className="fixed inset-0 z-50 bg-surface flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 -ml-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-lg font-bold text-on-surface">Settings</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
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
                      className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-surface-secondary active:bg-surface-tertiary transition-colors"
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

  // ── Desktop layout (unchanged) ──
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div className="bg-surface rounded-xl shadow-xl border border-border max-w-3xl w-full h-[85vh] flex flex-row overflow-hidden">
        {/* Left sidebar nav */}
        <div className="w-[220px] flex-shrink-0 border-r border-border bg-surface-secondary p-4 flex flex-col">
          <h2 className="text-lg font-bold text-on-surface mb-4 px-2">Settings</h2>
          <nav aria-label="Settings tabs" className="flex-1">
            <ul className="space-y-0.5">
              {TABS.map((tab) => (
                <li key={tab.id}>
                  <button
                    onClick={() => handleTabChange(tab.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
                      activeTab === tab.id
                        ? "bg-accent/10 text-accent font-medium"
                        : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                    }`}
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
              onClick={onClose}
              aria-label="Close settings"
              className="p-1.5 rounded-md text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">{renderTabContent(activeTab)}</div>
        </div>
      </div>
    </div>
  );
}
