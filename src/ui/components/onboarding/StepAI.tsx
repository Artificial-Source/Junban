import { Bot } from "lucide-react";

export function StepAI({
  onSetWantsAI,
  onNext,
}: {
  onSetWantsAI: (v: boolean) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h2 className="text-[22px] font-bold text-on-surface text-center font-[Plus_Jakarta_Sans,sans-serif]">
        AI Assistant
      </h2>
      <p className="text-sm text-on-surface-muted text-center mt-1 mb-6 leading-relaxed">
        Saydo has a built-in AI that can help manage your tasks. Set this up now or later in Settings.
      </p>

      {/* Chat preview — bubble style matching design */}
      <div className="rounded-[14px] bg-surface-secondary p-4 mb-6 space-y-2.5">
        {/* Bot message */}
        <div className="flex items-start gap-2">
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center flex-shrink-0">
            <Bot size={16} className="text-white" />
          </div>
          <div className="bg-surface rounded-tl-sm rounded-tr-xl rounded-br-xl rounded-bl-xl px-3.5 py-2.5 max-w-[280px]">
            <p className="text-[13px] text-on-surface leading-snug">
              Good morning! You have 3 tasks due today. Want me to help prioritize them?
            </p>
          </div>
        </div>
        {/* User message */}
        <div className="flex justify-end">
          <div className="bg-accent rounded-tl-xl rounded-tr-sm rounded-br-xl rounded-bl-xl px-3.5 py-2.5">
            <p className="text-[13px] text-white">Yes, plan my day!</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <button
          onClick={() => {
            onSetWantsAI(true);
            onNext();
          }}
          className="w-full py-2.5 text-sm font-semibold bg-accent text-white rounded-xl hover:bg-accent/90 transition-colors"
        >
          I&apos;ll configure it now
        </button>
        <button
          onClick={() => {
            onSetWantsAI(false);
            onNext();
          }}
          className="w-full py-2.5 text-sm font-medium text-on-surface-muted bg-surface-secondary rounded-xl hover:bg-surface-tertiary transition-colors"
        >
          Set up later
        </button>
      </div>
    </div>
  );
}
