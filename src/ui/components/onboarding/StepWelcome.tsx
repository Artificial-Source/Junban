import { Sparkles } from "lucide-react";

export function StepWelcome() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-[72px] h-[72px] rounded-2xl bg-accent/10 flex items-center justify-center mb-6">
        <Sparkles size={36} className="text-accent" />
      </div>
      <h2 className="text-2xl font-bold text-on-surface font-[Plus_Jakarta_Sans,sans-serif]">
        Welcome to Saydo
      </h2>
      <p className="text-[15px] text-on-surface-muted mt-2 max-w-xs">
        Your task manager. Simple, smart, yours.
      </p>
    </div>
  );
}
