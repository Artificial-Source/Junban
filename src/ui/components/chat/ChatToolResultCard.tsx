import { memo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Zap,
  Brain,
  Tag,
  FolderOpen,
} from "lucide-react";

interface ToolResult {
  toolName: string;
  data: string;
}

interface ChatToolResultCardProps {
  toolResults: ToolResult[];
  onSelectTask?: (taskId: string) => void;
}

export const ChatToolResultCard = memo(function ChatToolResultCard({
  toolResults,
  onSelectTask,
}: ChatToolResultCardProps) {
  return (
    <div className="space-y-1.5">
      {toolResults.map((tr, i) => (
        <ToolResultVisual key={i} result={tr} onSelectTask={onSelectTask} />
      ))}
    </div>
  );
});

function ToolResultVisual({
  result,
  onSelectTask,
}: {
  result: ToolResult;
  onSelectTask?: (taskId: string) => void;
}) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return null; // Skip non-JSON results — badge display handles these
  }

  switch (result.toolName) {
    case "analyze_workload":
      return <WorkloadChart data={parsed} />;
    case "analyze_completion_patterns":
      return <CompletionPatterns data={parsed} />;
    case "get_energy_recommendations":
      return <EnergyRecommendations data={parsed} />;
    case "query_tasks":
    case "list_tasks":
      return <TaskListCard data={parsed} onSelectTask={onSelectTask} />;
    case "break_down_task":
      return <TaskBreakdown data={parsed} />;
    case "check_overcommitment":
      return <OvercommitmentStatus data={parsed} />;
    case "suggest_tags":
      return <TagSuggestions data={parsed} />;
    case "find_similar_tasks":
    case "check_duplicates":
      return <SimilarTasks data={parsed} onSelectTask={onSelectTask} />;
    case "list_projects":
      return <ProjectList data={parsed} />;
    case "list_reminders":
      return <ReminderList data={parsed} />;
    default:
      return null; // Fall back to badge display in MessageBubble
  }
}

// --- Visualization Components ---

function WorkloadChart({ data }: { data: Record<string, unknown> }) {
  const days = (data.days ?? data.workload ?? []) as {
    date?: string;
    day?: string;
    count?: number;
    tasks?: number;
    overloaded?: boolean;
  }[];
  if (!Array.isArray(days) || days.length === 0) return null;

  const maxCount = Math.max(...days.map((d) => d.count ?? d.tasks ?? 0), 1);

  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-1.5 animate-scale-fade-in">
      <p className="text-xs font-medium text-on-surface-secondary mb-2">Workload Overview</p>
      {days.map((day, i) => {
        const count = day.count ?? day.tasks ?? 0;
        const label = day.date ?? day.day ?? `Day ${i + 1}`;
        const pct = Math.round((count / maxCount) * 100);
        const isOverloaded = day.overloaded;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-on-surface-muted truncate">{label}</span>
            <div className="flex-1 h-2 bg-surface-tertiary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  isOverloaded ? "bg-error/60" : "bg-accent/60"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={`w-6 text-right ${isOverloaded ? "text-error font-medium" : "text-on-surface-muted"}`}>
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CompletionPatterns({ data }: { data: Record<string, unknown> }) {
  const weekdays = (data.weekdays ?? data.byDay ?? []) as {
    day?: string;
    name?: string;
    count?: number;
    completed?: number;
  }[];
  const topTags = (data.topTags ?? data.tags ?? []) as {
    tag?: string;
    name?: string;
    count?: number;
  }[];

  if (weekdays.length === 0 && topTags.length === 0) return null;

  const maxDay = Math.max(...weekdays.map((w) => w.count ?? w.completed ?? 0), 1);
  const maxTag = Math.max(...topTags.map((t) => t.count ?? 0), 1);

  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-3 animate-scale-fade-in">
      {weekdays.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary mb-2">Activity by Day</p>
          <div className="flex items-end gap-1 h-12">
            {weekdays.map((w, i) => {
              const count = w.count ?? w.completed ?? 0;
              const pct = Math.round((count / maxDay) * 100);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <div
                    className="w-full bg-accent/40 rounded-t"
                    style={{ height: `${Math.max(pct, 4)}%` }}
                    title={`${w.day ?? w.name}: ${count}`}
                  />
                  <span className="text-[9px] text-on-surface-muted">{(w.day ?? w.name ?? "").slice(0, 2)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {topTags.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary mb-1.5">Top Tags</p>
          {topTags.slice(0, 5).map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs mb-1">
              <span className="w-20 shrink-0 text-on-surface-muted truncate">#{t.tag ?? t.name}</span>
              <div className="flex-1 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent/50 rounded-full"
                  style={{ width: `${Math.round(((t.count ?? 0) / maxTag) * 100)}%` }}
                />
              </div>
              <span className="w-4 text-right text-on-surface-muted">{t.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnergyRecommendations({ data }: { data: Record<string, unknown> }) {
  const quickWins = (data.quickWins ?? data.quick ?? []) as { title?: string; id?: string }[];
  const deepWork = (data.deepWork ?? data.deep ?? []) as { title?: string; id?: string }[];

  if (quickWins.length === 0 && deepWork.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-2.5 animate-scale-fade-in">
      {quickWins.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-1.5">
            <Zap size={12} className="text-warning" />
            Quick Wins
          </p>
          <div className="flex flex-wrap gap-1">
            {quickWins.map((t, i) => (
              <span
                key={i}
                className="inline-flex px-2 py-0.5 text-xs bg-warning/10 text-warning rounded-full"
              >
                {t.title ?? `Task ${i + 1}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {deepWork.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-1.5">
            <Brain size={12} className="text-info" />
            Deep Work
          </p>
          <div className="flex flex-wrap gap-1">
            {deepWork.map((t, i) => (
              <span
                key={i}
                className="inline-flex px-2 py-0.5 text-xs bg-info/10 text-info rounded-full"
              >
                {t.title ?? `Task ${i + 1}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskListCard({
  data,
  onSelectTask,
}: {
  data: Record<string, unknown>;
  onSelectTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tasks = (data.tasks ?? []) as { id?: string; title?: string; status?: string }[];

  if (tasks.length === 0) return null;

  const visibleTasks = expanded ? tasks : tasks.slice(0, 3);
  const hasMore = tasks.length > 3;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5 animate-scale-fade-in">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary w-full text-left mb-1.5"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {tasks.length} task{tasks.length !== 1 ? "s" : ""} found
      </button>
      <div className="space-y-0.5">
        {visibleTasks.map((task, i) => (
          <button
            key={task.id ?? i}
            onClick={() => task.id && onSelectTask?.(task.id)}
            className="w-full text-left px-2 py-1 rounded text-xs text-on-surface hover:bg-surface-secondary transition-colors truncate flex items-center gap-1.5"
          >
            {task.status === "completed" ? (
              <CheckCircle2 size={10} className="text-success shrink-0" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full border border-on-surface-muted/40 shrink-0" />
            )}
            {task.title}
          </button>
        ))}
        {hasMore && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-accent hover:text-accent-hover px-2 py-0.5"
          >
            +{tasks.length - 3} more
          </button>
        )}
      </div>
    </div>
  );
}

function TaskBreakdown({ data }: { data: Record<string, unknown> }) {
  const parent = (data.parent ?? data.task) as { title?: string } | undefined;
  const subtasks = (data.subtasks ?? data.steps ?? []) as { title?: string; description?: string }[];

  if (subtasks.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-3 animate-scale-fade-in">
      {parent?.title && (
        <p className="text-xs font-medium text-on-surface mb-2">{parent.title}</p>
      )}
      <div className="ml-2 border-l-2 border-accent/30 pl-3 space-y-1.5">
        {subtasks.map((st, i) => (
          <div key={i} className="text-xs">
            <p className="text-on-surface">{st.title ?? `Step ${i + 1}`}</p>
            {st.description && (
              <p className="text-on-surface-muted text-[10px] mt-0.5">{st.description}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function OvercommitmentStatus({ data }: { data: Record<string, unknown> }) {
  const overloaded = data.overloaded ?? data.isOverloaded ?? data.overcommitted;
  const suggestion = (data.suggestion ?? data.message ?? data.recommendation) as string | undefined;

  return (
    <div className="rounded-lg border border-border bg-surface p-3 animate-scale-fade-in">
      <div className="flex items-center gap-2">
        {overloaded ? (
          <>
            <div className="w-6 h-6 rounded-full bg-error/10 flex items-center justify-center">
              <AlertTriangle size={12} className="text-error" />
            </div>
            <span className="text-xs font-medium text-error">Overloaded</span>
          </>
        ) : (
          <>
            <div className="w-6 h-6 rounded-full bg-success/10 flex items-center justify-center">
              <CheckCircle2 size={12} className="text-success" />
            </div>
            <span className="text-xs font-medium text-success">All clear</span>
          </>
        )}
      </div>
      {suggestion && (
        <p className="text-xs text-on-surface-muted mt-1.5 ml-8">{suggestion}</p>
      )}
    </div>
  );
}

function TagSuggestions({ data }: { data: Record<string, unknown> }) {
  const tags = (data.tags ?? data.suggestions ?? []) as (string | { name?: string; tag?: string })[];
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 animate-scale-fade-in">
      <Tag size={12} className="text-on-surface-muted mt-0.5" />
      {tags.map((t, i) => {
        const name = typeof t === "string" ? t : (t.name ?? t.tag ?? "");
        return (
          <span
            key={i}
            className="inline-flex px-2 py-0.5 text-xs bg-accent/10 text-accent rounded-full"
          >
            #{name}
          </span>
        );
      })}
    </div>
  );
}

function SimilarTasks({
  data,
  onSelectTask,
}: {
  data: Record<string, unknown>;
  onSelectTask?: (taskId: string) => void;
}) {
  const tasks = (data.tasks ?? data.similar ?? data.duplicates ?? []) as {
    id?: string;
    title?: string;
    similarity?: number;
    score?: number;
  }[];
  if (tasks.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5 space-y-1 animate-scale-fade-in">
      {tasks.map((task, i) => {
        const pct = Math.round((task.similarity ?? task.score ?? 0) * 100);
        return (
          <button
            key={task.id ?? i}
            onClick={() => task.id && onSelectTask?.(task.id)}
            className="w-full text-left px-2 py-1 rounded text-xs text-on-surface hover:bg-surface-secondary transition-colors flex items-center gap-2"
          >
            <span className="flex-1 truncate">{task.title}</span>
            {pct > 0 && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-medium">
                {pct}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ProjectList({ data }: { data: Record<string, unknown> }) {
  const projects = (data.projects ?? []) as {
    id?: string;
    name?: string;
    color?: string;
  }[];
  if (projects.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 animate-scale-fade-in">
      <FolderOpen size={12} className="text-on-surface-muted mt-1" />
      {projects.map((p, i) => (
        <span
          key={p.id ?? i}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-surface-tertiary text-on-surface-secondary rounded-full"
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: p.color || "var(--color-accent)" }}
          />
          {p.name}
        </span>
      ))}
    </div>
  );
}

function ReminderList({ data }: { data: Record<string, unknown> }) {
  const reminders = (data.reminders ?? []) as {
    id?: string;
    taskTitle?: string;
    remindAt?: string;
    time?: string;
  }[];
  if (reminders.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface p-2.5 space-y-1 animate-scale-fade-in">
      {reminders.map((r, i) => (
        <div key={r.id ?? i} className="flex items-center gap-2 text-xs">
          <Clock size={10} className="text-on-surface-muted shrink-0" />
          <span className="flex-1 truncate text-on-surface">{r.taskTitle ?? `Reminder ${i + 1}`}</span>
          {(r.remindAt ?? r.time) && (
            <span className="shrink-0 text-[10px] text-on-surface-muted">
              {(r.remindAt ?? r.time ?? "").slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
