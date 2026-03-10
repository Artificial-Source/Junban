import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerSectionRoutes: RouteRegistrar = (server, getServices) => {
  // GET/POST /api/sections, POST /api/sections/reorder, PATCH/DELETE /api/sections/:id
  server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/sections")) return next();

    // POST /api/sections/reorder
    if (req.url === "/api/sections/reorder" && req.method === "POST") {
      try {
        const svc = await getServices();
        const body = await parseBody(req);
        const { orderedIds } = body as { orderedIds: string[] };
        await svc.sectionService.reorder(orderedIds);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // PATCH/DELETE /api/sections/:id
    const idMatch = req.url.match(/^\/api\/sections\/([^/?]+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      const svc = await getServices();

      if (req.method === "PATCH") {
        try {
          const body = await parseBody(req);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const section = await svc.sectionService.update(id, body as any);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(section));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          res.statusCode = err.name === "NotFoundError" ? 404 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === "DELETE") {
        try {
          await svc.sectionService.delete(id);
          res.statusCode = 204;
          res.end();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      return next();
    }

    // GET/POST /api/sections
    if (req.url === "/api/sections" || req.url.startsWith("/api/sections?")) {
      try {
        const svc = await getServices();

        if (req.method === "GET") {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const projectId = url.searchParams.get("projectId");
          if (!projectId) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "projectId is required" }));
            return;
          }
          const sections = await svc.sectionService.list(projectId);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(sections));
          return;
        }

        if (req.method === "POST") {
          const body = await parseBody(req);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const section = await svc.sectionService.create(body as any);
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 201;
          res.end(JSON.stringify(section));
          return;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    next();
  });
};
