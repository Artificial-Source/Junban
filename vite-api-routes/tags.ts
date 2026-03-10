import type { RouteRegistrar } from "./types.js";

export const registerTagRoutes: RouteRegistrar = (server, getServices) => {
  // GET /api/tags
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tags" || req.method !== "GET") return next();

    try {
      const svc = await getServices();
      const tags = await svc.tagService.list();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(tags));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });
};
