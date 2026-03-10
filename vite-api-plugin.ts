import type { ViteDevServer } from "vite";
import { registerRoutes } from "./vite-api-routes/index.js";

export function apiPlugin() {
  return {
    name: "saydo-api",
    configureServer(server: ViteDevServer) {
      // Lazy-load bootstrap to avoid issues with Vite's module resolution
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let services: any = null;

      async function getServices() {
        if (!services) {
          // Use ssrLoadModule so Vite's @/ alias resolves for transitive imports
          const mod = await server.ssrLoadModule("./src/bootstrap.ts");
          services = mod.bootstrap();
        }
        return services;
      }

      registerRoutes(server, getServices);
    },
  };
}
