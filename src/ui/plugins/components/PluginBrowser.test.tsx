/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureInstalledPlugins } from "../phase7/fixtureData";
import type { InstalledPlugin } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listRegistry = vi.fn();
const enablePlugin = vi.fn();
const disablePlugin = vi.fn();

vi.mock("../transport", async () => {
  const actual = await vi.importActual<typeof import("../transport")>("../transport");
  return {
    ...actual,
    listRegistry: (...args: unknown[]) => listRegistry(...args),
    enablePlugin: (...args: unknown[]) => enablePlugin(...args),
    disablePlugin: (...args: unknown[]) => disablePlugin(...args),
  };
});

import { PluginBrowser } from "./PluginBrowser";

function installedPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const plugin = fixtureInstalledPlugins().find(
    (candidate) => candidate.pluginId === "sample-timer",
  )!;
  return { ...plugin, ...overrides };
}

function actionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${label} button`);
  return button;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PluginBrowser installed actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listRegistry.mockReset().mockResolvedValue({ indexSha256: "0".repeat(64), entries: [] });
    enablePlugin.mockReset();
    disablePlugin.mockReset();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderInstalled(
    plugin: InstalledPlugin,
    options: {
      fixtureMode?: "ready";
      onInstalledChange?: () => void | Promise<void>;
      onReviewPermissions?: (plugin: InstalledPlugin) => void;
    } = {},
  ) {
    await act(async () => {
      root.render(
        createElement(PluginBrowser, {
          open: true,
          onClose: vi.fn(),
          installedPlugins: [plugin],
          initialSelectedId: plugin.pluginId,
          ...options,
        }),
      );
      await Promise.resolve();
    });
  }

  it("enables with a fresh operation id, shows pending, and awaits refresh", async () => {
    const plugin = installedPlugin();
    plugin.grantedPermissions = plugin.requestedPermissions;
    const mutation = deferred<unknown>();
    const refresh = deferred<void>();
    enablePlugin.mockReturnValue(mutation.promise);
    const onInstalledChange = vi.fn(() => refresh.promise);
    await renderInstalled(plugin, { onInstalledChange });

    await act(async () => {
      actionButton(container, "Enable").click();
      await Promise.resolve();
    });

    expect(actionButton(container, "Enabling...").disabled).toBe(true);
    expect(enablePlugin).toHaveBeenCalledWith(plugin.pluginId, {
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(disablePlugin).not.toHaveBeenCalled();

    mutation.resolve({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(onInstalledChange).toHaveBeenCalledOnce();
    expect(actionButton(container, "Enabling...").disabled).toBe(true);

    refresh.resolve();
    await act(async () => {
      await Promise.resolve();
    });
    expect(actionButton(container, "Enable").disabled).toBe(false);
  });

  it("disables the exact currently installed enabled plugin", async () => {
    const plugin = installedPlugin({ desiredEnabled: true, runtimeState: "active" });
    plugin.grantedPermissions = plugin.requestedPermissions;
    disablePlugin.mockResolvedValue({});
    const onInstalledChange = vi.fn(async () => undefined);
    await renderInstalled(plugin, { onInstalledChange });

    await act(async () => {
      actionButton(container, "Disable").click();
      await Promise.resolve();
    });

    expect(disablePlugin).toHaveBeenCalledWith(plugin.pluginId, {
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(enablePlugin).not.toHaveBeenCalled();
    expect(onInstalledChange).toHaveBeenCalledOnce();
  });

  it("requests permission review instead of bypassing a missing exact scope grant", async () => {
    const plugin = installedPlugin({
      requestedPermissions: [
        {
          capability: "http",
          scope: { origins: ["https://api.example.com"], methods: ["GET"] },
        },
      ],
      grantedPermissions: [
        {
          capability: "http",
          scope: { origins: ["https://other.example.com"], methods: ["GET"] },
        },
      ],
    });
    const onReviewPermissions = vi.fn();
    await renderInstalled(plugin, { onReviewPermissions });

    act(() => actionButton(container, "Review permissions").click());

    expect(onReviewPermissions).toHaveBeenCalledWith(plugin);
    expect(enablePlugin).not.toHaveBeenCalled();
    expect(disablePlugin).not.toHaveBeenCalled();
  });

  it("reports enable failures in the existing detail error region", async () => {
    const plugin = installedPlugin();
    plugin.grantedPermissions = plugin.requestedPermissions;
    enablePlugin.mockRejectedValue(new Error("runtime refused activation"));
    await renderInstalled(plugin);

    await act(async () => {
      actionButton(container, "Enable").click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to enable Sample Timer Pack: runtime refused activation",
    );
  });

  it("keeps offline fixture actions as transport-free no-ops", async () => {
    const plugin = installedPlugin();
    plugin.grantedPermissions = plugin.requestedPermissions;
    const onInstalledChange = vi.fn();
    const onReviewPermissions = vi.fn();
    await renderInstalled(plugin, {
      fixtureMode: "ready",
      onInstalledChange,
      onReviewPermissions,
    });

    act(() => actionButton(container, "Enable").click());

    expect(listRegistry).not.toHaveBeenCalled();
    expect(enablePlugin).not.toHaveBeenCalled();
    expect(disablePlugin).not.toHaveBeenCalled();
    expect(onInstalledChange).not.toHaveBeenCalled();
    expect(onReviewPermissions).not.toHaveBeenCalled();
  });
});
