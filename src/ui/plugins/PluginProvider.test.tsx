/**
 * @vitest-environment jsdom
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredToken, PLUGIN_EVENT_TYPES, storeToken } from "../api/client";
import { PluginProvider, usePlugins, type PluginContextValue } from "./PluginProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "plugin-provider-test-token";
let currentContext: PluginContextValue | null = null;
let rerenderCapture: (() => void) | null = null;

function CaptureContext() {
  currentContext = usePlugins();
  return null;
}

function ReRenderCapture() {
  const [, setRender] = useState(0);
  rerenderCapture = () => setRender((render) => render + 1);
  currentContext = usePlugins();
  return null;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("PluginProvider command authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    currentContext = null;
    rerenderCapture = null;
    clearStoredToken();
    storeToken(TOKEN);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    clearStoredToken();
  });

  it("returns stable no-op identities when the provider is absent", () => {
    act(() => {
      root.render(<ReRenderCapture />);
    });
    const initialContext = currentContext;
    expect(initialContext).toBeDefined();

    for (let render = 0; render < 3; render += 1) {
      act(() => rerenderCapture?.());
      expect(currentContext).toBe(initialContext);
      expect(currentContext?.contributions).toBe(initialContext?.contributions);
      expect(currentContext?.renderSurface).toBe(initialContext?.renderSurface);
    }
  });

  it("forwards the selected command contribution's exact fence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          contributions: [
            {
              contribution_id: "demo-plugin:run",
              plugin_id: "demo-plugin",
              local_id: "run",
              kind: "command",
              title: "Run",
              description: null,
              location: null,
              actions: [],
              package_generation: 12,
              activation_epoch: 6,
              host_session_id: "33333333-3333-4333-8333-333333333333",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          status: "completed",
          terminal_kind: "readonly",
          revision: null,
          rejection: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(createElement(PluginProvider, null, createElement(CaptureContext)));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(currentContext?.contributions).toHaveLength(1);
    const contribution = currentContext?.contributions[0];
    expect(contribution).toBeDefined();
    await act(async () => {
      await currentContext?.invokeCommand(contribution!);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/plugins/demo-plugin/commands/run");
    expect(JSON.parse(String(init.body))).toEqual({
      package_generation: 12,
      activation_epoch: 6,
      host_session_id: "33333333-3333-4333-8333-333333333333",
      values: [],
    });
  });

  it("invalidates contributions for every backend plugin event", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response({ contributions: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(createElement(PluginProvider, null, createElement(CaptureContext)));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.replaced");
    expect(PLUGIN_EVENT_TYPES).toContain("plugin.retry_requested");

    for (const eventType of PLUGIN_EVENT_TYPES) {
      await act(async () => {
        currentContext?.handlePluginEvent(eventType);
        await Promise.resolve();
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1 + PLUGIN_EVENT_TYPES.length);
    currentContext?.handlePluginEvent("task.updated");
    expect(fetchMock).toHaveBeenCalledTimes(1 + PLUGIN_EVENT_TYPES.length);
  });

  it("fails closed when a non-command contribution is passed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <PluginProvider enabled={false}>
          <CaptureContext />
        </PluginProvider>,
      );
    });

    await expect(
      currentContext?.invokeCommand({
        contributionId: "demo-plugin:view",
        pluginId: "demo-plugin",
        localId: "view",
        kind: "view",
        title: "View",
        description: null,
        location: "workspace",
        actions: [],
        packageGeneration: 12,
        activationEpoch: 6,
        hostSessionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow("plugin contribution is not a command");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
