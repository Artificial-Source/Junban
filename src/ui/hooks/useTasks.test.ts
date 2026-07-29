import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationResponse, SseEvent, TaskDto, TaskListResponse } from "../api/client";
import {
  nextStateFromListSnapshot,
  removeTaskById,
  upsertTaskById,
  useTasks,
  type TaskActions,
  type TaskState,
} from "./useTasks";

const listTasks = vi.fn<() => Promise<TaskListResponse>>();
const createTaskApi = vi.fn<(body: unknown, operationId: string) => Promise<MutationResponse>>();
const replaceTask = vi.fn();
const completeTask = vi.fn();
const uncompleteTask = vi.fn();
const deleteTaskApi = vi.fn();
const generateOperationId = vi.fn(() => "op-test-1");
const hasStoredToken = vi.fn(() => true);

type SubscribeArgs = {
  onEvent: (event: SseEvent) => void;
  onReconnect: () => void;
  onTerminal: (error: { kind: "authentication" | "protocol"; message: string }) => void;
  initialSince: number;
};

let subscribeArgs: SubscribeArgs | null = null;

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ApiError";
    }
  },
  listTasks: (...args: []) => listTasks(...args),
  createTask: (body: unknown, operationId: string) => createTaskApi(body, operationId),
  replaceTask: (...args: unknown[]) => replaceTask(...args),
  completeTask: (...args: unknown[]) => completeTask(...args),
  uncompleteTask: (...args: unknown[]) => uncompleteTask(...args),
  deleteTask: (...args: unknown[]) => deleteTaskApi(...args),
  generateOperationId: () => generateOperationId(),
  hasStoredToken: () => hasStoredToken(),
  subscribeToEvents: (
    onEvent: SubscribeArgs["onEvent"],
    onReconnect: SubscribeArgs["onReconnect"],
    onTerminal: SubscribeArgs["onTerminal"],
    initialSince = 0,
  ) => {
    subscribeArgs = { onEvent, onReconnect, onTerminal, initialSince };
    return () => {
      subscribeArgs = null;
    };
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTask(overrides: Partial<TaskDto> & Pick<TaskDto, "id" | "title">): TaskDto {
  return {
    created_at: "2026-07-28T00:00:00Z",
    updated_at: "2026-07-28T00:00:00Z",
    status: "pending",
    revision: 1,
    due_date: null,
    completed_at: null,
    ...overrides,
  };
}

function makeMutation(
  task: TaskDto,
  revision: number,
  operationId = "op-test-1",
): MutationResponse {
  return {
    task,
    event: {
      event_type: "task.created",
      occurred_at: "2026-07-28T00:00:00Z",
      operation_id: operationId,
      revision,
      task,
      task_id: task.id,
    },
  };
}

describe("nextStateFromListSnapshot", () => {
  const older = {
    revision: 3,
    tasks: [makeTask({ id: "a", title: "older", revision: 3 })],
  };
  const newer = {
    revision: 5,
    tasks: [makeTask({ id: "b", title: "newer", revision: 5 })],
  };

  it("accepts a newer snapshot and rejects a later older completion", () => {
    // Reverse completion order: newer snapshot first, then older.
    const afterNewer = nextStateFromListSnapshot(0, newer);
    expect(afterNewer).toEqual(newer);

    const afterOlder = nextStateFromListSnapshot(afterNewer!.revision, older);
    expect(afterOlder).toBeNull();
  });

  it("allows an equal revision snapshot to confirm the same head", () => {
    const confirmed = nextStateFromListSnapshot(5, newer);
    expect(confirmed).toEqual(newer);
  });
});

describe("upsertTaskById / removeTaskById", () => {
  it("keeps a single task when the same id is delivered twice", () => {
    const task = makeTask({ id: "t1", title: "One", revision: 1 });
    const once = upsertTaskById([], task);
    const twice = upsertTaskById(once, { ...task, title: "One", revision: 1 });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.id).toBe("t1");
  });

  it("replaces fields for an existing id and removes by id idempotently", () => {
    const original = makeTask({ id: "t1", title: "Old", revision: 1 });
    const updated = makeTask({ id: "t1", title: "New", revision: 2 });
    const list = upsertTaskById([original], updated);
    expect(list).toEqual([updated]);
    expect(removeTaskById(list, "t1")).toEqual([]);
    expect(removeTaskById(list, "missing")).toEqual(list);
  });
});

type HookValue = TaskState & TaskActions;

describe("useTasks convergence", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HookValue | null;

  function HookProbe({ onChange }: { onChange: (value: HookValue) => void }) {
    const value = useTasks();
    useEffect(() => {
      onChange(value);
    }, [onChange, value]);
    return null;
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function mount() {
    act(() => {
      root.render(
        createElement(HookProbe, {
          onChange: (value: HookValue) => {
            latest = value;
          },
        }),
      );
    });
  }

  beforeEach(() => {
    latest = null;
    subscribeArgs = null;
    listTasks.mockReset();
    createTaskApi.mockReset();
    replaceTask.mockReset();
    completeTask.mockReset();
    uncompleteTask.mockReset();
    deleteTaskApi.mockReset();
    generateOperationId.mockClear();
    hasStoredToken.mockReturnValue(true);

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not let an older list response overwrite a newer applied revision", async () => {
    const initialList = deferred<TaskListResponse>();
    listTasks.mockReturnValueOnce(initialList.promise);

    mount();
    await flush();
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(latest?.loading).toBe(true);

    const newerTask = makeTask({ id: "new", title: "From mutation", revision: 6 });
    createTaskApi.mockResolvedValueOnce(makeMutation(newerTask, 6));

    let createdId: string | undefined;
    await act(async () => {
      const created = await latest!.createTask("From mutation", null);
      createdId = created?.id;
    });
    expect(createdId).toBe("new");
    expect(latest?.revision).toBe(6);
    expect(latest?.tasks.map((task) => task.id)).toEqual(["new"]);

    // Older list response completes after the newer mutation head is applied.
    await act(async () => {
      initialList.resolve({
        revision: 4,
        tasks: [makeTask({ id: "stale", title: "Stale snapshot", revision: 4 })],
      });
      await initialList.promise;
      await Promise.resolve();
    });

    expect(latest?.revision).toBe(6);
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.id).toBe("new");
    expect(latest?.tasks[0]?.title).toBe("From mutation");
    expect(latest?.loading).toBe(false);
  });

  it("keeps one task when own-create SSE/list lands before the mutation response", async () => {
    listTasks.mockResolvedValueOnce({ revision: 0, tasks: [] });

    mount();
    await flush();
    expect(latest?.loading).toBe(false);
    expect(latest?.tasks).toEqual([]);
    expect(subscribeArgs).not.toBeNull();

    const task = makeTask({ id: "created-1", title: "Solo", revision: 1 });
    const mutation = deferred<MutationResponse>();
    createTaskApi.mockReturnValueOnce(mutation.promise);

    let createPromise: Promise<TaskDto | null>;
    await act(async () => {
      createPromise = latest!.createTask("Solo", null);
    });

    // Own-create SSE arrives first and the list reload already contains the task.
    listTasks.mockResolvedValueOnce({ revision: 1, tasks: [task] });
    await act(async () => {
      subscribeArgs!.onEvent({
        id: "1",
        event: "task",
        data: {
          event_type: "task.created",
          occurred_at: "2026-07-28T00:00:01Z",
          operation_id: "op-test-1",
          revision: 1,
          task,
          task_id: task.id,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.revision).toBe(1);
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.id).toBe("created-1");

    // Mutation response arrives second with the same task id.
    await act(async () => {
      mutation.resolve(makeMutation(task, 1));
      await createPromise;
      await Promise.resolve();
    });

    expect(latest?.revision).toBe(1);
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.id).toBe("created-1");
    expect(latest?.tasks[0]?.title).toBe("Solo");
  });

  it("coalesces concurrent reloads into one follow-up fetch", async () => {
    const first = deferred<TaskListResponse>();
    const second = deferred<TaskListResponse>();
    listTasks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    mount();
    await flush();
    expect(listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest!.retry();
      latest!.retry();
      await Promise.resolve();
    });
    // Still only the original in-flight fetch; follow-up is queued once.
    expect(listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ revision: 1, tasks: [] });
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ revision: 2, tasks: [makeTask({ id: "t2", title: "Two", revision: 2 })] });
      await second.promise;
      await Promise.resolve();
    });

    expect(latest?.revision).toBe(2);
    expect(latest?.tasks.map((task) => task.id)).toEqual(["t2"]);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("surfaces list reload errors without dropping a queued catch-up reload", async () => {
    const first = deferred<TaskListResponse>();
    listTasks
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("list failed"))
      .mockResolvedValueOnce({
        revision: 3,
        tasks: [makeTask({ id: "recovered", title: "Recovered", revision: 3 })],
      });

    mount();
    await flush();

    await act(async () => {
      subscribeArgs!.onReconnect();
      await Promise.resolve();
    });

    await act(async () => {
      first.resolve({ revision: 0, tasks: [] });
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Failed follow-up is visible...
    expect(latest?.error).toBe("list failed");

    // ...and a subsequent reconnect still catch-up reloads successfully.
    await act(async () => {
      subscribeArgs!.onReconnect();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.error).toBeNull();
    expect(latest?.revision).toBe(3);
    expect(latest?.tasks.map((task) => task.id)).toEqual(["recovered"]);
  });
});
