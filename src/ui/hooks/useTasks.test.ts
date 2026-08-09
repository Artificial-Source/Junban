import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommittedEventDto,
  MutationResponse,
  SseEvent,
  TaskDto,
  TaskListResponse,
} from "../api/client";
import {
  nextStateFromListSnapshot,
  removeTaskById,
  upsertTaskById,
  useTasks,
  type TaskActions,
  type TaskState,
} from "./useTasks";
import { applyTaskEventToList } from "./useTaskQuery";
import { RefreshCoalescer } from "./liveQuery";
import { isOutcomeUnknown } from "./useMutations";
import { NetworkError } from "../api/client";

const listTasks = vi.fn<(params?: unknown) => Promise<TaskListResponse>>();
const createTaskApi = vi.fn<(body: unknown, operationId: string) => Promise<MutationResponse>>();
const patchTask = vi.fn();
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
  onResync?: (scope: { tasks: boolean; catalog: boolean }, reason: string) => void;
};

let subscribeArgs: SubscribeArgs | null = null;

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    listTasks: (...args: [unknown?]) => listTasks(...args),
    createTask: (body: unknown, operationId: string) => createTaskApi(body, operationId),
    patchTask: (...args: unknown[]) => patchTask(...args),
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
      onResync?: SubscribeArgs["onResync"],
    ) => {
      subscribeArgs = { onEvent, onReconnect, onTerminal, initialSince, onResync };
      return () => {
        subscribeArgs = null;
      };
    },
  };
});

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
    description: "",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    ...overrides,
  };
}

function makeEvent(
  task: TaskDto | null,
  revision: number,
  eventType: string,
  overrides: Partial<CommittedEventDto> = {},
): CommittedEventDto {
  return {
    event_type: eventType,
    occurred_at: "2026-07-28T00:00:00Z",
    operation_id: "op-test-1",
    revision,
    affected: task ? { task_ids: [task.id] } : {},
    resync: { tasks: false, catalog: false, settings: false },
    primary: task ? { resource_type: "task", id: task.id } : null,
    snapshot: task ? { resource_type: "task", task } : null,
    ...overrides,
  };
}

function makeMutation(
  task: TaskDto,
  revision: number,
  operationId = "op-test-1",
  eventType = "task.created",
): MutationResponse {
  return {
    event: makeEvent(task, revision, eventType, { operation_id: operationId }),
  };
}

describe("nextStateFromListSnapshot", () => {
  const older = {
    revision: 3,
    tasks: [makeTask({ id: "a", title: "older", revision: 3 })],
    as_of_date: "2026-07-28",
  };
  const newer = {
    revision: 5,
    tasks: [makeTask({ id: "b", title: "newer", revision: 5 })],
    as_of_date: "2026-07-28",
  };

  it("accepts a newer snapshot and rejects a later older completion", () => {
    const afterNewer = nextStateFromListSnapshot(0, newer);
    expect(afterNewer).toMatchObject({ revision: 5, tasks: newer.tasks });

    const afterOlder = nextStateFromListSnapshot(afterNewer!.revision, older);
    expect(afterOlder).toBeNull();
  });

  it("allows an equal revision snapshot to confirm the same head", () => {
    const confirmed = nextStateFromListSnapshot(5, newer);
    expect(confirmed).toMatchObject({ revision: 5 });
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

describe("RefreshCoalescer", () => {
  it("runs one trailing refresh after a burst", async () => {
    const coalescer = new RefreshCoalescer();
    let runs = 0;
    const first = deferred<void>();
    const second = deferred<void>();
    const barriers = [first, second];

    const kick = () =>
      coalescer.run(async () => {
        const barrier = barriers[runs];
        runs += 1;
        await barrier?.promise;
      });

    void kick();
    void kick();
    void kick();
    expect(runs).toBe(1);

    first.resolve();
    await vi.waitFor(() => expect(runs).toBe(2));
    second.resolve();
    await vi.waitFor(() => expect(coalescer.isInFlight).toBe(false));
    expect(runs).toBe(2);
  });
});

describe("applyTaskEventToList", () => {
  it("patches a visible single-resource snapshot and refreshes bulk/resync", () => {
    const task = makeTask({ id: "t1", title: "One", revision: 1 });
    const patched = applyTaskEventToList(
      [task],
      1,
      makeEvent({ ...task, estimated_minutes: 25, revision: 2 }, 2, "task.updated"),
    );
    expect(patched.needsRefresh).toBe(false);
    expect(patched.tasks[0]?.estimated_minutes).toBe(25);

    const bulk = applyTaskEventToList(
      [task],
      2,
      makeEvent(null, 3, "task.bulk", { resync: { tasks: true, catalog: false, settings: false } }),
    );
    expect(bulk.needsRefresh).toBe(true);
  });
});

describe("isOutcomeUnknown", () => {
  it("marks retryable network failures as outcome-unknown", () => {
    expect(isOutcomeUnknown(new NetworkError("boom", true))).toBe(true);
    expect(isOutcomeUnknown(new NetworkError("aborted", false, true))).toBe(false);
    expect(isOutcomeUnknown(new Error("nope"))).toBe(false);
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
    patchTask.mockReset();
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

    await act(async () => {
      initialList.resolve({
        revision: 4,
        as_of_date: "2026-07-28",
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
    listTasks.mockResolvedValueOnce({ revision: 0, tasks: [], as_of_date: "2026-07-28" });

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

    listTasks.mockResolvedValueOnce({ revision: 1, tasks: [task], as_of_date: "2026-07-28" });
    await act(async () => {
      subscribeArgs!.onEvent({
        id: "1",
        event: "revision",
        data: makeEvent(task, 1, "task.created"),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.revision).toBe(1);
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.id).toBe("created-1");

    await act(async () => {
      mutation.resolve(makeMutation(task, 1));
      await createPromise!;
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
    expect(listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ revision: 1, tasks: [], as_of_date: "2026-07-28" });
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        revision: 2,
        as_of_date: "2026-07-28",
        tasks: [makeTask({ id: "t2", title: "Two", revision: 2 })],
      });
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
        as_of_date: "2026-07-28",
        tasks: [makeTask({ id: "recovered", title: "Recovered", revision: 3 })],
      });

    mount();
    await flush();

    await act(async () => {
      subscribeArgs!.onReconnect();
      await Promise.resolve();
    });

    await act(async () => {
      first.resolve({ revision: 0, tasks: [], as_of_date: "2026-07-28" });
      await first.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.error).toBe("list failed");

    await act(async () => {
      subscribeArgs!.onReconnect();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.error).toBeNull();
    expect(latest?.revision).toBe(3);
    expect(latest?.tasks.map((task) => task.id)).toEqual(["recovered"]);
  });

  it("refreshes after outcome-unknown mutation failures", async () => {
    listTasks.mockResolvedValue({ revision: 1, tasks: [], as_of_date: "2026-07-28" });
    mount();
    await flush();
    const callsAfterMount = listTasks.mock.calls.length;

    createTaskApi.mockRejectedValueOnce(new NetworkError("connection lost", true));

    await act(async () => {
      const created = await latest!.createTask("Maybe", null);
      expect(created).toBeNull();
    });

    expect(latest?.mutationPhase).toBe("outcome-unknown");
    expect(listTasks.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("requests a resync when SSE reports unknown/bulk scopes", async () => {
    listTasks.mockResolvedValue({ revision: 1, tasks: [], as_of_date: "2026-07-28" });
    mount();
    await flush();
    const before = listTasks.mock.calls.length;

    await act(async () => {
      subscribeArgs!.onResync?.({ tasks: true, catalog: false }, "unknown_event_type");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks.mock.calls.length).toBeGreaterThan(before);
  });

  it("loads only a bounded first page", async () => {
    listTasks.mockResolvedValue({ revision: 0, tasks: [], as_of_date: "2026-07-28" });
    mount();
    await flush();
    expect(listTasks).toHaveBeenCalledWith({ limit: 100 });
  });
});
