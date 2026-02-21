/**
 * Built-in CRUD tools for project management.
 * Registers: create_project, list_projects, get_project, update_project, delete_project
 */

import type { ToolRegistry } from "../registry.js";

export function registerProjectCrudTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "create_project",
      description:
        "Create a new project for organizing tasks. Returns the created project with its ID.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name (required)" },
          color: {
            type: "string",
            description: 'Hex color code for the project (e.g. "#22c55e"). Defaults to blue.',
          },
          icon: {
            type: "string",
            description: 'Emoji icon for the project (e.g. "🚀", "📚"). Optional.',
          },
          parentId: {
            type: "string",
            description: "ID of a parent project to nest this project under. Optional.",
          },
          isFavorite: {
            type: "boolean",
            description: "Pin project to Favorites section in sidebar. Default: false.",
          },
          viewStyle: {
            type: "string",
            enum: ["list", "board", "calendar"],
            description: 'Default view layout for this project. Default: "list".',
          },
        },
        required: ["name"],
      },
    },
    async (args, ctx) => {
      const project = await ctx.projectService.create(args.name as string, {
        color: args.color as string | undefined,
        parentId: (args.parentId as string) || null,
        isFavorite: (args.isFavorite as boolean) || false,
        viewStyle: (args.viewStyle as "list" | "board" | "calendar") || "list",
      });
      if (args.icon) {
        await ctx.projectService.update(project.id, { icon: args.icon as string });
        project.icon = args.icon as string;
      }
      return JSON.stringify({
        success: true,
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          icon: project.icon,
          parentId: project.parentId,
          isFavorite: project.isFavorite,
          viewStyle: project.viewStyle,
          archived: project.archived,
        },
      });
    },
  );

  registry.register(
    {
      name: "list_projects",
      description:
        "List all projects. By default excludes archived projects unless includeArchived is true.",
      parameters: {
        type: "object",
        properties: {
          includeArchived: {
            type: "boolean",
            description: "Include archived projects (default: false)",
          },
        },
      },
    },
    async (args, ctx) => {
      const all = await ctx.projectService.list();
      const includeArchived = (args.includeArchived as boolean) ?? false;
      const projects = includeArchived ? all : all.filter((p) => !p.archived);
      return JSON.stringify({
        count: projects.length,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          icon: p.icon,
          parentId: p.parentId,
          isFavorite: p.isFavorite,
          viewStyle: p.viewStyle,
          archived: p.archived,
        })),
      });
    },
  );

  registry.register(
    {
      name: "get_project",
      description: "Get a single project by ID or name. Provide either projectId or name.",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The project ID to look up",
          },
          name: {
            type: "string",
            description: "The project name to look up",
          },
        },
      },
    },
    async (args, ctx) => {
      let project = null;
      if (args.projectId) {
        project = await ctx.projectService.get(args.projectId as string);
      } else if (args.name) {
        project = await ctx.projectService.getByName(args.name as string);
      } else {
        return JSON.stringify({
          error: "Provide either projectId or name",
        });
      }
      if (!project) {
        return JSON.stringify({ error: "Project not found" });
      }
      return JSON.stringify({
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          icon: project.icon,
          parentId: project.parentId,
          isFavorite: project.isFavorite,
          viewStyle: project.viewStyle,
          archived: project.archived,
          createdAt: project.createdAt,
        },
      });
    },
  );

  registry.register(
    {
      name: "update_project",
      description:
        "Update an existing project. Can change name, color, icon, archived status, parent, favorite, or view style.",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The ID of the project to update",
          },
          name: { type: "string", description: "New project name" },
          color: { type: "string", description: "New hex color code" },
          icon: {
            type: "string",
            description: 'Emoji icon (e.g. "🚀"). Set to empty string to remove.',
          },
          archived: {
            type: "boolean",
            description: "Set to true to archive, false to unarchive",
          },
          parentId: {
            type: "string",
            description: "ID of parent project. Set to empty string to remove parent.",
          },
          isFavorite: {
            type: "boolean",
            description: "Pin/unpin project from Favorites sidebar section.",
          },
          viewStyle: {
            type: "string",
            enum: ["list", "board", "calendar"],
            description: "Default view layout for the project.",
          },
        },
        required: ["projectId"],
      },
    },
    async (args, ctx) => {
      const { projectId, ...updates } = args;
      // Convert empty icon/parentId to null for clearing
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if ((key === "icon" || key === "parentId") && value === "") {
          cleaned[key] = null;
        } else {
          cleaned[key] = value;
        }
      }
      const project = await ctx.projectService.update(
        projectId as string,
        cleaned as Partial<{
          name: string;
          color: string;
          icon: string | null;
          archived: boolean;
          parentId: string | null;
          isFavorite: boolean;
          viewStyle: "list" | "board" | "calendar";
        }>,
      );
      if (!project) {
        return JSON.stringify({ error: "Project not found" });
      }
      return JSON.stringify({
        success: true,
        project: {
          id: project.id,
          name: project.name,
          color: project.color,
          icon: project.icon,
          parentId: project.parentId,
          isFavorite: project.isFavorite,
          viewStyle: project.viewStyle,
          archived: project.archived,
        },
      });
    },
  );

  registry.register(
    {
      name: "delete_project",
      description:
        "Permanently delete a project. Tasks assigned to this project will have their projectId set to null.",
      parameters: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The ID of the project to delete",
          },
        },
        required: ["projectId"],
      },
    },
    async (args, ctx) => {
      const deleted = await ctx.projectService.delete(args.projectId as string);
      return JSON.stringify({ success: true, deleted });
    },
  );
}
