import { Bot, AlertTriangle, CalendarDays, ListTodo } from "lucide-react";
import { memo } from "react";
import { useTaskContext } from "../../context/TaskContext.js";

interface WelcomeScreenProps {
  mode: "panel" | "view";
  onSend: (text: string) => void;
  isStreaming: boolean;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Good night";
}

const VIEW_SUGGESTIONS = [
  { emoji: "\ud83d\udccb", text: "What tasks do I have?" },
  { emoji: "\ud83d\udcc5", text: "Plan my day" },
  { emoji: "\u23f0", text: "What's overdue?" },
  { emoji: "\ud83d\udcca", text: "Summarize my week" },
];

const PANEL_SUGGESTIONS = ["What tasks do I have?", "Plan my day", "What's overdue?"];

export const WelcomeScreen = memo(function WelcomeScreen({
  mode,
  onSend,
  isStreaming,
}: WelcomeScreenProps) {
  const { tasks } = useTaskContext();
  const isView = mode === "view";
  const greeting = getGreeting();

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const overdueCount = tasks.filter(
    (t) => t.status !== "completed" && t.dueDate && t.dueDate.slice(0, 10) < todayStr,
  ).length;
  const todayCount = tasks.filter(
    (t) => t.status !== "completed" && t.dueDate && t.dueDate.slice(0, 10) === todayStr,
  ).length;
  const pendingCount = tasks.filter((t) => t.status !== "completed").length;

  if (isView) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center px-4 pb-24">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6 shadow-[0_0_24px_rgba(var(--color-accent-rgb,99,102,241),0.15)]">
            <Bot size={32} className="text-accent" />
          </div>
          <h2 className="text-2xl font-light text-on-surface mb-2">
            {greeting}
          </h2>
          <p className="text-sm text-on-surface-muted mb-8">
            Let's get things done.
          </p>

          {/* Stat cards */}
          <div className="flex items-center justify-center gap-4 mb-8">
            {overdueCount > 0 && (
              <StatCard icon={<AlertTriangle size={14} />} count={overdueCount} label="overdue" variant="error" />
            )}
            <StatCard icon={<CalendarDays size={14} />} count={todayCount} label="due today" />
            <StatCard icon={<ListTodo size={14} />} count={pendingCount} label="pending" />
          </div>

          <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
            {VIEW_SUGGESTIONS.map((s) => (
              <button
                key={s.text}
                onClick={() => onSend(s.text)}
                disabled={isStreaming}
                className="rounded-xl border border-border px-4 py-3 text-left text-sm text-on-surface-secondary hover:bg-surface-tertiary disabled:opacity-50 transition-colors"
              >
                <span className="mr-2">{s.emoji}</span>
                {s.text}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Panel mode — compact
  return (
    <div className="text-center mt-8 space-y-2">
      <p className="text-sm font-medium text-on-surface">{greeting}</p>
      <p className="text-xs text-on-surface-muted">
        {overdueCount > 0 && (
          <span className="text-error">{overdueCount} overdue</span>
        )}
        {overdueCount > 0 && todayCount > 0 && <span> &middot; </span>}
        {todayCount > 0 && <span>{todayCount} today</span>}
        {(overdueCount > 0 || todayCount > 0) && pendingCount > 0 && <span> &middot; </span>}
        {pendingCount > 0 && <span>{pendingCount} pending</span>}
        {overdueCount === 0 && todayCount === 0 && pendingCount === 0 && (
          <span>Ask me anything about your tasks!</span>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5 justify-center mt-3">
        {PANEL_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => onSend(suggestion)}
            disabled={isStreaming}
            className="px-2 py-1 text-xs bg-surface-tertiary text-on-surface-secondary rounded-md hover:bg-border disabled:opacity-50 transition-colors"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
});

function StatCard({
  icon,
  count,
  label,
  variant,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  variant?: "error";
}) {
  const textColor = variant === "error" ? "text-error" : "text-on-surface-secondary";
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-secondary/50 ${textColor}`}>
      {icon}
      <span className="text-sm font-medium">{count}</span>
      <span className="text-xs opacity-70">{label}</span>
    </div>
  );
}
