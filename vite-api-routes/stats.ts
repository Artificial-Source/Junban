import type { RouteRegistrar } from "./types.js";

export const registerStatsRoutes: RouteRegistrar = (server, getServices) => {
  // GET /api/stats/daily?startDate=X&endDate=Y — daily stats for a date range
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname !== "/api/stats/daily" || req.method !== "GET") return next();

    try {
      const svc = await getServices();
      const startDate = url.searchParams.get("startDate") ?? "";
      const endDate = url.searchParams.get("endDate") ?? "";
      const stats = await svc.statsService.getStats(startDate, endDate);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(stats));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // GET /api/stats/today — today's stats
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/stats/today" || req.method !== "GET") return next();

    try {
      const svc = await getServices();
      const stat = await svc.statsService.getToday();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(stat));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });
};
