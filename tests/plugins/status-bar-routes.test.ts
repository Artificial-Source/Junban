import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginRoutes } from "../../src/api/plugins.js";
import { registerPluginRoutes } from "../../vite-api-routes/plugins.js";
import { UIRegistry } from "../../src/plugins/ui-registry.js";

describe("plugin status bar click routes", () => {
  describe("Hono route", () => {
    const uiRegistry = new UIRegistry();
    const loadAll = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      loadAll.mockClear();
      uiRegistry.removeByPlugin("test-plugin");
    });

    it("invokes the status bar onClick handler", async () => {
      const onClick = vi.fn();
      uiRegistry.addStatusBarItem({
        id: "status-item",
        pluginId: "test-plugin",
        text: "Ready",
        icon: "circle",
        onClick,
      });

      const app = pluginRoutes({
        pluginLoader: { loadAll },
        uiRegistry,
      } as never);

      const res = await app.request("http://localhost/ui/status-bar/test-plugin:status-item/click", {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(loadAll).toHaveBeenCalledTimes(1);
    });

    it("returns 404 for unknown status bar items", async () => {
      const app = pluginRoutes({
        pluginLoader: { loadAll },
        uiRegistry,
      } as never);

      const res = await app.request("http://localhost/ui/status-bar/missing/click", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Status bar item not found" });
    });
  });

  describe("Vite route", () => {
    const uiRegistry = new UIRegistry();
    const onClick = vi.fn();
    const services = {
      pluginLoader: {
        setModuleLoader: vi.fn(),
        loadAll: vi.fn().mockResolvedValue(undefined),
      },
      uiRegistry,
    };
    const getServices = vi.fn().mockResolvedValue(services);
    const middlewares: Array<(req: any, res: any, next: () => void) => unknown> = [];
    const server = {
      middlewares: {
        use(fn: (req: any, res: any, next: () => void) => unknown) {
          middlewares.push(fn);
        },
      },
      ssrLoadModule: vi.fn(),
    };

    async function dispatch(url: string, method: string) {
      const req = { url, method };
      const headers = new Map<string, string>();
      let body = "";
      let ended = false;
      const res = {
        statusCode: 200,
        setHeader(name: string, value: string) {
          headers.set(name, value);
        },
        end(chunk?: string) {
          body = chunk ?? "";
          ended = true;
        },
      };

      for (const fn of middlewares) {
        let shouldContinue = false;
        await fn(req, res, () => {
          shouldContinue = true;
        });
        if (ended || !shouldContinue) {
          break;
        }
      }

      return { statusCode: res.statusCode, body, headers, ended };
    }

    beforeEach(() => {
      middlewares.length = 0;
      uiRegistry.removeByPlugin("test-plugin");
      onClick.mockClear();
      getServices.mockClear();
      services.pluginLoader.setModuleLoader.mockClear();
      services.pluginLoader.loadAll.mockClear();
      registerPluginRoutes(server as never, getServices);
    });

    it("invokes the status bar onClick handler", async () => {
      uiRegistry.addStatusBarItem({
        id: "status-item",
        pluginId: "test-plugin",
        text: "Ready",
        icon: "circle",
        onClick,
      });

      const res = await dispatch("/api/plugins/ui/status-bar/test-plugin:status-item/click", "POST");

      expect(res.ended).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("returns 404 for unknown status bar items", async () => {
      const res = await dispatch("/api/plugins/ui/status-bar/missing/click", "POST");

      expect(res.ended).toBe(true);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Status bar item not found" });
    });
  });
});
