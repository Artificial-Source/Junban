/**
 * Wave 4a: thin AppLayout ownership of the lazy /ai-chat route seam.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./AppLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaceMock = {
  catalog: {
    projects: [],
    sections: [],
    tags: [],
    templates: [],
    saved_filters: [],
    revision: 1,
  },
  catalogLoading: false,
  refreshCatalog: vi.fn(),
  toasts: [],
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  sseError: null,
  registerTaskEventHandler: () => () => {},
  settings: {
    appearance: {
      theme: "light" as const,
      accent: "#3b82f6",
      density: "comfortable" as const,
      font_size: "medium" as const,
      font_family: "outfit" as const,
      reduced_motion: false,
    },
    features: {
      nudges_enabled: true,
      eat_the_frog_enabled: false,
      task_jar_enabled: false,
      focus_mode_enabled: false,
      daily_planning_enabled: true,
      weekly_review_enabled: true,
    },
    notifications: {
      channels: ["in_app" as const],
      sound_enabled: false,
      volume_percent: 70,
      task_completed_sound: true,
      task_created_sound: true,
      task_deleted_sound: true,
      reminder_sound: true,
    },
    task_defaults: {
      default_priority: null,
      default_view: "today" as const,
      default_estimated_minutes: null,
      confirm_before_delete: true,
    },
    keyboard_shortcuts: [],
  },
};

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => workspaceMock,
}));

vi.mock("../hooks/useTaskMutations", () => ({
  useTaskMutations: () => ({
    completeTask: vi.fn(),
    uncompleteTask: vi.fn(),
    bulkTasks: vi.fn(),
  }),
}));

vi.mock("../hooks/useSmartNudges", () => ({
  useSmartNudges: () => undefined,
}));

vi.mock("../hooks/useReminderDelivery", () => ({
  useReminderDelivery: () => undefined,
}));

vi.mock("../hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: () => ({ chord: null }),
  ChordIndicator: () => null,
  formatShortcutBinding: (value: string) => value,
  shortcutBindingFor: (_shortcuts: unknown, _action: string, fallback: string) => fallback,
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getTask: vi.fn(),
    hasStoredToken: () => false,
  };
});

vi.mock("../ai/transport", async () => {
  const actual = await vi.importActual<typeof import("../ai/transport")>("../ai/transport");
  return {
    ...actual,
    getAiConfig: vi.fn(async () => ({
      ai: {
        enabled: false,
        provider: null,
        model: null,
        custom_instructions: "",
        daily_briefing_enabled: false,
        smart_endpoint: false,
        auto_send: false,
      },
      voice: {
        voice_mode: "push_to_talk",
        grace_period_ms: 500,
        cloud_speech_enabled: false,
        stt_provider: "browser",
        tts_enabled: false,
        tts_provider: "browser",
      },
      credentials: {},
    })),
  };
});

vi.mock("../lib/sounds", () => ({
  playSound: vi.fn(),
}));

async function waitForText(container: HTMLElement, text: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for text: ${text}\nGot: ${container.textContent}`);
}

describe("AppLayout ai-chat route seam", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    // Main content uses flex height; give the mount a box so h-full shells resolve.
    container.style.height = "720px";
    document.body.append(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/ai-chat");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  });

  it("lazy-renders the AI not-configured shell for a direct /ai-chat load", async () => {
    // Warm the lazy module so Suspense can resolve under act without a flaky race.
    await import("../ai/AIChatRoute");

    await act(async () => {
      root.render(createElement(AppLayout));
    });

    await waitForText(container, "AI Assistant");
    expect(container.textContent).toContain(
      "Configure an AI provider in Settings to start chatting.",
    );

    const aiNav = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI Chat"),
    );
    expect(aiNav?.getAttribute("aria-current")).toBe("page");
  });
});
