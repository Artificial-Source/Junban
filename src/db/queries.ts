import { eq, desc, inArray, and, lte, isNotNull, min, count } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";

export function createQueries(db: BaseSQLiteDatabase<"sync", any, typeof schema>) {
  return {
    // ── Tasks ────────────────────────────────────────────
    listTasks: () => db.select().from(schema.tasks).all(),

    getTask: (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).all(),

    insertTask: (task: typeof schema.tasks.$inferInsert) =>
      db.insert(schema.tasks).values(task).run(),

    updateTask: (id: string, data: Partial<typeof schema.tasks.$inferInsert>) =>
      db.update(schema.tasks).set(data).where(eq(schema.tasks.id, id)).run(),

    deleteTask: (id: string) => db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run(),

    // ── Batch Task Operations ───────────────────────────
    deleteManyTasks: (ids: string[]) =>
      db.delete(schema.tasks).where(inArray(schema.tasks.id, ids)).run(),

    updateManyTasks: (ids: string[], data: Partial<typeof schema.tasks.$inferInsert>) =>
      db.update(schema.tasks).set(data).where(inArray(schema.tasks.id, ids)).run(),

    deleteManyTaskTags: (taskIds: string[]) =>
      db.delete(schema.taskTags).where(inArray(schema.taskTags.taskId, taskIds)).run(),

    insertTaskWithId: (task: typeof schema.tasks.$inferInsert) =>
      db.insert(schema.tasks).values(task).run(),

    listTasksDueForReminder: (beforeTime: string) =>
      db
        .select()
        .from(schema.tasks)
        .where(
          and(
            isNotNull(schema.tasks.remindAt),
            lte(schema.tasks.remindAt, beforeTime),
            eq(schema.tasks.status, "pending"),
          ),
        )
        .all(),

    // ── Task Tags (junction) ─────────────────────────────
    getTaskTags: (taskId: string) =>
      db
        .select()
        .from(schema.taskTags)
        .innerJoin(schema.tags, eq(schema.taskTags.tagId, schema.tags.id))
        .where(eq(schema.taskTags.taskId, taskId))
        .all(),

    listAllTaskTags: () =>
      db
        .select()
        .from(schema.taskTags)
        .innerJoin(schema.tags, eq(schema.taskTags.tagId, schema.tags.id))
        .all(),

    insertTaskTag: (taskId: string, tagId: string) =>
      db.insert(schema.taskTags).values({ taskId, tagId }).run(),

    deleteTaskTags: (taskId: string) =>
      db.delete(schema.taskTags).where(eq(schema.taskTags.taskId, taskId)).run(),

    // ── Projects ─────────────────────────────────────────
    listProjects: () => db.select().from(schema.projects).all(),

    getProject: (id: string) =>
      db.select().from(schema.projects).where(eq(schema.projects.id, id)).all(),

    getProjectByName: (name: string) =>
      db.select().from(schema.projects).where(eq(schema.projects.name, name)).all(),

    insertProject: (project: typeof schema.projects.$inferInsert) =>
      db.insert(schema.projects).values(project).run(),

    updateProject: (id: string, data: Partial<typeof schema.projects.$inferInsert>) =>
      db.update(schema.projects).set(data).where(eq(schema.projects.id, id)).run(),

    deleteProject: (id: string) =>
      db.delete(schema.projects).where(eq(schema.projects.id, id)).run(),

    // ── Tags ─────────────────────────────────────────────
    listTags: () => db.select().from(schema.tags).all(),

    getTagByName: (name: string) =>
      db.select().from(schema.tags).where(eq(schema.tags.name, name)).all(),

    insertTag: (tag: typeof schema.tags.$inferInsert) => db.insert(schema.tags).values(tag).run(),

    deleteTag: (id: string) => db.delete(schema.tags).where(eq(schema.tags.id, id)).run(),

    // ── Plugin Settings ─────────────────────────────────
    loadPluginSettings: (pluginId: string) =>
      db
        .select()
        .from(schema.pluginSettings)
        .where(eq(schema.pluginSettings.pluginId, pluginId))
        .get(),

    savePluginSettings: (pluginId: string, settings: string) => {
      const now = new Date().toISOString();
      db.insert(schema.pluginSettings)
        .values({ pluginId, settings, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.pluginSettings.pluginId,
          set: { settings, updatedAt: now },
        })
        .run();
    },

    // ── App Settings ──────────────────────────────────
    getAppSetting: (key: string) =>
      db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get(),

    setAppSetting: (key: string, value: string) => {
      const now = new Date().toISOString();
      db.insert(schema.appSettings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.appSettings.key,
          set: { value, updatedAt: now },
        })
        .run();
    },

    deleteAppSetting: (key: string) =>
      db.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run(),

    // ── Chat Messages ──────────────────────────────────
    listChatMessages: (sessionId: string) =>
      db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.sessionId, sessionId))
        .all(),

    insertChatMessage: (msg: typeof schema.chatMessages.$inferInsert) =>
      db.insert(schema.chatMessages).values(msg).run(),

    deleteChatSession: (sessionId: string) =>
      db.delete(schema.chatMessages).where(eq(schema.chatMessages.sessionId, sessionId)).run(),

    getLatestSessionId: () =>
      db
        .select({ sessionId: schema.chatMessages.sessionId })
        .from(schema.chatMessages)
        .orderBy(desc(schema.chatMessages.id))
        .limit(1)
        .get(),

    listChatSessions: () =>
      db
        .select({
          sessionId: schema.chatMessages.sessionId,
          createdAt: min(schema.chatMessages.createdAt),
          messageCount: count(),
        })
        .from(schema.chatMessages)
        .groupBy(schema.chatMessages.sessionId)
        .orderBy(desc(min(schema.chatMessages.createdAt)))
        .all(),

    getFirstUserMessage: (sessionId: string) =>
      db
        .select({ content: schema.chatMessages.content })
        .from(schema.chatMessages)
        .where(
          and(eq(schema.chatMessages.sessionId, sessionId), eq(schema.chatMessages.role, "user")),
        )
        .limit(1)
        .get(),

    // ── Plugin Permissions ────────────────────────────
    getPluginPermissions: (pluginId: string): string[] | null => {
      const row = db
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.key, `plugin_permissions:${pluginId}`))
        .get();
      return row ? JSON.parse(row.value) : null;
    },

    setPluginPermissions: (pluginId: string, permissions: string[]) => {
      const now = new Date().toISOString();
      db.insert(schema.appSettings)
        .values({
          key: `plugin_permissions:${pluginId}`,
          value: JSON.stringify(permissions),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.appSettings.key,
          set: { value: JSON.stringify(permissions), updatedAt: now },
        })
        .run();
    },

    deletePluginPermissions: (pluginId: string) =>
      db
        .delete(schema.appSettings)
        .where(eq(schema.appSettings.key, `plugin_permissions:${pluginId}`))
        .run(),

    // ── Task Templates ────────────────────────────────
    listTemplates: () => db.select().from(schema.taskTemplates).all(),

    getTemplate: (id: string) =>
      db.select().from(schema.taskTemplates).where(eq(schema.taskTemplates.id, id)).get(),

    insertTemplate: (template: typeof schema.taskTemplates.$inferInsert) =>
      db.insert(schema.taskTemplates).values(template).run(),

    updateTemplate: (id: string, data: Partial<typeof schema.taskTemplates.$inferInsert>) =>
      db.update(schema.taskTemplates).set(data).where(eq(schema.taskTemplates.id, id)).run(),

    deleteTemplate: (id: string) =>
      db.delete(schema.taskTemplates).where(eq(schema.taskTemplates.id, id)).run(),
  };
}

export type Queries = ReturnType<typeof createQueries>;
