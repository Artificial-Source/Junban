import { describe, it, expect, beforeEach } from "vitest";
import { createTestServices } from "./helpers.js";
import type { ProjectService } from "../../src/core/projects.js";

describe("ProjectService (integration)", () => {
  let projectService: ProjectService;

  beforeEach(() => {
    const services = createTestServices();
    projectService = services.projectService;
  });

  describe("create", () => {
    it("creates a project with default color", async () => {
      const project = await projectService.create("Work");

      expect(project.id).toBeDefined();
      expect(project.name).toBe("Work");
      expect(project.color).toBe("#3b82f6");
      expect(project.icon).toBeNull();
      expect(project.archived).toBe(false);
      expect(project.createdAt).toBeDefined();
    });

    it("creates a project with custom color", async () => {
      const project = await projectService.create("Personal", { color: "#22c55e" });

      expect(project.name).toBe("Personal");
      expect(project.color).toBe("#22c55e");
    });
  });

  describe("list", () => {
    it("returns all projects", async () => {
      await projectService.create("A");
      await projectService.create("B");

      const projects = await projectService.list();
      expect(projects).toHaveLength(2);
    });

    it("returns empty array when no projects exist", async () => {
      const projects = await projectService.list();
      expect(projects).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns a project by ID", async () => {
      const created = await projectService.create("FindMe");

      const found = await projectService.get(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("FindMe");
    });

    it("returns null for non-existent ID", async () => {
      const found = await projectService.get("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("getByName", () => {
    it("finds a project by name", async () => {
      const created = await projectService.create("Unique");

      const found = await projectService.getByName("Unique");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it("returns null for non-existent name", async () => {
      const found = await projectService.getByName("Nope");
      expect(found).toBeNull();
    });
  });

  describe("getOrCreate", () => {
    it("creates a new project when it does not exist", async () => {
      const project = await projectService.getOrCreate("New Project");

      expect(project.id).toBeDefined();
      expect(project.name).toBe("New Project");

      const projects = await projectService.list();
      expect(projects).toHaveLength(1);
    });

    it("returns existing project when it already exists (idempotent)", async () => {
      const first = await projectService.getOrCreate("Idempotent");
      const second = await projectService.getOrCreate("Idempotent");

      expect(first.id).toBe(second.id);

      const projects = await projectService.list();
      expect(projects).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates project name", async () => {
      const project = await projectService.create("Old Name");

      const updated = await projectService.update(project.id, {
        name: "New Name",
      });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
      expect(updated!.color).toBe("#3b82f6"); // unchanged
    });

    it("updates project color", async () => {
      const project = await projectService.create("Colorful");

      const updated = await projectService.update(project.id, {
        color: "#ef4444",
      });
      expect(updated).not.toBeNull();
      expect(updated!.color).toBe("#ef4444");
      expect(updated!.name).toBe("Colorful"); // unchanged
    });

    it("updates multiple fields at once", async () => {
      const project = await projectService.create("Multi");

      const updated = await projectService.update(project.id, {
        name: "Updated Multi",
        color: "#a855f7",
        archived: true,
      });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Multi");
      expect(updated!.color).toBe("#a855f7");
      expect(updated!.archived).toBe(true);
    });

    it("returns null for non-existent project", async () => {
      const result = await projectService.update("nonexistent", {
        name: "Nope",
      });
      expect(result).toBeNull();
    });

    it("partial update does not clear other fields", async () => {
      const project = await projectService.create("Partial", { color: "#22c55e" });

      const updated = await projectService.update(project.id, {
        archived: true,
      });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Partial");
      expect(updated!.color).toBe("#22c55e");
      expect(updated!.archived).toBe(true);
    });
  });

  describe("archive", () => {
    it("archives a project", async () => {
      const project = await projectService.create("To Archive");

      const result = await projectService.archive(project.id);
      expect(result).toBe(true);

      const fetched = await projectService.get(project.id);
      expect(fetched!.archived).toBe(true);
    });

    it("returns false for non-existent project", async () => {
      const result = await projectService.archive("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("delete", () => {
    it("deletes a project", async () => {
      const project = await projectService.create("Doomed");

      const result = await projectService.delete(project.id);
      expect(result).toBe(true);

      const projects = await projectService.list();
      expect(projects).toHaveLength(0);
    });

    it("returns false for non-existent project", async () => {
      const result = await projectService.delete("nonexistent");
      expect(result).toBe(false);
    });

    it("nullifies projectId on associated tasks", async () => {
      const services = createTestServices();
      const project = await services.projectService.create("Will Delete");
      const task = await services.taskService.create({
        title: "Linked task",
        projectId: project.id,
      });

      await services.projectService.delete(project.id);

      const fetched = await services.taskService.get(task.id);
      expect(fetched!.projectId).toBeNull();
    });
  });
});
