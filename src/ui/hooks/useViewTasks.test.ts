import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommittedEventDto, TaskDto, TaskListParams, TaskListResponse } from "../api/client";
import { useViewTasks } from "./useViewTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listTasks = vi.fn<(params?: TaskListParams) => Promise<TaskListResponse>>();
const hasStoredToken = vi.fn(() => true);

const taskEventHandlers = new Set<(event: CommittedEventDto) => void>();
const taskResyncHandlers = new Set<() => void>();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    listTasks: (params?: TaskListParams) => listTasks(params),
    hasStoredToken: () => hasStoredToken(),
  };
});

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    registerTaskEventHandler: (handler: (event: CommittedEventDto) => void) => {
      taskEventHandlers.add(handler);
      return () => {
        taskEventHandlers.delete(handler);
      };
    },
    registerTaskResyncHandler: (handler: () => void) => {
      taskResyncHandlers.add(handler);
      return () => {
        taskResyncHandlers.delete(handler);
      };
    },
  }),
}));

function makeTask(id: string, title: string): TaskDto {
  return {
    id,
    title,
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 1,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
  };
}

function page(tasks: TaskDto[], revision = 1): TaskListResponse {
  return {
    tasks,
    revision,
    as_of_date: "2026-07-23",
    next_cursor: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  taskEventHandlers.clear();
  taskResyncHandlers.clear();
  listTasks.mockReset();
  hasStoredToken.mockReturnValue(true);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("useViewTasks (P2-FE-003)", () => {
  it("resync after query change uses the current params, not the mount-time query", async () => {
    listTasks.mockImplementation(async (params) => {
      if (params?.project_id === "project-a") {
        return page([makeTask("a1", "A task")]);
      }
      if (params?.project_id === "project-b") {
        return page([makeTask("b1", "B task")]);
      }
      return page([]);
    });

    let latestTitles: string[] = [];

    function Harness() {
      const [projectId, setProjectId] = useState("project-a");
      const { tasks } = useViewTasks({ view: "project", project_id: projectId, limit: 100 });
      latestTitles = tasks.map((t) => t.title);

      useEffect(() => {
        (window as unknown as { __switchProject?: (id: string) => void }).__switchProject = (
          id: string,
        ) => setProjectId(id);
      }, []);

      return null;
    }

    await act(async () => {
      root.render(createElement(Harness));
    });
    // Flush initial load
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestTitles).toEqual(["A task"]);
    expect(listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ project_id: "project-a" }),
    );

    await act(async () => {
      (window as unknown as { __switchProject: (id: string) => void }).__switchProject("project-b");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestTitles).toEqual(["B task"]);

    const callsBeforeResync = listTasks.mock.calls.length;
    await act(async () => {
      for (const handler of taskResyncHandlers) handler();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks.mock.calls.length).toBeGreaterThan(callsBeforeResync);
    expect(listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ project_id: "project-b" }),
    );
    expect(latestTitles).toEqual(["B task"]);
  });
});
