/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContribution, RenderedContribution } from "./types";
import { fixtureDeclarativePanelSurface } from "./phase7/fixtureData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderSurface = vi.fn();
const invokeAction = vi.fn();
const refreshContributions = vi.fn(async () => undefined);
const invalidateContributions = vi.fn(async () => undefined);
const invokeCommand = vi.fn(async () => undefined);
const handlePluginEvent = vi.fn(() => undefined);
let mockContributions: PluginContribution[] = [];

vi.mock("./PluginProvider", async () => {
  const actual = await vi.importActual<typeof import("./PluginProvider")>("./PluginProvider");
  return {
    ...actual,
    // Stable function identities — panel effects depend on renderSurface/invokeAction refs.
    usePlugins: () => ({
      contributions: mockContributions,
      loading: false,
      error: null,
      refreshContributions,
      invalidateContributions,
      invokeCommand,
      renderSurface,
      invokeAction,
      handlePluginEvent,
    }),
  };
});

import { PluginSidebarPanels, pluginCommandPaletteEntries } from "./contributions";

function panelContribution(overrides?: Partial<PluginContribution>): PluginContribution {
  return {
    contributionId: "demo-plugin:automation",
    pluginId: "demo-plugin",
    localId: "automation",
    kind: "panel",
    title: "Automation Panel",
    description: null,
    location: "sidebar",
    actions: ["example:run-plan"],
    packageGeneration: 1,
    activationEpoch: 1,
    hostSessionId: "host-session-1",
    ...overrides,
  };
}

function renderedFor(contribution: PluginContribution): RenderedContribution {
  return {
    pluginId: contribution.pluginId,
    surfaceId: contribution.localId,
    packageGeneration: contribution.packageGeneration,
    activationEpoch: contribution.activationEpoch,
    hostSessionId: contribution.hostSessionId,
    surface: fixtureDeclarativePanelSurface(),
  };
}

describe("pluginCommandPaletteEntries", () => {
  it("forwards the exact command contribution authority to each callback", async () => {
    const first = panelContribution({
      contributionId: "demo-plugin:command:first",
      localId: "run",
      kind: "command",
      packageGeneration: 4,
      activationEpoch: 7,
      hostSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const replacement = panelContribution({
      contributionId: "demo-plugin:command:replacement",
      localId: "run",
      kind: "command",
      packageGeneration: 5,
      activationEpoch: 1,
      hostSessionId: "22222222-2222-4222-8222-222222222222",
    });
    const invoke = vi.fn(async (_contribution: PluginContribution) => undefined);

    const entries = pluginCommandPaletteEntries([first, replacement], invoke);
    await entries[0]?.callback();
    await entries[1]?.callback();

    expect(invoke.mock.calls).toEqual([[first], [replacement]]);
  });
});

describe("PluginSidebarPanels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mockContributions = [];
    renderSurface.mockReset();
    invokeAction.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when there are no sidebar panel contributions", () => {
    mockContributions = [
      panelContribution({ kind: "command", contributionId: "demo-plugin:cmd", localId: "cmd" }),
    ];
    act(() => {
      root.render(createElement(PluginSidebarPanels));
    });
    expect(container.querySelector('[data-testid="plugin-sidebar-panels"]')).toBeNull();
    expect(renderSurface).not.toHaveBeenCalled();
  });

  it("renders nothing when the sidebar is collapsed even with a valid panel", async () => {
    const panel = panelContribution();
    mockContributions = [panel];
    renderSurface.mockResolvedValue(renderedFor(panel));

    await act(async () => {
      root.render(createElement(PluginSidebarPanels, { collapsed: true }));
    });

    expect(container.querySelector('[data-testid="plugin-sidebar-panels"]')).toBeNull();
    expect(container.textContent).not.toContain("Automation Panel");
    expect(renderSurface).not.toHaveBeenCalled();
  });

  it("composes a valid panel contribution through DeclarativeRenderer", async () => {
    const panel = panelContribution();
    mockContributions = [panel];
    renderSurface.mockResolvedValue(renderedFor(panel));

    await act(async () => {
      root.render(createElement(PluginSidebarPanels));
    });
    // Allow the renderSurface effect to settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="plugin-sidebar-panels"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("Automation Panel");
    expect(container.textContent).toContain("Queued actions");
    expect(container.textContent).toContain("Run plan");
    expect(renderSurface).toHaveBeenCalledWith(panel);

    const button = Array.from(container.querySelectorAll("button")).find(
      (el) => el.textContent === "Run plan",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(invokeAction).toHaveBeenCalledWith(panel, "example:run-plan", []);
  });
});
