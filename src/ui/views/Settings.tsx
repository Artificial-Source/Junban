import { useState, useEffect, useCallback } from "react";
import {
  X,
  Palette,
  Bot,
  Mic,
  Puzzle,
  Keyboard,
  Database,
  Info,
  FileText,
} from "lucide-react";
import { GeneralTab } from "./settings/GeneralTab.js";
import { AITab } from "./settings/AITab.js";
import { VoiceTab } from "./settings/VoiceTab.js";
import { PluginsTab } from "./settings/PluginsTab.js";
import { TemplatesTab } from "./settings/TemplatesTab.js";
import { KeyboardTab } from "./settings/KeyboardTab.js";
import { DataTab } from "./settings/DataTab.js";
import { AboutTab } from "./settings/AboutTab.js";
import type { SettingsTab } from "./settings/types.js";

export type { SettingsTab };

interface SettingsProps {
  activeTab?: SettingsTab;
  onActiveTabChange?: (tab: SettingsTab) => void;
  onClose: () => void;
}

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Palette className="w-4 h-4" /> },
  { id: "ai", label: "AI Assistant", icon: <Bot className="w-4 h-4" /> },
  { id: "voice", label: "Voice", icon: <Mic className="w-4 h-4" /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle className="w-4 h-4" /> },
  { id: "templates", label: "Templates", icon: <FileText className="w-4 h-4" /> },
  { id: "keyboard", label: "Keyboard", icon: <Keyboard className="w-4 h-4" /> },
  { id: "data", label: "Data", icon: <Database className="w-4 h-4" /> },
  { id: "about", label: "About", icon: <Info className="w-4 h-4" /> },
];

export function Settings({ activeTab: controlledActiveTab, onActiveTabChange, onClose }: SettingsProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>("general");
  const activeTab = controlledActiveTab ?? internalActiveTab;

  const handleTabChange = (tab: SettingsTab) => {
    if (controlledActiveTab === undefined) {
      setInternalActiveTab(tab);
    }
    onActiveTabChange?.(tab);
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose],
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div className="bg-surface rounded-xl shadow-xl border border-border max-w-3xl w-full h-[85vh] flex overflow-hidden">
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
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "ai" && <AITab />}
            {activeTab === "voice" && <VoiceTab />}
            {activeTab === "plugins" && <PluginsTab />}
            {activeTab === "templates" && <TemplatesTab />}
            {activeTab === "keyboard" && <KeyboardTab />}
            {activeTab === "data" && <DataTab />}
            {activeTab === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
