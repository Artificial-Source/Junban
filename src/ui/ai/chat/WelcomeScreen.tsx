import { AlertTriangle, Bot, CalendarDays, ListTodo, Sun } from "lucide-react";
import { memo, useMemo } from "react";
import { isPhase6VisualFixture } from "../../lib/phase6VisualFixture";

export type WelcomeStats = {
  overdueCount: number;
  todayCount: number;
  pendingCount: number;
};

interface WelcomeScreenProps {
  mode: "panel" | "view";
  onSend: (text: string) => void;
  onDailyBriefing?: () => void;
  isStreaming: boolean;
  stats?: WelcomeStats;
  dailyBriefingEnabled?: boolean;
  /** Deterministic greeting for fixtures/tests. */
  greetingOverride?: string;
  timeOfDayOverride?: TimeOfDay;
}

type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

function getGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 21) return "Good evening";
  return "Good night";
}

function getTimeOfDay(now = new Date()): TimeOfDay {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

interface SuggestionItem {
  emoji: string;
  text: string;
}

function getSuggestions(
  pendingCount: number,
  overdueCount: number,
  mode: "panel" | "view",
  time: TimeOfDay,
): SuggestionItem[] {
  const maxItems = mode === "view" ? 4 : 3;
  const suggestions: SuggestionItem[] = [];

  if (overdueCount > 0) {
    suggestions.push({ emoji: "⏰", text: `What's overdue? (${overdueCount})` });
  }

  if (pendingCount === 0) {
    suggestions.push({ emoji: "📝", text: "Help me capture some tasks" });
    suggestions.push({ emoji: "📋", text: "What can you help me with?" });
    return suggestions.slice(0, maxItems);
  }

  const timeSuggestions: Record<TimeOfDay, SuggestionItem[]> = {
    morning: [
      { emoji: "☀️", text: "Plan my day" },
      { emoji: "📋", text: "What's on my plate?" },
    ],
    afternoon: [
      { emoji: "🎯", text: "What should I focus on?" },
      { emoji: "📊", text: "How's my day going?" },
    ],
    evening: [
      { emoji: "🌅", text: "Review my day" },
      { emoji: "📅", text: "What's left for tomorrow?" },
    ],
    night: [
      { emoji: "🌙", text: "Plan tomorrow" },
      { emoji: "📅", text: "Show my week" },
    ],
  };

  suggestions.push(...timeSuggestions[time]);

  const fillers: SuggestionItem[] = [
    { emoji: "📊", text: "Summarize my week" },
    { emoji: "📋", text: "What tasks do I have?" },
  ];
  for (const f of fillers) {
    if (suggestions.length >= maxItems) break;
    if (!suggestions.some((s) => s.text === f.text)) suggestions.push(f);
  }

  return suggestions.slice(0, maxItems);
}

export const WelcomeScreen = memo(function WelcomeScreen({
  mode,
  onSend,
  onDailyBriefing,
  isStreaming,
  stats,
  dailyBriefingEnabled = false,
  greetingOverride,
  timeOfDayOverride,
}: WelcomeScreenProps) {
  const isView = mode === "view";
  const greeting = greetingOverride ?? getGreeting();
  const timeOfDay = timeOfDayOverride ?? getTimeOfDay();
  const overdueCount = stats?.overdueCount ?? 0;
  const todayCount = stats?.todayCount ?? 0;
  const pendingCount = stats?.pendingCount ?? 0;

  const isMorning = timeOfDay === "morning";
  const showBriefingButton = dailyBriefingEnabled && isMorning && !isStreaming && onDailyBriefing;

  const viewSuggestions = useMemo(
    () => getSuggestions(pendingCount, overdueCount, "view", timeOfDay),
    [pendingCount, overdueCount, timeOfDay],
  );
  const panelSuggestions = useMemo(
    () => getSuggestions(pendingCount, overdueCount, "panel", timeOfDay),
    [pendingCount, overdueCount, timeOfDay],
  );

  if (isView) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center px-4 pb-24">
          <div className="w-16 h-16 rounded-full bg-accent-action/10 flex items-center justify-center mx-auto mb-6 shadow-lg">
            <Bot size={32} className="text-accent-foreground" aria-hidden="true" />
          </div>
          <h2 className="text-2xl font-light text-on-surface mb-2">{greeting}</h2>
          <p className="text-sm text-on-surface-muted mb-8">Let's get things done.</p>

          <div className="flex items-center justify-center gap-4 mb-8">
            {overdueCount > 0 && (
              <StatCard
                icon={<AlertTriangle size={14} aria-hidden="true" />}
                count={overdueCount}
                label="overdue"
                variant="error"
              />
            )}
            <StatCard
              icon={<CalendarDays size={14} aria-hidden="true" />}
              count={todayCount}
              label="due today"
            />
            <StatCard
              icon={<ListTodo size={14} aria-hidden="true" />}
              count={pendingCount}
              label="pending"
            />
          </div>

          {showBriefingButton && (
            <button
              type="button"
              onClick={onDailyBriefing}
              className={
                isPhase6VisualFixture()
                  ? "w-full max-w-md mx-auto mb-3 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-on-surface"
                  : "w-full max-w-md mx-auto mb-3 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent-action text-on-accent-action text-sm font-medium hover:bg-accent-action-hover transition-colors"
              }
            >
              <Sun size={16} aria-hidden="true" />
              Start Morning Briefing
            </button>
          )}

          <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
            {viewSuggestions.map((s) => (
              <button
                key={s.text}
                type="button"
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

  return (
    <div className="text-center mt-8 space-y-2">
      <p className="text-sm font-medium text-on-surface">{greeting}</p>
      <p className="text-xs text-on-surface-muted">
        {overdueCount > 0 && <span className="text-error">{overdueCount} overdue</span>}
        {overdueCount > 0 && todayCount > 0 && <span> · </span>}
        {todayCount > 0 && <span>{todayCount} today</span>}
        {(overdueCount > 0 || todayCount > 0) && pendingCount > 0 && <span> · </span>}
        {pendingCount > 0 && <span>{pendingCount} pending</span>}
        {overdueCount === 0 && todayCount === 0 && pendingCount === 0 && (
          <span>Ask me anything about your tasks!</span>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5 justify-center mt-3">
        {panelSuggestions.map((s) => (
          <button
            key={s.text}
            type="button"
            onClick={() => onSend(s.text)}
            disabled={isStreaming}
            className="px-2 py-1 text-xs bg-surface-tertiary text-on-surface-secondary rounded-md hover:bg-border disabled:opacity-50 transition-colors"
          >
            {s.text}
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
  const countColor = variant === "error" ? "text-error" : "text-on-surface-secondary";
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-secondary/50 text-on-surface-secondary">
      <span className={countColor}>{icon}</span>
      <span className={`text-sm font-medium ${countColor}`}>{count}</span>
      <span className="text-xs text-on-surface-muted">{label}</span>
    </div>
  );
}
