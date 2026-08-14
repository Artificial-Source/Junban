/**
 * @vitest-environment jsdom
 */
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_EVENT_TYPES, type CommittedEventDto } from "../api/client";
import {
  fixtureInstalledPlugins,
  fixturePomodoroSettingValues,
  POMODORO_SETTINGS,
} from "./phase7/fixtureData";
import type { CommunityPolicy, InstalledPlugin, PluginPermission } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listPlugins = vi.fn<(...args: unknown[]) => Promise<InstalledPlugin[]>>();
const getCommunityPolicy = vi.fn<(...args: unknown[]) => Promise<CommunityPolicy>>();
const replaceGrants = vi.fn();
const enablePlugin = vi.fn();
const disablePlugin = vi.fn();
const uninstallPlugin = vi.fn();
const eventHandlers = new Set<(event: CommittedEventDto) => void>();
const registerTaskEventHandler = vi.fn((handler: (event: CommittedEventDto) => void) => {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
});

vi.mock("./transport", async () => {
  const actual = await vi.importActual<typeof import("./transport")>("./transport");
  return {
    ...actual,
    listPlugins: (...args: unknown[]) => listPlugins(...args),
    getCommunityPolicy: (...args: unknown[]) => getCommunityPolicy(...args),
    replaceGrants: (...args: unknown[]) => replaceGrants(...args),
    enablePlugin: (...args: unknown[]) => enablePlugin(...args),
    disablePlugin: (...args: unknown[]) => disablePlugin(...args),
    uninstallPlugin: (...args: unknown[]) => uninstallPlugin(...args),
  };
});

vi.mock("../context/WorkspaceContext", () => ({
  useWorkspace: () => ({
    registerTaskEventHandler: (handler: (event: CommittedEventDto) => void) =>
      registerTaskEventHandler(handler),
  }),
}));

import { PluginsTab, type PluginsTabProps } from "./PluginsTab";

const Tab = PluginsTab as FunctionComponent<PluginsTabProps>;

function renderTab(root: Root, props: PluginsTabProps = {}) {
  act(() => {
    root.render(createElement(Tab, props));
  });
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${text} button`);
  return button;
}

function committedEvent(eventType: string): CommittedEventDto {
  return {
    event_type: eventType,
    revision: 1,
    operation_id: "00000000-0000-4000-8000-000000000001",
    occurred_at: "2026-08-04T15:00:00.000Z",
    affected: { task_ids: [] },
    resync: { tasks: false, catalog: false, settings: false },
  };
}

describe("PluginsTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listPlugins.mockReset();
    getCommunityPolicy.mockReset();
    replaceGrants.mockReset();
    enablePlugin.mockReset();
    disablePlugin.mockReset();
    uninstallPlugin.mockReset();
    registerTaskEventHandler.mockClear();
    eventHandlers.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders Restricted Mode and built-in list from fixture", () => {
    renderTab(root, {
      fixture: {
        plugins: fixtureInstalledPlugins(),
        communityEnabled: false,
        loadMode: "ready",
      },
    });
    expect(container.textContent).toContain("Restricted Mode is ON");
    expect(container.textContent).toContain("Built-in Extensions");
    expect(container.textContent).toContain("Pomodoro Timer");
    expect(container.textContent).toContain("Browse Community Plugins");
  });

  it("opens safety confirmation when turning off Restricted Mode", () => {
    renderTab(root, {
      fixture: {
        plugins: fixtureInstalledPlugins(),
        communityEnabled: false,
        loadMode: "ready",
        openSafetyDialog: true,
      },
    });
    expect(container.textContent).toContain("Enable community plugins?");
    expect(container.textContent).toContain("Keep Restricted");
    expect(container.textContent).toContain("I understand, enable");
  });

  it("shows permission dialog for Focus Helper fixture", () => {
    renderTab(root, {
      fixture: {
        plugins: fixtureInstalledPlugins(),
        communityEnabled: false,
        loadMode: "ready",
        openPermissionPluginId: "focus-helper",
      },
    });
    expect(container.textContent).toContain("Plugin Permissions");
    expect(container.textContent).toContain("Focus Helper");
    expect(container.textContent).toContain("task:read");
  });

  it("expands Pomodoro typed settings from installed plugin declarations", () => {
    const plugins = fixtureInstalledPlugins().map((plugin) =>
      plugin.pluginId === "pomodoro"
        ? { ...plugin, settingDeclarations: POMODORO_SETTINGS }
        : plugin,
    );
    renderTab(root, {
      fixture: {
        plugins,
        communityEnabled: false,
        loadMode: "ready",
        expandedPluginId: "pomodoro",
        settingValues: { pomodoro: fixturePomodoroSettingValues() },
      },
    });
    expect(container.textContent).toContain("Work Duration");
    expect(container.textContent).toContain("Break Duration");
    expect(container.textContent).toContain("Sessions Before Long Break");
  });

  it("lazy boundary exports PluginsTab as default-compatible named export", async () => {
    const mod = await import("./PluginsTab");
    expect(typeof mod.PluginsTab).toBe("function");
    expect(typeof mod.default).toBe("function");
  });

  it("fixture mode performs no transport refresh or workspace event subscription", () => {
    renderTab(root, {
      fixture: {
        plugins: fixtureInstalledPlugins(),
        communityEnabled: false,
        loadMode: "ready",
      },
    });
    expect(registerTaskEventHandler).not.toHaveBeenCalled();
    expect(listPlugins).not.toHaveBeenCalled();
    expect(getCommunityPolicy).not.toHaveBeenCalled();
    expect(eventHandlers.size).toBe(0);
  });

  it("refreshes Extensions for every backend plugin event and ignores non-plugin events", async () => {
    const initial = fixtureInstalledPlugins();
    const refreshed = initial.map((plugin) =>
      plugin.pluginId === "pomodoro"
        ? { ...plugin, name: "Pomodoro Timer Refreshed", desiredEnabled: false }
        : plugin,
    );
    listPlugins.mockResolvedValueOnce(initial).mockResolvedValue(refreshed);
    getCommunityPolicy.mockResolvedValue({
      enabled: false,
      updatedAt: "2026-08-04T15:00:00.000Z",
    });

    await act(async () => {
      root.render(createElement(Tab));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(registerTaskEventHandler).toHaveBeenCalledTimes(1);
    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Pomodoro Timer");
    expect(container.textContent).not.toContain("Pomodoro Timer Refreshed");

    await act(async () => {
      for (const handler of eventHandlers) {
        handler(committedEvent("task.updated"));
      }
      await Promise.resolve();
    });
    expect(listPlugins).toHaveBeenCalledTimes(1);

    expect(PLUGIN_EVENT_TYPES).toContain("plugin.replaced");
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.retry_requested");
    for (const eventType of PLUGIN_EVENT_TYPES) {
      await act(async () => {
        for (const handler of eventHandlers) {
          handler(committedEvent(eventType));
        }
        await Promise.resolve();
      });
    }
    expect(listPlugins).toHaveBeenCalledTimes(1 + PLUGIN_EVENT_TYPES.length);
    expect(getCommunityPolicy).toHaveBeenCalledTimes(1 + PLUGIN_EVENT_TYPES.length);
    expect(container.textContent).toContain("Pomodoro Timer Refreshed");
  });

  it("forwards exact scoped grants in server order and uses distinct operation ids", async () => {
    const scopedPermissions: PluginPermission[] = [
      {
        capability: "events:subscribe",
        scope: { event_kinds: ["task-created", "task-updated"] },
      },
      {
        capability: "http",
        scope: { origins: ["https://api.example.com"], methods: ["GET", "POST"] },
      },
      {
        capability: "services:consume",
        scope: {
          services: [{ plugin_id: "calendar", service_id: "events" }],
        },
      },
    ];
    const plugin = {
      ...fixtureInstalledPlugins().find((candidate) => candidate.pluginId === "sample-timer")!,
      requestedPermissions: scopedPermissions,
      grantedPermissions: [],
    };
    listPlugins.mockResolvedValue([plugin]);
    getCommunityPolicy.mockResolvedValue({
      enabled: true,
      updatedAt: "2026-08-04T15:00:00.000Z",
    });
    replaceGrants.mockResolvedValue({});
    enablePlugin.mockResolvedValue({});

    await act(async () => {
      root.render(createElement(Tab));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Expand Sample Timer Pack"]')
        ?.click();
    });
    act(() => buttonWithText(container, "Approve Permissions").click());

    expect(container.textContent).toContain("Event kinds: task-created, task-updated");
    expect(container.textContent).toContain(
      "HTTP origins: https://api.example.com; methods: GET, POST",
    );
    expect(container.textContent).toContain("Services: calendar/events");

    await act(async () => {
      buttonWithText(container, "Approve").click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(replaceGrants).toHaveBeenCalledOnce();
    expect(replaceGrants.mock.calls[0]?.[0]).toBe(plugin.pluginId);
    expect(replaceGrants.mock.calls[0]?.[1]).toBe(plugin.packageGeneration);
    expect(replaceGrants.mock.calls[0]?.[2]).toBe(scopedPermissions);
    const grantOperationId = replaceGrants.mock.calls[0]?.[3]?.operationId;
    const enableOperationId = enablePlugin.mock.calls[0]?.[1]?.operationId;
    expect(grantOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(enableOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(enableOperationId).not.toBe(grantOperationId);
  });

  it("confirms uninstall in a focus-trapped in-DOM dialog before transport", async () => {
    const plugin = fixtureInstalledPlugins().find(
      (candidate) => candidate.pluginId === "sample-timer",
    )!;
    listPlugins.mockResolvedValue([plugin]);
    getCommunityPolicy.mockResolvedValue({
      enabled: true,
      updatedAt: "2026-08-04T15:00:00.000Z",
    });
    let resolveUninstall!: (value: unknown) => void;
    uninstallPlugin.mockReturnValue(
      new Promise((resolve) => {
        resolveUninstall = resolve;
      }),
    );

    await act(async () => {
      root.render(createElement(Tab));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Expand Sample Timer Pack"]')
        ?.click();
    });

    act(() => buttonWithText(container, "Uninstall").click());
    let dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain("Uninstall Sample Timer Pack?");
    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("Cancel");

    const destructive = buttonWithText(dialog!, "Uninstall");
    destructive.focus();
    act(() =>
      destructive.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })),
    );
    expect(document.activeElement?.textContent).toBe("Cancel");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector('[aria-labelledby="plugin-uninstall-title"]')).toBeNull();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    act(() => buttonWithText(container, "Uninstall").click());
    dialog = document.querySelector<HTMLElement>('[aria-labelledby="plugin-uninstall-title"]');
    const backdrop = dialog?.parentElement;
    act(() => backdrop?.click());
    expect(document.querySelector('[aria-labelledby="plugin-uninstall-title"]')).toBeNull();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    act(() => buttonWithText(container, "Uninstall").click());
    dialog = document.querySelector<HTMLElement>('[aria-labelledby="plugin-uninstall-title"]');
    await act(async () => {
      buttonWithText(dialog!, "Uninstall").click();
      await Promise.resolve();
    });
    expect(uninstallPlugin).toHaveBeenCalledOnce();
    expect(uninstallPlugin).toHaveBeenCalledWith(plugin.pluginId, {
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(buttonWithText(document.body, "Uninstalling...").disabled).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector('[aria-labelledby="plugin-uninstall-title"]')).not.toBeNull();

    resolveUninstall({});
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[aria-labelledby="plugin-uninstall-title"]')).toBeNull();
  });
});
