/**
 * Narrow pure AI onboarding card.
 * Versioned non-secret dismissal only — no wizard framework, no model download.
 */
import { Bot, Mic, Settings, X } from "lucide-react";

export interface AiOnboardingProps {
  onConfigureAi: () => void;
  onSetupVoice: () => void;
  onDismiss: () => void;
}

export function AiOnboarding({ onConfigureAi, onSetupVoice, onDismiss }: AiOnboardingProps) {
  return (
    <div
      role="region"
      aria-label="AI onboarding"
      className="mx-4 mt-4 mb-2 rounded-xl border border-border bg-surface-secondary p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-accent-action/10 flex items-center justify-center shrink-0">
          <Bot size={20} className="text-accent-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-on-surface">Meet your AI assistant</h3>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss onboarding"
              className="p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1 text-xs text-on-surface-muted leading-relaxed">
            Configure a provider to chat about tasks, plan your day, and approve tool actions. Voice
            stays optional and loads only when you set it up.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfigureAi}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-action text-on-accent-action hover:bg-accent-action-hover transition-colors"
            >
              <Settings size={12} aria-hidden="true" />
              Configure AI
            </button>
            <button
              type="button"
              onClick={onSetupVoice}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
            >
              <Mic size={12} aria-hidden="true" />
              Set up voice
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg text-on-surface-muted hover:bg-surface-tertiary transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
