import { describe, it, expect, beforeEach } from "vitest";
import { createTestServices } from "../integration/helpers.js";
import type { TaskService } from "../../src/core/tasks.js";
import type { ProjectService } from "../../src/core/projects.js";

describe("ProjectService", () => {
  let projectService: ProjectService;
  let taskService: TaskService;

  beforeEach(() => {
    const services = createTestServices();
    projectService = services.projectService;
    taskService = services.taskService;
  });

  // ── create ──

  describe("create()", () => {
    it("creates a project with a name and returns it", async () => {
      const project = await projectService.create("My Project");

      expect(project.id).toBeDefined();
      expect(project.name).toBe("My Project");
      expect(project.archived).toBe(false);
      expect(project.createdAt).toBeDefined();
    });

    it("applies default color when none provided", async () => {
      const project = await projectService.create("Defaults");

      expect(project.color).toBe("#3b82f6");
    });

    it("creates a project with custom color", async () => {
      const project = await projectService.create("Colored", { color: "#ff0000" });

      expect(project.color).toBe("#ff0000");
    });

    it("creates a project with isFavorite", async () => {
      const project = await projectService.create("Fav", { isFavorite: true });

      expect(project.isFavorite).toBe(true);
    });

    it("creates a project with a viewStyle", async () => {
      const project = await projectService.create("Board", { viewStyle: "board" });

      expect(project.viewStyle).toBe("board");
    });

    it("creates a project with a parentId", async () => {
      const parent = await projectService.create("Parent");
      const child = await projectService.create("Child", { parentId: parent.id });

      expect(child.parentId).toBe(parent.id);
    });

    it("defaults viewStyle to list", async () => {
      const project = await projectService.create("Default view");

      expect(project.viewStyle).toBe("list");
    });
  });

  // ── get ──

  describe("get()", () => {
    it("retrieves a project by ID", async () => {
      const created = await projectService.create("Findable");
      const found = await projectService.get(created.id);

      expect(found).not.toBeNull();
      expect(found!.name).toBe("Findable");
    });

    it("returns null for non-existent ID", async () => {
      const found = await projectService.get("nonexistent");
      expect(found).toBeNull();
    });
  });

  // ── getByName ──

  describe("getByName()", () => {
    it("retrieves a project by name", async () => {
      await projectService.create("Unique Name");
      const found = await projectService.getByName("Unique Name");

      expect(found).not.toBeNull();
      expect(found!.name).toBe("Unique Name");
    });

    it("returns null for non-existent name", async () => {
      const found = await projectService.getByName("Does Not Exist");
      expect(found).toBeNull();
    });
  });

  // ── getOrCreate ──

  describe("getOrCreate()", () => {
    it("returns existing project if name matches", async () => {
      const original = await projectService.create("Existing");
      const result = await projectService.getOrCreate("Existing");

      expect(result.id).toBe(original.id);
    });

    it("creates a new project if name does not exist", async () => {
      const result = await projectService.getOrCreate("Brand New");

      expect(result.id).toBeDefined();
      expect(result.name).toBe("Brand New");
    });
  });

  // ── list ──

  describe("list()", () => {
    it("returns empty array when no projects exist", async () => {
      const projects = await projectService.list();
      expect(projects).toEqual([]);
    });

    it("returns all created projects", async () => {
      await projectService.create("Alpha");
      await projectService.create("Beta");
      await projectService.create("Gamma");

      const projects = await projectService.list();
      expect(projects).toHaveLength(3);
    });
  });

  // ── update ──

  describe("update()", () => {
    it("updates the name of a project", async () => {
      const project = await projectService.create("Old Name");
      const updated = await projectService.update(project.id, { name: "New Name" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
    });

    it("updates the color", async () => {
      const project = await projectService.create("Recolor");
      const updated = await projectService.update(project.id, { color: "#00ff00" });

      expect(updated!.color).toBe("#00ff00");
    });

    it("returns null for non-existent project", async () => {
      const result = await projectService.update("missing", { name: "Nope" });
      expect(result).toBeNull();
    });

    it("updates isFavorite", async () => {
      const project = await projectService.create("Toggle Fav");
      const updated = await projectService.update(project.id, { isFavorite: true });

      expect(updated!.isFavorite).toBe(true);
    });

    it("updates viewStyle", async () => {
      const project = await projectService.create("Switch View");
      const updated = await projectService.update(project.id, { viewStyle: "calendar" });

      expect(updated!.viewStyle).toBe("calendar");
    });
  });

  // ── archive ──

  describe("archive()", () => {
    it("archives a project", async () => {
      const project = await projectService.create("Archivable");
      const result = await projectService.archive(project.id);

      expect(result).toBe(true);

      const found = await projectService.get(project.id);
      expect(found!.archived).toBe(true);
    });

    it("returns false for non-existent project", async () => {
      const result = await projectService.archive("missing");
      expect(result).toBe(false);
    });
  });

  // ── delete ──

  describe("delete()", () => {
    it("deletes a project and returns true", async () => {
      const project = await projectService.create("To Delete");
      const result = await projectService.delete(project.id);

      expect(result).toBe(true);

      const found = await projectService.get(project.id);
      expect(found).toBeNull();
    });

    it("returns false for non-existent project", async () => {
      const result = await projectService.delete("missing");
      expect(result).toBe(false);
    });
  });

  // ── project + tasks association ──

  describe("project with tasks", () => {
    it("tasks can reference a project", async () => {
      const project = await projectService.create("Work");
      const task = await taskService.create({
        title: "Do work",
        projectId: project.id,
      });

      expect(task.projectId).toBe(project.id);

      const found = await taskService.get(task.id);
      expect(found!.projectId).toBe(project.id);
    });

    it("tasks can be filtered by projectId", async () => {
      const projA = await projectService.create("Project A");
      const projB = await projectService.create("Project B");

      await taskService.create({ title: "A task", projectId: projA.id });
      await taskService.create({ title: "B task", projectId: projB.id });
      await taskService.create({ title: "No project" });

      const tasksA = await taskService.list({ projectId: projA.id });
      expect(tasksA).toHaveLength(1);
      expect(tasksA[0].title).toBe("A task");
    });
  });
});
