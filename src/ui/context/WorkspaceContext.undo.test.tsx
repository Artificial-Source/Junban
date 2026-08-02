/**
 * P2-FINAL-002 / P2-FINAL-003: toast-targeted undo and session redo.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResponse, MutationResponse, TaskDto } from "../api/client";
import { NetworkError } from "../api/client";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getCatalog = vi.fn(async (): Promise<CatalogResponse> => ({
  projects: [],
  sections: [],
  tags: [],
  templates: [],
  saved_filters: [],
  revision: 1,
}));
const getSettings = vi.fn(async () => ({
  appearance: {
    theme: "dark" as const,
    accent: "#3b82f6",
    density: "comfortable" as const,
    font_size: "medium" as const,
    font_family: "outfit" as const,
    reduced_motion: false,
  },
  date_time: {
    week_start: "sunday" as const,
    calendar_default: "week" as const,
    date_format: "iso" as const,
    time_format: "h24" as const,
  },
  task_defaults: {
    default_priority: null,
    default_view: "today" as const,
    default_estimated_minutes: null,
    confirm_before_delete: true,
  },
  notifications: {
    channels: ["in_app" as const],
    sound_enabled: true,
    volume_percent: 70,
    task_completed_sound: true,
    task_created_sound: true,
    task_deleted_sound: true,
    reminder_sound: true,
  },
  features: {
    nudges_enabled: true,
    eat_the_frog_enabled: false,
    task_jar_enabled: false,
    focus_mode_enabled: true,
    daily_planning_enabled: true,
    weekly_review_enabled: true,
  },
  planning: { capacity_minutes: 480, work_hours: null, nudge_rules: [] },
  keyboard_shortcuts: [],
}));
const hasStoredToken = vi.fn(() => true);
const undoOperationApi = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getCatalog: () => getCatalog(),
    getSettings: () => getSettings(),
    hasStoredToken: () => hasStoredToken(),
    subscribeToEvents: () => () => {},
    undoOperation: (sourceOperationId: string, operationId: string) =>
      undoOperationApi(sourceOperationId, operationId),
  };
});

function makeTask(id: string, title: string, revision: number): TaskDto {
  return {
    id,
    title,
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  };
}

function mutationResponse(
  operationId: string,
  task: TaskDto,
  revision: number,
  eventType = "task.updated",
): MutationResponse {
  return {
    event: {
      revision,
      operation_id: operationId,
      event_type: eventType,
      occurred_at: "2026-07-23T10:00:00Z",
      affected: { task_ids: [task.id] },
      resync: { tasks: false, catalog: false, settings: false },
      snapshot: { resource_type: "task", task },
      primary: { resource_type: "task", id: task.id },
    },
  };
}

function undoResponse(
  sourceOperationId: string,
  compensatingOperationId: string,
  revision: number,
): MutationResponse {
  return {
    event: {
      revision,
      operation_id: compensatingOperationId,
      event_type: "operation.undone",
      occurred_at: "2026-07-23T10:01:00Z",
      affected: { task_ids: [] },
      resync: { tasks: true, catalog: false, settings: false },
      primary: { resource_type: "operation", id: sourceOperationId },
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getCatalog.mockClear();
  getSettings.mockClear();
  hasStoredToken.mockReturnValue(true);
  undoOperationApi.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(ui: ReactNode) {
  act(() => {
    root.render(createElement(WorkspaceProvider, null, ui));
  });
}

type WorkspaceApi = ReturnType<typeof useWorkspace>;

function captureWorkspace(): { current: WorkspaceApi | null } {
  const holder: { current: WorkspaceApi | null } = { current: null };
  function Probe() {
    holder.current = useWorkspace();
    return null;
  }
  mount(createElement(Probe));
  return holder;
}

describe("WorkspaceContext undo/redo (P2-FINAL-002, P2-FINAL-003)", () => {
  it("toast Undo for the older of two operations undoes that exact source, not the newest", async () => {
    const ws = captureWorkspace();
    await act(async () => {
      await Promise.resolve();
    });

    const olderOp = "op-older-1111-4111-8111-111111111111";
    const newerOp = "op-newer-2222-4222-8222-222222222222";
    const undoOfOlder = "op-undo-older-3333-4333-8333-333333333333";

    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(
            olderOp,
            makeTask("11111111-1111-4111-8111-111111111111", "Older", 2),
            2,
          ),
        { undoLabel: "Edit older", successToast: "Older saved" },
      );
    });
    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(
            newerOp,
            makeTask("22222222-2222-4222-8222-222222222222", "Newer", 3),
            3,
          ),
        { undoLabel: "Edit newer", successToast: "Newer saved" },
      );
    });

    expect(ws.current!.undoStack.map((e) => e.operationId)).toEqual([newerOp, olderOp]);

    undoOperationApi.mockResolvedValueOnce(undoResponse(olderOp, undoOfOlder, 4));

    await act(async () => {
      // Mimic ToastContainer: pass the older toast's operation id.
      await ws.current!.undo(olderOp);
    });

    expect(undoOperationApi).toHaveBeenCalledTimes(1);
    expect(undoOperationApi.mock.calls[0]?.[0]).toBe(olderOp);
    // Newest remains undoable; older is removed exactly.
    expect(ws.current!.undoStack.map((e) => e.operationId)).toEqual([newerOp]);
    expect(ws.current!.redoStack.map((e) => e.operationId)).toEqual([undoOfOlder]);
    expect(ws.current!.redoStack[0]?.label).toBe("Edit older");
  });

  it("keyboard undo then redo round-trips authority via compensating receipts", async () => {
    const ws = captureWorkspace();
    await act(async () => {
      await Promise.resolve();
    });

    const sourceOp = "op-source-1111-4111-8111-111111111111";
    const undoCompensating = "op-undo-comp-2222-4222-8222-222222222222";
    const redoCompensating = "op-redo-comp-3333-4333-8333-333333333333";

    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(
            sourceOp,
            makeTask("11111111-1111-4111-8111-111111111111", "Task", 2),
            2,
          ),
        { undoLabel: "Complete task", successToast: "Completed" },
      );
    });

    expect(ws.current!.canUndo).toBe(true);
    expect(ws.current!.canRedo).toBe(false);

    undoOperationApi.mockResolvedValueOnce(undoResponse(sourceOp, undoCompensating, 3));

    await act(async () => {
      // Keyboard / palette path: no operation id → latest.
      await ws.current!.undo();
    });

    expect(undoOperationApi).toHaveBeenCalledTimes(1);
    expect(undoOperationApi.mock.calls[0]?.[0]).toBe(sourceOp);
    expect(ws.current!.canUndo).toBe(false);
    expect(ws.current!.canRedo).toBe(true);
    expect(ws.current!.redoStack).toEqual([
      { operationId: undoCompensating, label: "Complete task" },
    ]);

    undoOperationApi.mockResolvedValueOnce(undoResponse(undoCompensating, redoCompensating, 4));

    await act(async () => {
      await ws.current!.redo();
    });

    expect(undoOperationApi).toHaveBeenCalledTimes(2);
    expect(undoOperationApi.mock.calls[1]?.[0]).toBe(undoCompensating);
    expect(ws.current!.canRedo).toBe(false);
    expect(ws.current!.canUndo).toBe(true);
    // Redo success returns the action to undo authority under the new receipt.
    expect(ws.current!.undoStack).toEqual([
      { operationId: redoCompensating, label: "Complete task" },
    ]);
  });

  it("a non-undo mutation leaves an earlier valid task undo available", async () => {
    const ws = captureWorkspace();
    await act(async () => {
      await Promise.resolve();
    });

    const taskOp = "op-task-1111-4111-8111-111111111111";
    const timeblockOp = "op-timeblock-2222-4222-8222-222222222222";
    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(taskOp, makeTask("11111111-1111-4111-8111-111111111111", "Task", 2), 2),
        { undoLabel: "Complete task", successToast: "Completed" },
      );
      await ws.current!.runMutation(
        async () =>
          mutationResponse(
            timeblockOp,
            makeTask("11111111-1111-4111-8111-111111111111", "Task", 3),
            3,
          ),
        { successToast: "Delete time block" },
      );
    });

    expect(ws.current!.undoStack).toEqual([{ operationId: taskOp, label: "Complete task" }]);
    expect(ws.current!.canUndo).toBe(true);
  });

  it("clears the redo stack after a new user mutation", async () => {
    const ws = captureWorkspace();
    await act(async () => {
      await Promise.resolve();
    });

    const firstOp = "op-first-1111-4111-8111-111111111111";
    const undoComp = "op-undo-2222-4222-8222-222222222222";
    const secondOp = "op-second-3333-4333-8333-333333333333";

    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(firstOp, makeTask("11111111-1111-4111-8111-111111111111", "A", 2), 2),
        { undoLabel: "Edit A" },
      );
    });

    undoOperationApi.mockResolvedValueOnce(undoResponse(firstOp, undoComp, 3));
    await act(async () => {
      await ws.current!.undo();
    });
    expect(ws.current!.canRedo).toBe(true);

    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(secondOp, makeTask("22222222-2222-4222-8222-222222222222", "B", 4), 4),
        { undoLabel: "Edit B" },
      );
    });

    expect(ws.current!.canRedo).toBe(false);
    expect(ws.current!.redoStack).toEqual([]);
    expect(ws.current!.undoStack.map((e) => e.operationId)).toEqual([secondOp]);
  });

  it("does not mutate undo/redo stacks on outcome-unknown undo", async () => {
    const ws = captureWorkspace();
    await act(async () => {
      await Promise.resolve();
    });

    const sourceOp = "op-source-1111-4111-8111-111111111111";
    await act(async () => {
      await ws.current!.runMutation(
        async () =>
          mutationResponse(sourceOp, makeTask("11111111-1111-4111-8111-111111111111", "A", 2), 2),
        { undoLabel: "Edit A" },
      );
    });

    undoOperationApi.mockRejectedValueOnce(new NetworkError("dropped after send", true, false));

    await act(async () => {
      await ws.current!.undo();
    });

    expect(ws.current!.undoStack).toEqual([{ operationId: sourceOp, label: "Edit A" }]);
    expect(ws.current!.redoStack).toEqual([]);
    expect(ws.current!.mutationPhase).toBe("outcome-unknown");
  });
});
