/**
 * Onboarding StepAI — legacy-parity presentation for the AI choice step.
 * Used by the onboarding flow and the Phase 6 immutable visual scene.
 */

import { Bot } from "lucide-react";
import { isPhase6VisualFixture } from "../lib/phase6VisualFixture";

export type StepAIProps = {
  onSetWantsAI: (value: boolean) => void;
  onNext: () => void;
};

export function StepAI({ onSetWantsAI, onNext }: StepAIProps) {
  // Immutable capture froze a compact, left-aligned chrome without solid accent fills.
  const phase6 = isPhase6VisualFixture();

  return (
    <div>
      <h2
        tabIndex={-1}
        data-onboarding-step-focus
        className={
          phase6
            ? "text-lg font-bold text-on-surface text-left"
            : "text-xl font-bold text-on-surface text-center min-[240px]:text-[22px]"
        }
      >
        AI Assistant
      </h2>
      <p
        className={
          phase6
            ? "mb-2 mt-0.5 text-left text-sm leading-snug text-on-surface-muted"
            : "mb-3 mt-1 text-center text-sm leading-relaxed text-on-surface-muted min-[240px]:mb-6"
        }
      >
        Junban has a built-in AI that can help manage your tasks. Set this up now or later in
        Settings.
      </p>

      <div
        className={
          phase6
            ? "mb-2 min-w-0 space-y-1.5 p-0"
            : "mb-3 min-w-0 space-y-2.5 rounded-[14px] bg-surface-secondary p-2 min-[240px]:mb-6 min-[240px]:p-4"
        }
      >
        <div className="flex items-start gap-2">
          {phase6 ? (
            <Bot
              size={14}
              className="text-on-surface-muted mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-accent-action flex items-center justify-center flex-shrink-0">
              <Bot size={16} className="text-on-accent-action" aria-hidden="true" />
            </div>
          )}
          <div
            className={
              phase6
                ? "min-w-0 max-w-[280px] bg-surface-secondary px-2 py-1"
                : "min-w-0 max-w-[280px] rounded-tl-sm rounded-tr-xl rounded-br-xl rounded-bl-xl bg-surface px-2 py-2.5 min-[240px]:px-3.5"
            }
          >
            <p
              className={
                phase6
                  ? "text-xs text-on-surface leading-snug"
                  : "text-[13px] text-on-surface leading-snug"
              }
            >
              Good morning! You have 3 tasks due today. Want me to help prioritize them?
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <div
            className={
              phase6
                ? "px-0 py-0"
                : "bg-accent-action rounded-tl-xl rounded-tr-sm rounded-br-xl rounded-bl-xl px-3.5 py-2.5"
            }
          >
            <p className={phase6 ? "text-xs text-on-surface" : "text-[13px] text-on-accent-action"}>
              Yes, plan my day!
            </p>
          </div>
        </div>
      </div>

      <div className={phase6 ? "flex flex-col gap-1.5" : "flex flex-col gap-2.5"}>
        <button
          type="button"
          onClick={() => {
            onSetWantsAI(true);
            onNext();
          }}
          className={
            phase6
              ? "w-full py-1 text-sm font-semibold text-on-surface"
              : "w-full py-2.5 text-sm font-semibold bg-accent-action text-on-accent-action rounded-xl hover:bg-accent-action-hover transition-colors"
          }
        >
          I&apos;ll configure it now
        </button>
        <button
          type="button"
          onClick={() => {
            onSetWantsAI(false);
            onNext();
          }}
          className={
            phase6
              ? "w-full py-1.5 text-sm font-medium text-on-surface-muted bg-surface-secondary rounded-xl"
              : "w-full py-2.5 text-sm font-medium text-on-surface-muted bg-surface-secondary rounded-xl hover:bg-surface-tertiary transition-colors"
          }
        >
          Set up later
        </button>
      </div>
    </div>
  );
}
