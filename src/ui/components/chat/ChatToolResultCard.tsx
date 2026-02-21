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
  BarChart3,
  Search,
  Puzzle,
  Bell,
  type LucideIcon,
} from "lucide-react";

interface ToolResult {
  toolName: string;
  data: string;
}

interface ChatToolResultCardProps {
  toolResults: ToolResult[];
  onSelectTask?: (taskId: string) => void;
}

const TOOL_CARD_META: Record<string, { icon: LucideIcon; title: string }> = {
  analyze_workload: { icon: BarChart3, title: "Workload Overview" },
  analyze_completion_patterns: { icon: BarChart3, title: "Completion Patterns" },
  get_energy_recommendations: { icon: Zap, title: "Energy Recommendations" },
  query_tasks: { icon: Search, title: "Task Results" },
  list_tasks: { icon: Search, title: "Task Results" },
  break_down_task: { icon: Puzzle, title: "Task Breakdown" },
  check_overcommitment: { icon: AlertTriangle, title: "Commitment Status" },
  suggest_tags: { icon: Tag, title: "Suggested Tags" },
  find_similar_tasks: { icon: Search, title: "Similar Tasks" },
  check_duplicates: { icon: Search, title: "Duplicate Check" },
  list_projects: { icon: FolderOpen, title: "Projects" },
  list_reminders: { icon: Bell, title: "Reminders" },
};

function CardWrapper({ toolName, children }: { toolName: string; children: React.ReactNode }) {
  const meta = TOOL_CARD_META[toolName];
  if (!meta) return <>{children}</>;

  const Icon = meta.icon;
  return (
    <div className="rounded-xl border border-border bg-surface shadow-sm overflow-hidden animate-scale-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-secondary/50 border-b border-border/50">
        <div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center">
          <Icon size={11} className="text-accent" />
        </div>
        <span className="text-xs font-medium text-on-surface-secondary">{meta.title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

export const ChatToolResultCard = memo(function ChatToolResultCard({
  toolResults,
  onSelectTask,
}: ChatToolResultCardProps) {
  return (
    <div className="space-y-2">
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

  const toolName = result.toolName;
  let content: React.ReactNode = null;

  switch (toolName) {
    case "analyze_workload":
      content = <WorkloadChart data={parsed} />;
      break;
    case "analyze_completion_patterns":
      content = <CompletionPatterns data={parsed} />;
      break;
    case "get_energy_recommendations":
      content = <EnergyRecommendations data={parsed} />;
      break;
    case "query_tasks":
    case "list_tasks":
      content = <TaskListCard data={parsed} onSelectTask={onSelectTask} />;
      break;
    case "break_down_task":
      content = <TaskBreakdown data={parsed} />;
      break;
    case "check_overcommitment":
      content = <OvercommitmentStatus data={parsed} />;
      break;
    case "suggest_tags":
      content = <TagSuggestions data={parsed} />;
      break;
    case "find_similar_tasks":
    case "check_duplicates":
      content = <SimilarTasks data={parsed} onSelectTask={onSelectTask} />;
      break;
    case "list_projects":
      content = <ProjectList data={parsed} />;
      break;
    case "list_reminders":
      content = <ReminderList data={parsed} />;
      break;
    default:
      return null; // Fall back to badge display in MessageBubble
  }

  if (!content) return null;

  return <CardWrapper toolName={toolName}>{content}</CardWrapper>;
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
    <div className="space-y-1.5">
      {days.map((day, i) => {
        const count = day.count ?? day.tasks ?? 0;
        const label = day.date ?? day.day ?? `Day ${i + 1}`;
        const pct = Math.round((count / maxCount) * 100);
        const isOverloaded = day.overloaded;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-on-surface-muted truncate">{label}</span>
            <div className="flex-1 h-2.5 bg-surface-tertiary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isOverloaded ? "bg-error/70" : "bg-accent/60"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span
              className={`w-6 text-right tabular-nums ${isOverloaded ? "text-error font-medium" : "text-on-surface-muted"}`}
            >
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
    <div className="space-y-3">
      {weekdays.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-2">
            Activity by Day
          </p>
          <div className="flex items-end gap-1.5 h-14">
            {weekdays.map((w, i) => {
              const count = w.count ?? w.completed ?? 0;
              const pct = Math.round((count / maxDay) * 100);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full bg-accent/40 rounded-sm transition-all duration-500"
                    style={{ height: `${Math.max(pct, 6)}%` }}
                    title={`${w.day ?? w.name}: ${count}`}
                  />
                  <span className="text-[9px] text-on-surface-muted font-medium">
                    {(w.day ?? w.name ?? "").slice(0, 2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {topTags.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-on-surface-muted uppercase tracking-wider mb-1.5">
            Top Tags
          </p>
          {topTags.slice(0, 5).map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs mb-1">
              <span className="w-20 shrink-0 text-on-surface-muted truncate">
                #{t.tag ?? t.name}
              </span>
              <div className="flex-1 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent/50 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round(((t.count ?? 0) / maxTag) * 100)}%` }}
                />
              </div>
              <span className="w-4 text-right text-on-surface-muted tabular-nums">{t.count}</span>
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
    <div className="space-y-3">
      {quickWins.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-2">
            <Zap size={12} className="text-warning" />
            Quick Wins
          </p>
          <div className="flex flex-wrap gap-1.5">
            {quickWins.map((t, i) => (
              <span
                key={i}
                className="inline-flex px-2.5 py-1 text-xs bg-warning/10 text-warning rounded-lg font-medium"
              >
                {t.title ?? `Task ${i + 1}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {deepWork.length > 0 && (
        <div>
          <p className="text-xs font-medium text-on-surface-secondary flex items-center gap-1.5 mb-2">
            <Brain size={12} className="text-info" />
            Deep Work
          </p>
          <div className="flex flex-wrap gap-1.5">
            {deepWork.map((t, i) => (
              <span
                key={i}
                className="inline-flex px-2.5 py-1 text-xs bg-info/10 text-info rounded-lg font-medium"
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

const PRIORITY_COLORS: Record<number, string> = {
  1: "bg-error/80 text-white",
  2: "bg-warning/80 text-white",
  3: "bg-info/80 text-white",
  4: "bg-on-surface-muted/30 text-on-surface-muted",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

function formatDueLabel(dueDate: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 7) return `${due.toLocaleDateString("en", { weekday: "short" })}`;
  return due.toLocaleDateString("en", { month: "short", day: "numeric" });
}

interface TaskResultItem {
  id?: string;
  title?: string;
  status?: string;
  priority?: number;
  dueDate?: string;
  tags?: string[];
  projectId?: string;
}

function TaskListCard({
  data,
  onSelectTask,
}: {
  data: Record<string, unknown>;
  onSelectTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tasks = (data.tasks ?? []) as TaskResultItem[];

  if (tasks.length === 0) return null;

  const visibleTasks = expanded ? tasks : tasks.slice(0, 5);
  const hasMore = tasks.length > 5;
  const pendingCount = tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  ).length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;

  return (
    <div>
      {/* Summary bar */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
        </button>
        <div className="flex items-center gap-1.5 text-[10px] text-on-surface-muted">
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              {pendingCount} pending
            </span>
          )}
          {completedCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              {completedCount} done
            </span>
          )}
        </div>
      </div>
      {/* Task rows */}
      <div className="space-y-px">
        {visibleTasks.map((task, i) => {
          const isCompleted = task.status === "completed";
          const isOverdue = !isCompleted && task.dueDate && new Date(task.dueDate) < new Date();
          return (
            <button
              key={task.id ?? i}
              onClick={() => task.id && onSelectTask?.(task.id)}
              className="w-full text-left px-2.5 py-2 rounded-lg text-xs hover:bg-surface-secondary/80 transition-colors flex items-center gap-2 group/row"
            >
              {isCompleted ? (
                <CheckCircle2 size={14} className="text-success shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full border-2 border-on-surface-muted/30 shrink-0 group-hover/row:border-accent transition-colors" />
              )}
              <span
                className={`flex-1 min-w-0 truncate ${
                  isCompleted ? "line-through text-on-surface-muted" : "text-on-surface"
                }`}
              >
                {task.title}
              </span>
              {/* Priority badge */}
              {task.priority && task.priority >= 1 && task.priority <= 4 && (
                <span
                  className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[task.priority]}`}
                >
                  {PRIORITY_LABELS[task.priority]}
                </span>
              )}
              {/* Due date */}
              {task.dueDate && (
                <span
                  className={`shrink-0 flex items-center gap-0.5 text-[10px] ${
                    isOverdue ? "text-error font-medium" : "text-on-surface-muted"
                  }`}
                >
                  <Clock size={9} />
                  {formatDueLabel(task.dueDate)}
                </span>
              )}
              {/* Tag dots */}
              {task.tags && task.tags.length > 0 && (
                <div className="shrink-0 flex items-center gap-0.5">
                  {task.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="w-1.5 h-1.5 rounded-full bg-accent/50" title={tag} />
                  ))}
                </div>
              )}
            </button>
          );
        })}
        {hasMore && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-accent hover:text-accent-hover px-2.5 py-1.5 font-medium"
          >
            +{tasks.length - 5} more
          </button>
        )}
      </div>
    </div>
  );
}

function TaskBreakdown({ data }: { data: Record<string, unknown> }) {
  const parent = (data.parent ?? data.task) as { title?: string } | undefined;
  const subtasks = (data.subtasks ?? data.steps ?? []) as {
    title?: string;
    description?: string;
  }[];

  if (subtasks.length === 0) return null;

  return (
    <div>
      {parent?.title && (
        <p className="text-xs font-semibold text-on-surface mb-2">{parent.title}</p>
      )}
      <div className="ml-2 border-l-2 border-accent/30 pl-3 space-y-2">
        {subtasks.map((st, i) => (
          <div key={i} className="text-xs">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold shrink-0">
                {i + 1}
              </span>
              <p className="text-on-surface font-medium">{st.title ?? `Step ${i + 1}`}</p>
            </div>
            {st.description && (
              <p className="text-on-surface-muted text-[10px] mt-0.5 ml-6">{st.description}</p>
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
    <div>
      <div className="flex items-center gap-2.5">
        {overloaded ? (
          <>
            <div className="w-7 h-7 rounded-lg bg-error/10 flex items-center justify-center">
              <AlertTriangle size={14} className="text-error" />
            </div>
            <div>
              <span className="text-xs font-semibold text-error">Overloaded</span>
              {suggestion && (
                <p className="text-[10px] text-on-surface-muted mt-0.5">{suggestion}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="w-7 h-7 rounded-lg bg-success/10 flex items-center justify-center">
              <CheckCircle2 size={14} className="text-success" />
            </div>
            <div>
              <span className="text-xs font-semibold text-success">All clear</span>
              {suggestion && (
                <p className="text-[10px] text-on-surface-muted mt-0.5">{suggestion}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TagSuggestions({ data }: { data: Record<string, unknown> }) {
  const tags = (data.tags ?? data.suggestions ?? []) as (
    | string
    | { name?: string; tag?: string }
  )[];
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t, i) => {
        const name = typeof t === "string" ? t : (t.name ?? t.tag ?? "");
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-accent/10 text-accent rounded-lg font-medium"
          >
            <Tag size={10} />
            {name}
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
    <div className="space-y-0.5">
      {tasks.map((task, i) => {
        const pct = Math.round((task.similarity ?? task.score ?? 0) * 100);
        return (
          <button
            key={task.id ?? i}
            onClick={() => task.id && onSelectTask?.(task.id)}
            className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-on-surface hover:bg-surface-secondary/80 transition-colors flex items-center gap-2"
          >
            <span className="flex-1 truncate">{task.title}</span>
            {pct > 0 && (
              <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-md bg-accent/10 text-accent font-semibold tabular-nums">
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
    <div className="flex flex-wrap gap-1.5">
      {projects.map((p, i) => (
        <span
          key={p.id ?? i}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-surface-tertiary text-on-surface-secondary rounded-lg font-medium"
        >
          <span
            className="w-2.5 h-2.5 rounded-full"
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
    <div className="space-y-1">
      {reminders.map((r, i) => (
        <div
          key={r.id ?? i}
          className="flex items-center gap-2.5 text-xs px-2.5 py-1.5 rounded-lg hover:bg-surface-secondary/50 transition-colors"
        >
          <div className="w-5 h-5 rounded-md bg-accent/10 flex items-center justify-center shrink-0">
            <Clock size={10} className="text-accent" />
          </div>
          <span className="flex-1 truncate text-on-surface font-medium">
            {r.taskTitle ?? `Reminder ${i + 1}`}
          </span>
          {(r.remindAt ?? r.time) && (
            <span className="shrink-0 text-[10px] text-on-surface-muted tabular-nums">
              {(r.remindAt ?? r.time ?? "").slice(0, 16).replace("T", " ")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
