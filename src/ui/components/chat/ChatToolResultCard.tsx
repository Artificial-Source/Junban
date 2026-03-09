import { memo } from "react";
import {
  AlertTriangle,
  Zap,
  Tag,
  ListPlus,
  ListChecks,
  ListRestart,
  FolderOpen,
  BarChart3,
  Search,
  Puzzle,
  Bell,
  Sun,
  Sunset,
  type LucideIcon,
} from "lucide-react";
import { WorkloadChart, CompletionPatterns, EnergyRecommendations } from "./ChatVisualizations";
import {
  TaskListCard,
  TaskBreakdown,
  OvercommitmentStatus,
  TagSuggestions,
  SimilarTasks,
  ProjectList,
  ReminderList,
} from "./ChatTaskResults";
import {
  DayPlanCard,
  DailyReviewCard,
  BulkResultCard,
  WeeklyReviewCard,
} from "./ChatPlanningCards";

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
  plan_my_day: { icon: Sun, title: "Day Plan" },
  daily_review: { icon: Sunset, title: "Daily Review" },
  weekly_review: { icon: BarChart3, title: "Weekly Review" },
  bulk_create_tasks: { icon: ListPlus, title: "Tasks Created" },
  bulk_complete_tasks: { icon: ListChecks, title: "Tasks Completed" },
  bulk_update_tasks: { icon: ListRestart, title: "Tasks Updated" },
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
    case "plan_my_day":
      content = <DayPlanCard data={parsed} />;
      break;
    case "daily_review":
      content = <DailyReviewCard data={parsed} />;
      break;
    case "weekly_review":
      content = <WeeklyReviewCard data={parsed} />;
      break;
    case "bulk_create_tasks":
    case "bulk_complete_tasks":
    case "bulk_update_tasks":
      content = <BulkResultCard data={parsed} toolName={toolName} onSelectTask={onSelectTask} />;
      break;
    default:
      return null; // Fall back to badge display in MessageBubble
  }

  if (!content) return null;

  return <CardWrapper toolName={toolName}>{content}</CardWrapper>;
}
