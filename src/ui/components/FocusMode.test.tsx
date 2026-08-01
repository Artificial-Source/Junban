/**
 * Focus Mode: all-pending navigation and query exit.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listTasks = vi.fn();
const completeTask = vi.fn();
const patchTask = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
  };
});

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    completeTask: (...args: unknown[]) => completeTask(...args),
    patchTask: (...args: unknown[]) => patchTask(...args),
  }),
}));

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    catalog: {
      projects: [],
      sections: [],
      tags: [],
      templates: [],
      saved_filters: [],
      revision: 1,
    },
    registerTaskEventHandler: () => () => undefined,
    registerTaskResyncHandler: () => () => undefined,
  }),
}));

import { FocusMode } from "./FocusMode";

function makeTask(id: string, title: string) {
  return {
    id,
    title,
    description: "",
    status: "pending" as const,
    project_id: null,
    tag_ids: [] as string[],
    someday: false,
    revision: 1,
    sort_order: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
}

function Host({
  startTaskId = null,
  onClose = () => undefined,
}: {
  startTaskId?: string | null;
  onClose?: () => void;
}): ReactElement {
  const [open, setOpen] = useState(true);
  return createElement(FocusMode, {
    open,
    startTaskId,
    onClose: () => {
      setOpen(false);
      onClose();
    },
  });
}

describe("FocusMode", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listTasks.mockReset();
    completeTask.mockReset();
    patchTask.mockReset();
    listTasks.mockResolvedValue({
      tasks: [makeTask("a", "Alpha"), makeTask("b", "Beta"), makeTask("c", "Gamma")],
      revision: 1,
      as_of_date: "2026-07-23",
      next_cursor: null,
    });
    completeTask.mockResolvedValue({ event: { revision: 2 } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads all pending tasks and starts on the requested task", async () => {
    await act(async () => {
      root.render(createElement(Host, { startTaskId: "b" }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", limit: 100 }),
    );
    expect(document.body.textContent).toContain("Beta");
    expect(document.body.textContent).toMatch(/2\/3/);
  });

  it("navigates previous/next across the full pending list", async () => {
    await act(async () => {
      root.render(createElement(Host, { startTaskId: "a" }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const skip = Array.from(document.querySelectorAll("button")).find((b) =>
      b.getAttribute("aria-label")?.includes("Skip"),
    );
    await act(async () => {
      skip!.click();
    });
    expect(document.body.textContent).toContain("Beta");

    const prev = Array.from(document.querySelectorAll("button")).find((b) =>
      b.getAttribute("aria-label")?.includes("Previous"),
    );
    await act(async () => {
      prev!.click();
    });
    expect(document.body.textContent).toContain("Alpha");
  });

  it("exits on Escape when no mutation is pending", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(createElement(Host, { onClose }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
