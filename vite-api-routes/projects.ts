import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerProjectRoutes: RouteRegistrar = (server, getServices) => {
  // GET/POST /api/projects
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/projects") return next();

    try {
      const svc = await getServices();

      if (req.method === "GET") {
        const projects = await svc.projectService.list();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(projects));
        return;
      }

      if (req.method === "POST") {
        const body = await parseBody(req);
        const name = body.name as string;
        if (!name) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "name is required" }));
          return;
        }
        const project = await svc.projectService.create(name, {
          color: (body.color as string) || undefined,
          parentId: (body.parentId as string) || null,
          isFavorite: (body.isFavorite as boolean) || false,
          viewStyle: (body.viewStyle as "list" | "board" | "calendar") || "list",
        });
        if (body.icon) {
          const updated = await svc.projectService.update(project.id, {
            icon: body.icon as string,
          });
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 201;
          res.end(JSON.stringify(updated ?? project));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 201;
        res.end(JSON.stringify(project));
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

  // PATCH/DELETE /api/projects/:id
  server.middlewares.use(async (req, res, next) => {
    const match = req.url?.match(/^\/api\/projects\/([^/]+)$/);
    if (!match) return next();

    const id = decodeURIComponent(match[1]);
    const svc = await getServices();

    if (req.method === "PATCH") {
      try {
        const body = await parseBody(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const project = await svc.projectService.update(id, body as any);
        if (!project) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Project not found" }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(project));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (req.method === "DELETE") {
      try {
        await svc.projectService.delete(id);
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

    next();
  });
};
