import { Bot, AlertTriangle, CalendarDays, ListTodo, Sun } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTaskContext } from "../../context/TaskContext.js";
import { api } from "../../api/index.js";

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

type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
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
): SuggestionItem[] {
  const time = getTimeOfDay();
  const maxItems = mode === "view" ? 4 : 3;
  const suggestions: SuggestionItem[] = [];

  // Always include overdue if any exist
  if (overdueCount > 0) {
    suggestions.push({
      emoji: "\u23f0",
      text: `What's overdue? (${overdueCount})`,
    });
  }

  // No tasks state
  if (pendingCount === 0) {
    suggestions.push({ emoji: "\ud83d\udcdd", text: "Help me capture some tasks" });
    suggestions.push({ emoji: "\ud83d\udccb", text: "What can you help me with?" });
    return suggestions.slice(0, maxItems);
  }

  // Time-based suggestions
  const timeSuggestions: Record<TimeOfDay, SuggestionItem[]> = {
    morning: [
      { emoji: "\u2600\ufe0f", text: "Plan my day" },
      { emoji: "\ud83d\udccb", text: "What's on my plate?" },
    ],
    afternoon: [
      { emoji: "\ud83c\udfaf", text: "What should I focus on?" },
      { emoji: "\ud83d\udcca", text: "How's my day going?" },
    ],
    evening: [
      { emoji: "\ud83c\udf05", text: "Review my day" },
      { emoji: "\ud83d\udcc5", text: "What's left for tomorrow?" },
    ],
    night: [
      { emoji: "\ud83c\udf19", text: "Plan tomorrow" },
      { emoji: "\ud83d\udcc5", text: "Show my week" },
    ],
  };

  suggestions.push(...timeSuggestions[time]);

  // Fill remaining slots with universal suggestions
  const fillers: SuggestionItem[] = [
    { emoji: "\ud83d\udcca", text: "Summarize my week" },
    { emoji: "\ud83d\udccb", text: "What tasks do I have?" },
  ];
  for (const f of fillers) {
    if (suggestions.length >= maxItems) break;
    if (!suggestions.some((s) => s.text === f.text)) {
      suggestions.push(f);
    }
  }

  return suggestions.slice(0, maxItems);
}

export const WelcomeScreen = memo(function WelcomeScreen({
  mode,
  onSend,
  isStreaming,
}: WelcomeScreenProps) {
  const { state } = useTaskContext();
  const tasks = state.tasks ?? [];
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

  // Auto-briefing: send "Plan my day" if enabled and it's morning
  const [briefingEnabled, setBriefingEnabled] = useState(false);
  const briefingTriggered = useRef(false);

  useEffect(() => {
    api
      .getAppSetting("ai_daily_briefing")
      .then((val) => setBriefingEnabled(val === "on"))
      .catch((err: unknown) => console.warn("[chat] Failed to load briefing setting:", err));
  }, []);

  useEffect(() => {
    if (!briefingEnabled || briefingTriggered.current || isStreaming) return;
    const hour = new Date().getHours();
    if (hour < 5 || hour >= 12) return;

    // Check if already triggered today
    const today = new Date().toISOString().slice(0, 10);
    const lastBriefing = localStorage.getItem("saydo-last-briefing-date");
    if (lastBriefing === today) return;

    briefingTriggered.current = true;
    localStorage.setItem("saydo-last-briefing-date", today);
    onSend("Plan my day");
  }, [briefingEnabled, isStreaming, onSend]);

  const isMorning = getTimeOfDay() === "morning";
  const showBriefingButton = briefingEnabled && isMorning && !isStreaming;

  const viewSuggestions = useMemo(
    () => getSuggestions(pendingCount, overdueCount, "view"),
    [pendingCount, overdueCount],
  );
  const panelSuggestions = useMemo(
    () => getSuggestions(pendingCount, overdueCount, "panel"),
    [pendingCount, overdueCount],
  );

  if (isView) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center px-4 pb-24">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6 shadow-[0_0_24px_rgba(var(--color-accent-rgb,99,102,241),0.15)]">
            <Bot size={32} className="text-accent" />
          </div>
          <h2 className="text-2xl font-light text-on-surface mb-2">{greeting}</h2>
          <p className="text-sm text-on-surface-muted mb-8">Let's get things done.</p>

          {/* Stat cards */}
          <div className="flex items-center justify-center gap-4 mb-8">
            {overdueCount > 0 && (
              <StatCard
                icon={<AlertTriangle size={14} />}
                count={overdueCount}
                label="overdue"
                variant="error"
              />
            )}
            <StatCard icon={<CalendarDays size={14} />} count={todayCount} label="due today" />
            <StatCard icon={<ListTodo size={14} />} count={pendingCount} label="pending" />
          </div>

          {showBriefingButton && (
            <button
              onClick={() => onSend("Plan my day")}
              className="w-full max-w-md mx-auto mb-3 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              <Sun size={16} />
              Start Morning Briefing
            </button>
          )}

          <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
            {viewSuggestions.map((s) => (
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
        {overdueCount > 0 && <span className="text-error">{overdueCount} overdue</span>}
        {overdueCount > 0 && todayCount > 0 && <span> &middot; </span>}
        {todayCount > 0 && <span>{todayCount} today</span>}
        {(overdueCount > 0 || todayCount > 0) && pendingCount > 0 && <span> &middot; </span>}
        {pendingCount > 0 && <span>{pendingCount} pending</span>}
        {overdueCount === 0 && todayCount === 0 && pendingCount === 0 && (
          <span>Ask me anything about your tasks!</span>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5 justify-center mt-3">
        {panelSuggestions.map((s) => (
          <button
            key={s.text}
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
  const textColor = variant === "error" ? "text-error" : "text-on-surface-secondary";
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-secondary/50 ${textColor}`}
    >
      {icon}
      <span className="text-sm font-medium">{count}</span>
      <span className="text-xs opacity-70">{label}</span>
    </div>
  );
}
