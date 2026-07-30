/**
 * Task page: full-page task editor (mobile route /tasks/{id}).
 * Preserves the desktop panel's field set in a full-page layout.
 */
import { useState, useEffect } from "react";
import { FileQuestion } from "lucide-react";
import type { TaskDto } from "../api/client";
import { getTask } from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import { useRouting } from "../hooks/useRouting";
import { TaskDetailPanel } from "../components/TaskDetailPanel";
import { EmptyState } from "../components/Skeleton";

export function TaskPage() {
  const { route, navigate } = useRouting();
  const taskId = route.name === "task" ? route.taskId : null;
  const { revision } = useWorkspace();

  const [task, setTask] = useState<TaskDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void getTask(taskId)
      .then((t) => {
        setTask(t);
        setError(null);
      })
      .catch(() => {
        setError("Task not found");
        setTask(null);
      })
      .finally(() => setLoading(false));
  }, [taskId, revision]);

  if (!taskId) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-on-surface-muted" role="status">
          Loading task…
        </p>
      </div>
    );
  }

  if (error || !task) {
    return (
      <EmptyState
        icon={<FileQuestion size={40} strokeWidth={1.25} />}
        title={error ?? "Task not found"}
        description="This task may have been deleted."
      />
    );
  }

  return (
    <TaskDetailPanel
      task={task}
      onClose={() => navigate({ name: "today" })}
      onOpenFullPage={(id) => navigate({ name: "task", taskId: id })}
    />
  );
}
