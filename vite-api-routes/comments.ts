import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerCommentRoutes: RouteRegistrar = (server, getServices) => {
  // GET/POST /api/tasks/:id/comments, GET /api/tasks/:id/activity, PATCH/DELETE /api/comments/:id
  server.middlewares.use(async (req, res, next) => {
    const commentMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/comments$/);
    if (commentMatch) {
      const taskId = decodeURIComponent(commentMatch[1]);
      const svc = await getServices();

      if (req.method === "GET") {
        try {
          const comments = svc.storage.listTaskComments(taskId);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(comments));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      if (req.method === "POST") {
        try {
          const body = await parseBody(req);
          const { generateId } = await import("../src/utils/ids.js");
          const now = new Date().toISOString();
          const comment = {
            id: generateId(),
            taskId,
            content: body.content as string,
            createdAt: now,
            updatedAt: now,
          };
          svc.storage.insertTaskComment(comment);
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 201;
          res.end(JSON.stringify(comment));
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

    // GET /api/tasks/:id/activity
    const activityMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/activity$/);
    if (activityMatch && req.method === "GET") {
      const taskId = decodeURIComponent(activityMatch[1]);
      const svc = await getServices();
      try {
        const activity = svc.storage.listTaskActivity(taskId);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(activity));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // PATCH/DELETE /api/comments/:id
    const singleCommentMatch = req.url?.match(/^\/api\/comments\/([^/]+)$/);
    if (singleCommentMatch) {
      const commentId = decodeURIComponent(singleCommentMatch[1]);
      const svc = await getServices();

      if (req.method === "PATCH") {
        try {
          const body = await parseBody(req);
          svc.storage.updateTaskComment(commentId, {
            content: body.content as string,
            updatedAt: new Date().toISOString(),
          });
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

      if (req.method === "DELETE") {
        try {
          svc.storage.deleteTaskComment(commentId);
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

    next();
  });
};
