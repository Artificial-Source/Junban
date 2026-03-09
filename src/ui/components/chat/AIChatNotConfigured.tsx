/**
 * Empty state shown when no AI provider is configured.
 */

import { Bot, Settings, X } from "lucide-react";

interface AIChatNotConfiguredProps {
  onClose: () => void;
  onOpenSettings: () => void;
  isView: boolean;
}

export function AIChatNotConfigured({ onClose, onOpenSettings, isView }: AIChatNotConfiguredProps) {
  return (
    <aside
      className={`${isView ? "w-full h-full" : "w-full h-full md:w-80 md:h-auto border-l-0 md:border-l border-border"} flex flex-col bg-surface`}
    >
      {!isView && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm text-on-surface">AI Chat</h3>
          <button
            onClick={onClose}
            aria-label="Close AI chat"
            className="text-on-surface-muted hover:text-on-surface-secondary transition-colors p-1 rounded-md hover:bg-surface-tertiary"
          >
            <X size={18} />
          </button>
        </div>
      )}
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div
          className={`${isView ? "w-16 h-16 mb-6" : "w-12 h-12 mb-4"} rounded-full bg-accent/10 flex items-center justify-center`}
        >
          <Bot size={isView ? 32 : 24} className="text-accent" />
        </div>
        <h4 className={`font-medium ${isView ? "text-lg mb-2" : "text-sm mb-2"} text-on-surface`}>
          AI Assistant
        </h4>
        <p className={`${isView ? "text-sm mb-6 max-w-md" : "text-xs mb-4"} text-on-surface-muted`}>
          Configure an AI provider in Settings to start chatting.
        </p>
        <button
          onClick={onOpenSettings}
          className={`${isView ? "px-5 py-2.5" : "px-4 py-2"} text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors flex items-center gap-2`}
        >
          <Settings size={isView ? 16 : 14} />
          Open Settings
        </button>
      </div>
    </aside>
  );
}
