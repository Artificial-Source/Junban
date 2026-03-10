import { CheckCircle2, Type, Command, Puzzle } from "lucide-react";

export function StepReady() {
  const tips = [
    {
      icon: Type,
      text: 'Type naturally: "buy milk tomorrow p1 #groceries"',
    },
    {
      icon: Command,
      text: "Press Ctrl+K for the command palette",
    },
    {
      icon: Puzzle,
      text: "Explore plugins in Settings for more power",
    },
  ];

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-[72px] h-[72px] rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-5">
        <CheckCircle2 size={36} className="text-emerald-500" />
      </div>
      <h2 className="text-2xl font-bold text-on-surface font-[Plus_Jakarta_Sans,sans-serif]">
        You&apos;re all set!
      </h2>
      <p className="text-sm text-on-surface-muted mt-1.5 mb-6 max-w-xs leading-relaxed">
        Start adding tasks. Discover more features anytime in Settings.
      </p>
      <div className="w-full space-y-2">
        {tips.map((tip) => {
          const Icon = tip.icon;
          return (
            <div
              key={tip.text}
              className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] bg-surface-secondary text-left"
            >
              <Icon size={18} className="text-accent flex-shrink-0" />
              <span className="text-xs text-on-surface-secondary">{tip.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
