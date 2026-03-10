import { Hono } from "hono";
import type { AppServices } from "../bootstrap.js";

export function tagRoutes(services: AppServices): Hono {
  const app = new Hono();

  // GET /tags
  app.get("/", async (c) => {
    const tags = await services.tagService.list();
    return c.json(tags);
  });

  // POST /tags — create a tag
  app.post("/", async (c) => {
    const body = await c.req.json();
    const tag = await services.tagService.create(body.name, body.color);
    return c.json(tag, 201);
  });

  // DELETE /tags/:id
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await services.tagService.delete(id);
    return c.body(null, 204);
  });

  return app;
}
