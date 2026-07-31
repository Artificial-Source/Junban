/**
 * Motivation view loads server dopamine/frog/jar facts deterministically.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "../api/client";
import { DopamineMenu } from "./DopamineMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getDopamineMenu = vi.fn();
const getEatTheFrog = vi.fn();
const getTaskJar = vi.fn();
const getTemporalSettings = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getDopamineMenu: (...args: unknown[]) => getDopamineMenu(...args),
    getEatTheFrog: (...args: unknown[]) => getEatTheFrog(...args),
    getTaskJar: (...args: unknown[]) => getTaskJar(...args),
    getTemporalSettings: (...args: unknown[]) => getTemporalSettings(...args),
  };
});

vi.mock("../hooks/useToday", () => ({
  useToday: () => "2026-07-23",
}));

vi.mock("../components/TaskList", () => ({
  TaskList: ({ tasks }: { tasks: TaskDto[] }) =>
    createElement(
      "ul",
      null,
      tasks.map((task) => createElement("li", { key: task.id }, task.title)),
    ),
}));

const frog: TaskDto = {
  id: "frog-1",
  title: "Hardest task",
  description: "",
  someday: false,
  tag_ids: [],
  sort_order: 0,
  status: "pending",
  dread: 5,
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
  revision: 1,
};

const jar: TaskDto = {
  id: "jar-1",
  title: "Jar pick",
  description: "",
  someday: false,
  tag_ids: [],
  sort_order: 0,
  status: "pending",
  due_date: "2026-07-23",
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
  revision: 1,
};

const quick: TaskDto = {
  id: "quick-1",
  title: "Two minute win",
  description: "",
  someday: false,
  tag_ids: [],
  sort_order: 0,
  status: "pending",
  estimated_minutes: 5,
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
  revision: 1,
};

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement) {
  act(() => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getDopamineMenu.mockResolvedValue({
    revision: 1,
    task_ids: ["quick-1"],
    tasks: [quick],
  });
  getEatTheFrog.mockResolvedValue({ revision: 1, task: frog });
  getTaskJar.mockResolvedValue({ revision: 1, task_ids: ["jar-1"], tasks: [jar] });
  getTemporalSettings.mockResolvedValue({
    capacity_minutes: 480,
    eat_the_frog_enabled: true,
    task_jar_enabled: true,
    nudges_enabled: true,
    time_zone: "UTC",
    week_start: "sunday",
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe("DopamineMenu motivation", () => {
  it("renders server-ordered quick wins and deterministic frog/jar cards", async () => {
    await act(async () => {
      render(
        createElement(DopamineMenu, {
          onToggleTask: async () => true,
          onSelectTask: () => {},
          selectedTaskId: null,
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Two minute win");
    expect(container.textContent).toContain("Hardest task");
    expect(container.querySelector('[data-testid="task-jar-selection"]')?.textContent).toBe(
      "Jar pick",
    );
    expect(container.textContent).toContain("Task Jar · 2026-07-23");
  });

  it("hides frog and jar cards when temporal settings disable them", async () => {
    getTemporalSettings.mockResolvedValue({
      capacity_minutes: 480,
      eat_the_frog_enabled: false,
      task_jar_enabled: false,
      nudges_enabled: true,
      time_zone: "UTC",
      week_start: "sunday",
    });

    await act(async () => {
      render(
        createElement(DopamineMenu, {
          onToggleTask: async () => true,
          onSelectTask: () => {},
          selectedTaskId: null,
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Two minute win");
    expect(container.textContent).not.toContain("Hardest task");
    expect(container.querySelector('[data-testid="task-jar-selection"]')).toBeNull();
  });
});
