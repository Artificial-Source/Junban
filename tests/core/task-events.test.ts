import { describe, it, expect, vi } from "vitest";
import { createTestServices } from "../integration/helpers.js";

describe("Task event bus — task:moved and task:estimated", () => {
  it("should emit task:moved when projectId changes", async () => {
    const { taskService, projectService, eventBus } = createTestServices();
    const projA = await projectService.create("Project A");
    const projB = await projectService.create("Project B");
    const listener = vi.fn();
    eventBus.on("task:moved", listener);

    const task = await taskService.create({
      title: "Move me",
      dueTime: false,
      projectId: projA.id,
    });

    await taskService.update(task.id, { projectId: projB.id });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectId: projB.id }),
      fromProjectId: projA.id,
      toProjectId: projB.id,
    });
  });

  it("should emit task:moved when moving to no project", async () => {
    const { taskService, projectService, eventBus } = createTestServices();
    const projA = await projectService.create("Project A");
    const listener = vi.fn();
    eventBus.on("task:moved", listener);

    const task = await taskService.create({
      title: "Unproject me",
      dueTime: false,
      projectId: projA.id,
    });

    await taskService.update(task.id, { projectId: null });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      task: expect.objectContaining({ projectId: null }),
      fromProjectId: projA.id,
      toProjectId: null,
    });
  });

  it("should not emit task:moved when projectId is unchanged", async () => {
    const { taskService, projectService, eventBus } = createTestServices();
    const projA = await projectService.create("Project A");
    const listener = vi.fn();
    eventBus.on("task:moved", listener);

    const task = await taskService.create({
      title: "Stay put",
      dueTime: false,
      projectId: projA.id,
    });

    await taskService.update(task.id, { title: "Stay put renamed" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("should emit task:estimated when estimatedMinutes changes", async () => {
    const { taskService, eventBus } = createTestServices();
    const listener = vi.fn();
    eventBus.on("task:estimated", listener);

    const task = await taskService.create({
      title: "Estimate me",
      dueTime: false,
    });

    await taskService.update(task.id, { estimatedMinutes: 30 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      task: expect.objectContaining({ estimatedMinutes: 30 }),
      previousMinutes: null,
      newMinutes: 30,
    });
  });

  it("should emit task:estimated when estimate changes from one value to another", async () => {
    const { taskService, eventBus } = createTestServices();
    const listener = vi.fn();
    eventBus.on("task:estimated", listener);

    const task = await taskService.create({
      title: "Re-estimate me",
      dueTime: false,
      estimatedMinutes: 30,
    });

    await taskService.update(task.id, { estimatedMinutes: 60 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      task: expect.objectContaining({ estimatedMinutes: 60 }),
      previousMinutes: 30,
      newMinutes: 60,
    });
  });

  it("should not emit task:estimated when estimatedMinutes is not in update", async () => {
    const { taskService, eventBus } = createTestServices();
    const listener = vi.fn();
    eventBus.on("task:estimated", listener);

    const task = await taskService.create({
      title: "No estimate change",
      dueTime: false,
      estimatedMinutes: 30,
    });

    await taskService.update(task.id, { title: "Renamed" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("should emit both task:update and task:moved on project change", async () => {
    const { taskService, projectService, eventBus } = createTestServices();
    const projA = await projectService.create("Project A");
    const projB = await projectService.create("Project B");
    const updateListener = vi.fn();
    const movedListener = vi.fn();
    eventBus.on("task:update", updateListener);
    eventBus.on("task:moved", movedListener);

    const task = await taskService.create({
      title: "Both events",
      dueTime: false,
      projectId: projA.id,
    });

    await taskService.update(task.id, { projectId: projB.id });

    expect(updateListener).toHaveBeenCalledOnce();
    expect(movedListener).toHaveBeenCalledOnce();
  });

  it("should emit both task:update and task:estimated on estimate change", async () => {
    const { taskService, eventBus } = createTestServices();
    const updateListener = vi.fn();
    const estimatedListener = vi.fn();
    eventBus.on("task:update", updateListener);
    eventBus.on("task:estimated", estimatedListener);

    const task = await taskService.create({
      title: "Both events",
      dueTime: false,
    });

    await taskService.update(task.id, { estimatedMinutes: 45 });

    expect(updateListener).toHaveBeenCalledOnce();
    expect(estimatedListener).toHaveBeenCalledOnce();
  });
});
