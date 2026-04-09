import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPluginAPI } from "../../src/plugins/api.js";
import { createTestServices } from "../integration/helpers.js";
import { PluginSettingsManager } from "../../src/plugins/settings.js";
import { CommandRegistry } from "../../src/plugins/command-registry.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";
import type { Permission } from "../../src/plugins/types.js";

function createAPI(permissions: Permission[]) {
  const { taskService, projectService, tagService, eventBus, storage } = createTestServices();
  return createPluginAPI({
    pluginId: "test-network",
    permissions,
    taskService,
    projectService,
    tagService,
    eventBus,
    settingsManager: new PluginSettingsManager(storage),
    commandRegistry: new CommandRegistry(),
    uiRegistry: new UIRegistry(),
    settingDefinitions: [],
  });
}

describe("Plugin Network API", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should throw without network permission", () => {
    const api = createAPI(["task:read"]);
    expect(() => api.network.fetch("http://example.com")).toThrow(/requires the "network" permission/);
  });

  it("should be defined with network permission", () => {
    const api = createAPI(["network"]);
    expect(api.network).toBeDefined();
    expect(api.network.fetch).toBeTypeOf("function");
  });

  it("should call global fetch with provided url and options", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const api = createAPI(["network"]);
    const result = await api.network.fetch("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });

    expect(result).toBe(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
      redirect: "manual",
    });
  });

  it("should log fetch requests", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    const api = createAPI(["network"]);
    await api.network.fetch("https://example.com/data");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plugin fetch request"),
    );

    logSpy.mockRestore();
  });

  it("should pass through fetch errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const api = createAPI(["network"]);
    await expect(api.network.fetch("https://unreachable.test")).rejects.toThrow("Network error");
  });

  it("blocks localhost targets even with network permission", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    const api = createAPI(["network"]);
    await expect(api.network.fetch("http://localhost:8080/health")).rejects.toThrow(
      /Blocked network\.fetch\(\) for plugin "test-network"/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 loopback targets", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    const api = createAPI(["network"]);
    await expect(api.network.fetch("http://[::ffff:7f00:1]/health")).rejects.toThrow(
      /local\/private IPv6 ranges are not allowed/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks non-http schemes", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    const api = createAPI(["network"]);
    await expect(api.network.fetch("file:///etc/passwd")).rejects.toThrow(
      /scheme "file:" is not allowed/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks redirect responses to prevent SSRF bypass", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost:8080/internal" },
      }),
    );

    const api = createAPI(["network"]);
    await expect(api.network.fetch("https://example.com/redirect")).rejects.toThrow(
      /redirects are not allowed/,
    );
  });

  it("should default to GET method in logs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    const api = createAPI(["network"]);
    await api.network.fetch("https://example.com");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"method":"GET"'),
    );

    logSpy.mockRestore();
  });
});
