import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerTemplateRoutes: RouteRegistrar = (server, getServices) => {
  // GET/POST /api/templates
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/templates") return next();
    try {
      const svc = await getServices();
      const { TemplateService } = await import("../src/core/templates.js");
      const templateService = new TemplateService(svc.storage, svc.taskService);

      if (req.method === "GET") {
        const templates = await templateService.list();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(templates));
        return;
      }

      if (req.method === "POST") {
        const body = await parseBody(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const template = await templateService.create(body as any);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 201;
        res.end(JSON.stringify(template));
        return;
      }

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // PATCH/DELETE /api/templates/:id and POST /api/templates/:id/instantiate
  server.middlewares.use(async (req, res, next) => {
    const instantiateMatch = req.url?.match(/^\/api\/templates\/([^/]+)\/instantiate$/);
    if (instantiateMatch && req.method === "POST") {
      try {
        const svc = await getServices();
        const { TemplateService } = await import("../src/core/templates.js");
        const templateService = new TemplateService(svc.storage, svc.taskService);
        const body = await parseBody(req);
        const task = await templateService.instantiate(
          instantiateMatch[1],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (body as any).variables,
        );
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 201;
        res.end(JSON.stringify(task));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const match = req.url?.match(/^\/api\/templates\/([^/]+)$/);
    if (!match) return next();

    try {
      const svc = await getServices();
      const { TemplateService } = await import("../src/core/templates.js");
      const templateService = new TemplateService(svc.storage, svc.taskService);
      const id = match[1];

      if (req.method === "PATCH") {
        const body = await parseBody(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const template = await templateService.update(id, body as any);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(template));
        return;
      }

      if (req.method === "DELETE") {
        await templateService.delete(id);
        res.statusCode = 204;
        res.end();
        return;
      }

      next();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      res.statusCode = err.name === "NotFoundError" ? 404 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
  });
};
