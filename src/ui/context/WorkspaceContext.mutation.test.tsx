/**
 * P2-FE-009: own mutation responses fan through task handlers; outcome-unknown resyncs.
 */
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResponse, CommittedEventDto, MutationResponse, TaskDto } from "../api/client";
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
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getCatalog: () => getCatalog(),
    getSettings: () => getSettings(),
    hasStoredToken: () => hasStoredToken(),
    subscribeToEvents: () => () => {},
  };
});

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Created",
    description: "",
    status: "pending",
    someday: false,
    tag_ids: [],
    sort_order: 0,
    revision: 2,
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    ...overrides,
  };
}

function mutationWithTask(task: TaskDto, revision = 2): MutationResponse {
  return {
    event: {
      revision,
      operation_id: "op-own-1",
      event_type: "task.created",
      occurred_at: "2026-07-23T10:00:00Z",
      affected: { task_ids: [task.id] },
      resync: { tasks: false, catalog: false, settings: false },
      snapshot: { resource_type: "task", task },
      primary: { resource_type: "task", id: task.id },
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

describe("WorkspaceContext runMutation (P2-FE-009)", () => {
  it("fans successful own mutation events through task handlers without waiting for SSE", async () => {
    const seen: CommittedEventDto[] = [];
    let runMutation!: ReturnType<typeof useWorkspace>["runMutation"];

    function Probe() {
      const ws = useWorkspace();
      runMutation = ws.runMutation;
      useEffect(() => {
        return ws.registerTaskEventHandler((event) => {
          seen.push(event);
        });
      }, [ws]);
      return null;
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });

    const task = makeTask();
    let result: MutationResponse | null = null;
    await act(async () => {
      result = await runMutation(async () => mutationWithTask(task, 5));
    });

    expect(result).not.toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.revision).toBe(5);
    expect(seen[0]?.event_type).toBe("task.created");
  });

  it("on outcome-unknown performs one coalesced task + catalog resync and stays ambiguous", async () => {
    const taskResyncCalls: number[] = [];
    let catalogLoadsBefore = 0;
    let phase: string = "idle";
    let runMutation!: ReturnType<typeof useWorkspace>["runMutation"];

    function Probe() {
      const ws = useWorkspace();
      runMutation = ws.runMutation;
      phase = ws.mutationPhase;
      useEffect(() => {
        return ws.registerTaskResyncHandler(() => {
          taskResyncCalls.push(1);
        });
      }, [ws]);
      return createElement("span", { "data-phase": ws.mutationPhase }, ws.mutationPhase);
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });
    catalogLoadsBefore = getCatalog.mock.calls.length;

    await act(async () => {
      const result = await runMutation(async () => {
        throw new NetworkError("network dropped after send", true, false);
      });
      expect(result).toBeNull();
    });

    expect(taskResyncCalls.length).toBe(1);
    expect(getCatalog.mock.calls.length).toBeGreaterThan(catalogLoadsBefore);
    expect(phase).toBe("outcome-unknown");
    expect(container.textContent).toContain("outcome-unknown");
  });

  it("duplicate own-event delivery of the same revision is harmless", async () => {
    const titles: string[] = [];
    let applyCount = 0;
    let runMutation!: ReturnType<typeof useWorkspace>["runMutation"];

    function Probe() {
      const ws = useWorkspace();
      runMutation = ws.runMutation;
      const [label, setLabel] = useState("");
      useEffect(() => {
        return ws.registerTaskEventHandler((event) => {
          applyCount += 1;
          const task =
            event.snapshot && event.snapshot.resource_type === "task" ? event.snapshot.task : null;
          if (task) {
            setLabel(task.title);
            titles.push(task.title);
          }
        });
      }, [ws]);
      return createElement("span", null, label);
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });

    const task = makeTask({ title: "Once" });
    const response = mutationWithTask(task, 3);

    await act(async () => {
      await runMutation(async () => response);
    });
    // Second delivery of the same committed event (SSE replay after own fan-out).
    await act(async () => {
      await runMutation(async () => response);
    });

    expect(applyCount).toBeGreaterThanOrEqual(2);
    expect(titles.every((t) => t === "Once")).toBe(true);
  });
});
