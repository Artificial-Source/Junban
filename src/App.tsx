import { useState, useEffect } from "react";
import { bootstrapFragmentToken, hasStoredToken } from "./ui/api/client";
import { initTheme, applyDefaultAccentColor } from "./ui/themes/manager";
import { useRouting } from "./ui/hooks/useRouting";
import { useTasks } from "./ui/hooks/useTasks";
import { AppLayout } from "./ui/app/AppLayout";
import { ConnectionScreen } from "./ui/components/ConnectionScreen";

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  // Initialize theme and bootstrap fragment token on first mount.
  useEffect(() => {
    initTheme();
    applyDefaultAccentColor();
    const hasToken = bootstrapFragmentToken() || hasStoredToken();
    setAuthenticated(hasToken);
  }, []);

  const { view, navigate } = useRouting();
  const taskState = useTasks();

  if (!authenticated) {
    return <ConnectionScreen />;
  }

  return (
    <AppLayout
      view={view}
      navigate={navigate}
      tasks={taskState.tasks}
      loading={taskState.loading}
      error={taskState.error}
      onRetry={taskState.retry}
      onCreateTask={async (title, dueDate) => (await taskState.createTask(title, dueDate)) !== null}
      onToggleTask={(id) => void taskState.toggleComplete(id)}
      onUpdateTask={async (taskId, title, dueDate) =>
        (await taskState.updateTask(taskId, title, dueDate)) !== null
      }
      onDeleteTask={taskState.deleteTask}
    />
  );
}
