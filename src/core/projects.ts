import type { Project } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { generateId } from "../utils/ids.js";

/** Project service — manages task groupings. */
export class ProjectService {
  constructor(private queries: IStorage) {}

  async create(name: string, color?: string): Promise<Project> {
    const project = {
      id: generateId(),
      name,
      color: color ?? "#3b82f6",
      icon: null,
      sortOrder: 0,
      archived: false,
      createdAt: new Date().toISOString(),
    };
    this.queries.insertProject(project);
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

  async archive(id: string): Promise<boolean> {
    const result = this.queries.updateProject(id, { archived: true });
    return result.changes > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.queries.deleteProject(id);
    return result.changes > 0;
  }
}
