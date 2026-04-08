import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type { Task, CreateTaskInput, UpdateTaskInput } from "../../core/types.js";
import {
  completeManyTasks as completeManyTasksApi,
  completeTask as completeTaskApi,
  createTask as createTaskApi,
  deleteManyTasks as deleteManyTasksApi,
  deleteTask as deleteTaskApi,
  listTasks,
  updateManyTasks as updateManyTasksApi,
  updateTask as updateTaskApi,
} from "../api/tasks.js";

interface TaskState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
}

type TaskAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; tasks: Task[] }
  | { type: "LOAD_ERROR"; error: string }
  | { type: "TASK_ADDED"; task: Task }
  | { type: "TASK_UPDATED"; task: Task }
  | { type: "TASK_REMOVED"; id: string }
  | { type: "TASKS_UPDATED"; tasks: Task[] }
  | { type: "TASKS_REMOVED"; ids: string[] };

function taskReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, loading: true, error: null };
    case "LOAD_SUCCESS":
      return { tasks: action.tasks, loading: false, error: null };
    case "LOAD_ERROR":
      return { ...state, loading: false, error: action.error };
    case "TASK_ADDED":
      return { ...state, tasks: [...state.tasks, action.task] };
    case "TASK_UPDATED":
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === action.task.id ? action.task : t)),
      };
    case "TASK_REMOVED":
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.id),
      };
    case "TASKS_UPDATED": {
      const updatedMap = new Map(action.tasks.map((t) => [t.id, t]));
      return {
        ...state,
        tasks: state.tasks.map((t) => updatedMap.get(t.id) ?? t),
      };
    }
    case "TASKS_REMOVED": {
      const removedIds = new Set(action.ids);
      return {
        ...state,
        tasks: state.tasks.filter((t) => !removedIds.has(t.id)),
      };
    }
    default:
      return state;
  }
}

interface TaskContextValue {
  state: TaskState;
  createTask: (input: CreateTaskInput) => Promise<void>;
  updateTask: (id: string, input: UpdateTaskInput) => Promise<void>;
  completeTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  completeManyTasks: (ids: string[]) => Promise<void>;
  deleteManyTasks: (ids: string[]) => Promise<void>;
  updateManyTasks: (ids: string[], changes: UpdateTaskInput) => Promise<void>;
  refreshTasks: () => Promise<void>;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(taskReducer, {
    tasks: [],
    loading: true,
    error: null,
  });

  const refreshTasks = useCallback(async () => {
    dispatch({ type: "LOAD_START" });
    try {
      const tasks = await listTasks();
      dispatch({ type: "LOAD_SUCCESS", tasks });
    } catch (err) {
      dispatch({ type: "LOAD_ERROR", error: String(err) });
    }
  }, []);

  const createTask = useCallback(async (input: CreateTaskInput) => {
    try {
      const task = await createTaskApi(input);
      dispatch({ type: "TASK_ADDED", task });
    } catch (err) {
      dispatch({
        type: "LOAD_ERROR",
        error: `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  const updateTask = useCallback(async (id: string, input: UpdateTaskInput) => {
    try {
      const task = await updateTaskApi(id, input);
      dispatch({ type: "TASK_UPDATED", task });
    } catch (err) {
      dispatch({
        type: "LOAD_ERROR",
        error: `Failed to update task: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  const completeTask = useCallback(
    async (id: string) => {
      try {
        const task = await completeTaskApi(id);
        // If the task has recurrence, refresh to pick up the new occurrence
        if (task.recurrence) {
          await refreshTasks();
        } else {
          dispatch({ type: "TASK_UPDATED", task });
        }
      } catch (err) {
        dispatch({
          type: "LOAD_ERROR",
          error: `Failed to complete task: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [refreshTasks],
  );

  const deleteTask = useCallback(async (id: string) => {
    try {
      await deleteTaskApi(id);
      dispatch({ type: "TASK_REMOVED", id });
    } catch (err) {
      dispatch({
        type: "LOAD_ERROR",
        error: `Failed to delete task: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  const completeManyTasks = useCallback(
    async (ids: string[]) => {
      try {
        const tasks = await completeManyTasksApi(ids);
        // If any had recurrence, refresh all
        if (tasks.some((t) => t.recurrence)) {
          await refreshTasks();
        } else {
          dispatch({ type: "TASKS_UPDATED", tasks });
        }
      } catch (err) {
        dispatch({
          type: "LOAD_ERROR",
          error: `Failed to complete tasks: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [refreshTasks],
  );

  const deleteManyTasks = useCallback(async (ids: string[]) => {
    try {
      await deleteManyTasksApi(ids);
      dispatch({ type: "TASKS_REMOVED", ids });
    } catch (err) {
      dispatch({
        type: "LOAD_ERROR",
        error: `Failed to delete tasks: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  const updateManyTasks = useCallback(async (ids: string[], changes: UpdateTaskInput) => {
    try {
      const tasks = await updateManyTasksApi(ids, changes);
      dispatch({ type: "TASKS_UPDATED", tasks });
    } catch (err) {
      dispatch({
        type: "LOAD_ERROR",
        error: `Failed to update tasks: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);

  const contextValue = useMemo(
    () => ({
      state,
      createTask,
      updateTask,
      completeTask,
      deleteTask,
      completeManyTasks,
      deleteManyTasks,
      updateManyTasks,
      refreshTasks,
    }),
    [
      state,
      createTask,
      updateTask,
      completeTask,
      deleteTask,
      completeManyTasks,
      deleteManyTasks,
      updateManyTasks,
      refreshTasks,
    ],
  );

  return <TaskContext.Provider value={contextValue}>{children}</TaskContext.Provider>;
}

export function useTaskContext() {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error("useTaskContext must be used within TaskProvider");
  return ctx;
}
