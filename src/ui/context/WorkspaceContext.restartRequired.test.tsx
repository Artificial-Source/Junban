/**
 * After restore cutover confirms restart_required, terminal SSE errors must not
 * surface a contradictory retry banner while DataTab shows restart status.
 *
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResponse } from "../api/client";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TerminalHandler = (error: Error) => void;

let terminalErrorHandler: TerminalHandler | null = null;
const subscribeToEventsMock = vi.fn(
  (
    _onEvent: unknown,
    _onReconnect: unknown,
    onTerminalError: TerminalHandler,
    _revision: unknown,
    _onResync: unknown,
  ) => {
    terminalErrorHandler = onTerminalError;
    return () => {
      terminalErrorHandler = null;
    };
  },
);

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
    subscribeToEvents: (
      onEvent: unknown,
      onReconnect: unknown,
      onTerminalError: TerminalHandler,
      revision: unknown,
      onResync: unknown,
    ) => subscribeToEventsMock(onEvent, onReconnect, onTerminalError, revision, onResync),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getCatalog.mockClear();
  getSettings.mockClear();
  subscribeToEventsMock.mockClear();
  terminalErrorHandler = null;
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

describe("WorkspaceContext enterRestartRequired", () => {
  it("records ordinary terminal SSE errors before restart-required", async () => {
    let sseError: string | null = "unset";

    function Probe() {
      const ws = useWorkspace();
      useEffect(() => {
        sseError = ws.sseError;
      }, [ws.sseError]);
      return createElement("span", null, ws.sseError ?? "");
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });

    expect(terminalErrorHandler).not.toBeNull();
    act(() => {
      terminalErrorHandler?.(new Error("Event stream returned an invalid response. Retry"));
    });

    expect(container.textContent).toContain("Event stream returned an invalid response");
    expect(sseError).toContain("Event stream returned an invalid response");
  });

  it("clears sseError, disables the subscription, and ignores later terminal errors", async () => {
    let sseError: string | null = "unset";
    let enterRestartRequired!: () => void;

    function Probe() {
      const ws = useWorkspace();
      enterRestartRequired = ws.enterRestartRequired;
      useEffect(() => {
        sseError = ws.sseError;
      }, [ws.sseError]);
      return createElement("span", null, ws.sseError ?? "none");
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeToEventsMock).toHaveBeenCalledTimes(1);
    expect(terminalErrorHandler).not.toBeNull();

    // Seed an existing banner so enterRestartRequired must clear it.
    act(() => {
      terminalErrorHandler?.(new Error("Event stream returned an invalid response. Retry"));
    });
    expect(sseError).toContain("Event stream returned an invalid response");

    const handlerBefore = terminalErrorHandler;
    act(() => {
      enterRestartRequired();
    });

    // State clears immediately; subscription effect tears down on restartRequired.
    expect(sseError).toBeNull();
    expect(container.textContent).toBe("none");

    await act(async () => {
      await Promise.resolve();
    });

    // Cleanup nulls the captured handler; a stale in-flight callback still must no-op.
    expect(terminalErrorHandler).toBeNull();
    act(() => {
      handlerBefore?.(new Error("Event stream returned an invalid response. Retry"));
    });
    expect(sseError).toBeNull();
    expect(container.textContent).toBe("none");

    // No reconnect/resubscribe after restart-required cutover.
    expect(subscribeToEventsMock).toHaveBeenCalledTimes(1);
  });
});
