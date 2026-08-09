import { createContext, useContext, useMemo, type ReactNode } from "react";
import { FIXTURE_COPY } from "./read-fixture";

type Task = {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  priority: number | null;
};

type TaskContextValue = {
  state: { tasks: Task[] };
  refreshTasks: () => Promise<void>;
};

const TaskContext = createContext<TaskContextValue | null>(null);

const DEMO_TASKS: Task[] = [
  {
    id: FIXTURE_COPY.focusedTaskId,
    title: FIXTURE_COPY.focusedTaskTitle,
    status: "pending",
    dueDate: "2026-08-02",
    priority: 1,
  },
  {
    id: "task_phase6_overdue_001",
    title: "Publish plugin author guide",
    status: "pending",
    dueDate: "2026-07-30",
    priority: 2,
  },
  {
    id: "task_phase6_today_002",
    title: "Triage documentation backlog",
    status: "pending",
    dueDate: "2026-08-02",
    priority: 3,
  },
  {
    id: "task_phase6_pending_003",
    title: "Draft release notes outline",
    status: "pending",
    dueDate: null,
    priority: 4,
  },
];

export function TaskProvider({ children }: { children: ReactNode }) {
  const value = useMemo<TaskContextValue>(
    () => ({
      state: { tasks: DEMO_TASKS },
      refreshTasks: async () => undefined,
    }),
    [],
  );
  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTaskContext(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) {
    throw new Error("useTaskContext requires TaskProvider in the Phase 6 harness");
  }
  return ctx;
}
