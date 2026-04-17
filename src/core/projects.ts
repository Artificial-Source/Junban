import type { Project } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { generateId } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("projects");

/** Project service — manages task groupings. */
export class ProjectService {
  constructor(private queries: IStorage) {}

  async create(
    name: string,
    opts?: {
      color?: string;
      parentId?: string | null;
      isFavorite?: boolean;
      viewStyle?: "list" | "board" | "calendar";
    },
  ): Promise<Project> {
    const project: Project = {
      id: generateId(),
      name,
      color: opts?.color ?? "#3b82f6",
      icon: null,
      parentId: opts?.parentId ?? null,
      isFavorite: opts?.isFavorite ?? false,
      viewStyle: opts?.viewStyle ?? "list",
      sortOrder: 0,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    this.queries.insertProject(project);
    logger.debug("Project created", { id: project.id, name });
    return project;
  }

  async list(): Promise<Project[]> {
    return this.queries.listProjects();
  }

  async get(id: string): Promise<Project | null> {
    const rows = this.queries.getProject(id);
    return rows[0] ?? null;
  }

  async getByName(name: string): Promise<Project | null> {
    const rows = this.queries.getProjectByName(name);
    return rows[0] ?? null;
  }

  async getOrCreate(name: string): Promise<Project> {
    const existing = await this.getByName(name);
    if (existing) return existing;
    return this.create(name);
  }

  async update(
    id: string,
    data: Partial<
      Pick<
        Project,
        "name" | "color" | "icon" | "archived" | "parentId" | "isFavorite" | "viewStyle"
      >
    >,
  ): Promise<Project | null> {
    const result = this.queries.updateProject(id, data);
    if (result.changes === 0) return null;
    logger.debug("Project updated", { id, fields: Object.keys(data) });
    return this.get(id);
  }

  async archive(id: string): Promise<boolean> {
    const result = this.queries.updateProject(id, { archived: true });
    if (result.changes > 0) logger.debug("Project archived", { id });
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    // Keep tasks, but move them out of the deleted project and clear any section linkage.
    const tasks = this.queries.listTasks();
    for (const task of tasks) {
      if (task.projectId === id) {
        this.queries.updateTask(task.id, {
          projectId: null,
          sectionId: null,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // Promote child projects to the top level instead of deleting them.
    const projects = this.queries.listProjects();
    for (const project of projects) {
      if (project.parentId === id) {
        this.queries.updateProject(project.id, { parentId: null });
      }
    }

    // Delete project sections after clearing task section links.
    const sections = this.queries.listSections(id);
    for (const section of sections) {
      this.queries.deleteSection(section.id);
    }

    const result = this.queries.deleteProject(id);
    if (result.changes > 0) logger.debug("Project deleted", { id });
    return result.changes > 0;
  }
}
