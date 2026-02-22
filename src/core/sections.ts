import type { Section, CreateSectionInput } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import type { EventBus } from "./event-bus.js";
import { generateId } from "../utils/ids.js";
import { NotFoundError } from "./errors.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("sections");

/**
 * Section service — manages project sections (groups of tasks within a project).
 * Sections allow users to organize tasks in a project into logical groups
 * (e.g., "To Do", "In Progress", "Done" for board view).
 */
export class SectionService {
  constructor(
    private queries: IStorage,
    // Accepted for future section events (EventMap currently only has task:* events)
    private eventBus?: EventBus,
  ) {
    void this.eventBus;
  }

  /** Create a new section within a project. */
  async create(input: CreateSectionInput): Promise<Section> {
    const now = new Date().toISOString();
    const id = generateId();

    // Determine sort order — append to end of existing sections
    const existing = this.queries.listSections(input.projectId);
    const maxOrder = existing.reduce((max, s) => Math.max(max, s.sortOrder), -1);

    const section: Section = {
      id,
      projectId: input.projectId,
      name: input.name,
      sortOrder: maxOrder + 1,
      isCollapsed: false,
      createdAt: now,
    };

    this.queries.insertSection(section);
    logger.debug("Section created", { id, name: input.name, projectId: input.projectId });

    return section;
  }

  /** List all sections for a project, ordered by sortOrder. */
  async list(projectId: string): Promise<Section[]> {
    const rows = this.queries.listSections(projectId);
    return rows.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** Get a section by ID. */
  async get(id: string): Promise<Section | null> {
    const row = this.queries.getSection(id);
    return row ?? null;
  }

  /** Update a section's mutable fields (name, isCollapsed). */
  async update(id: string, data: Partial<Pick<Section, "name" | "isCollapsed">>): Promise<Section> {
    const existing = this.queries.getSection(id);
    if (!existing) throw new NotFoundError("Section", id);

    this.queries.updateSection(id, data);
    logger.debug("Section updated", { id, fields: Object.keys(data) });

    const updated = this.queries.getSection(id);
    return updated!;
  }

  /** Delete a section. Tasks in this section will have their sectionId cleared. */
  async delete(id: string): Promise<boolean> {
    const existing = this.queries.getSection(id);
    if (!existing) return false;

    // Clear sectionId on tasks that belong to this section
    const tasks = this.queries.listTasks();
    for (const task of tasks) {
      if (task.sectionId === id) {
        this.queries.updateTask(task.id, { sectionId: null });
      }
    }

    const result = this.queries.deleteSection(id);
    const deleted = result.changes > 0;

    if (deleted) {
      logger.debug("Section deleted", { id, projectId: existing.projectId });
    }

    return deleted;
  }

  /**
   * Reorder sections by assigning sequential sort orders.
   * @param orderedIds - Section IDs in the desired order.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    for (let i = 0; i < orderedIds.length; i++) {
      this.queries.updateSection(orderedIds[i], { sortOrder: i });
    }
    logger.debug("Sections reordered", { count: orderedIds.length });
  }
}
