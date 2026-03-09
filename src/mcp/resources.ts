/**
 * MCP resource registration.
 * Provides read-only access to Saydo data: tasks, projects, tags, and stats.
 *
 * Static resources:
 *   saydo://tasks/pending, saydo://tasks/today, saydo://tasks/overdue
 *   saydo://projects, saydo://tags, saydo://stats/today
 *
 * Dynamic resource templates:
 *   saydo://tasks/{taskId}, saydo://projects/{projectId}
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppServices } from "../bootstrap.js";

/** Summarize a task for resource responses (drop heavy fields). */
function summarizeTask(t: {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  dueDate: string | null;
  projectId: string | null;
  tags: Array<{ name: string }>;
  estimatedMinutes?: number | null;
}) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    projectId: t.projectId,
    tags: t.tags.map((tag) => tag.name),
    estimatedMinutes: t.estimatedMinutes ?? null,
  };
}

export function registerMcpResources(server: McpServer, services: AppServices): void {
  const { taskService, projectService, tagService, statsService } = services;

  // --- Static resources ---

  server.registerResource(
    "pending_tasks",
    "saydo://tasks/pending",
    { description: "All pending tasks", mimeType: "application/json" },
    async () => {
      const tasks = await taskService.list({ status: "pending" });
      return {
        contents: [
          {
            uri: "saydo://tasks/pending",
            mimeType: "application/json",
            text: JSON.stringify(tasks.map(summarizeTask)),
          },
        ],
      };
    },
  );

  server.registerResource(
    "today_tasks",
    "saydo://tasks/today",
    { description: "Tasks due today (including overdue)", mimeType: "application/json" },
    async () => {
      const today = new Date().toISOString().split("T")[0];
      const pending = await taskService.list({ status: "pending" });
      const todayTasks = pending.filter((t) => t.dueDate && t.dueDate.split("T")[0] <= today);
      return {
        contents: [
          {
            uri: "saydo://tasks/today",
            mimeType: "application/json",
            text: JSON.stringify(todayTasks.map(summarizeTask)),
          },
        ],
      };
    },
  );

  server.registerResource(
    "overdue_tasks",
    "saydo://tasks/overdue",
    { description: "Overdue tasks (due before today)", mimeType: "application/json" },
    async () => {
      const today = new Date().toISOString().split("T")[0];
      const pending = await taskService.list({ status: "pending" });
      const overdue = pending.filter((t) => t.dueDate && t.dueDate.split("T")[0] < today);
      return {
        contents: [
          {
            uri: "saydo://tasks/overdue",
            mimeType: "application/json",
            text: JSON.stringify(overdue.map(summarizeTask)),
          },
        ],
      };
    },
  );

  server.registerResource(
    "all_projects",
    "saydo://projects",
    { description: "All non-archived projects", mimeType: "application/json" },
    async () => {
      const projects = await projectService.list();
      const active = projects.filter((p) => !p.archived);
      return {
        contents: [
          {
            uri: "saydo://projects",
            mimeType: "application/json",
            text: JSON.stringify(active),
          },
        ],
      };
    },
  );

  server.registerResource(
    "all_tags",
    "saydo://tags",
    { description: "All tags", mimeType: "application/json" },
    async () => {
      const tags = await tagService.list();
      return {
        contents: [
          {
            uri: "saydo://tags",
            mimeType: "application/json",
            text: JSON.stringify(tags),
          },
        ],
      };
    },
  );

  server.registerResource(
    "today_stats",
    "saydo://stats/today",
    { description: "Today's productivity stats and current streak", mimeType: "application/json" },
    async () => {
      const todayStat = await statsService.getToday();
      const streak = await statsService.getCurrentStreak();
      return {
        contents: [
          {
            uri: "saydo://stats/today",
            mimeType: "application/json",
            text: JSON.stringify({ ...todayStat, currentStreak: streak }),
          },
        ],
      };
    },
  );

  // --- Dynamic resource templates ---

  server.registerResource(
    "task_detail",
    new ResourceTemplate("saydo://tasks/{taskId}", { list: undefined }),
    { description: "Single task detail by ID", mimeType: "application/json" },
    async (uri, variables) => {
      const taskId = variables.taskId as string;
      const task = await taskService.get(taskId);
      if (!task) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Task not found: ${taskId}` }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(task),
          },
        ],
      };
    },
  );

  server.registerResource(
    "project_detail",
    new ResourceTemplate("saydo://projects/{projectId}", { list: undefined }),
    { description: "Project detail with its tasks", mimeType: "application/json" },
    async (uri, variables) => {
      const projectId = variables.projectId as string;
      const project = await projectService.get(projectId);
      if (!project) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Project not found: ${projectId}` }),
            },
          ],
        };
      }
      const tasks = await taskService.list({ projectId });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              ...project,
              tasks: tasks.map(summarizeTask),
            }),
          },
        ],
      };
    },
  );
}
