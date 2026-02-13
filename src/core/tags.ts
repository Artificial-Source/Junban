import type { Tag } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { generateId } from "../utils/ids.js";

/** Tag service — manages task labels. */
export class TagService {
  constructor(private queries: IStorage) {}

  async create(name: string, color?: string): Promise<Tag> {
    const tag: Tag = {
      id: generateId(),
      name: name.toLowerCase().trim(),
      color: color ?? "#6b7280",
    };
    this.queries.insertTag(tag);
    return tag;
  }

  async list(): Promise<Tag[]> {
    return this.queries.listTags();
  }

  async getByName(name: string): Promise<Tag | null> {
    const rows = this.queries.getTagByName(name.toLowerCase().trim());
    return rows[0] ?? null;
  }

  async getOrCreate(name: string): Promise<Tag> {
    const existing = await this.getByName(name);
    if (existing) return existing;
    return this.create(name);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.queries.deleteTag(id);
    return result.changes > 0;
  }
}
