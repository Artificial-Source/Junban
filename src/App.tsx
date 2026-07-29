import { useState, useEffect } from "react";
import { bootstrapFragmentToken, hasStoredToken } from "./ui/api/client";
import { initTheme, applyDefaultAccentColor } from "./ui/themes/manager";
import { useRouting } from "./ui/hooks/useRouting";
import { useTasks } from "./ui/hooks/useTasks";
import { AppLayout } from "./ui/app/AppLayout";
import { ConnectionScreen } from "./ui/components/ConnectionScreen";

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  // Initialize the theme and accept connection links on first load or same-page navigation.
  useEffect(() => {
    initTheme();
    applyDefaultAccentColor();

    const authenticateFromLocation = () => {
      if (bootstrapFragmentToken() || hasStoredToken()) {
        setAuthenticated(true);
      }
    };

    authenticateFromLocation();
    window.addEventListener("hashchange", authenticateFromLocation);
    return () => window.removeEventListener("hashchange", authenticateFromLocation);
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
      onToggleTask={async (id) => (await taskState.toggleComplete(id)) !== null}
      onUpdateTask={async (taskId, title, dueDate) =>
        (await taskState.updateTask(taskId, title, dueDate)) !== null
      }
      onDeleteTask={taskState.deleteTask}
    />
  );
}
