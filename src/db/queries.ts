import { eq, desc, inArray, and, or, lte, gte, isNotNull, min, count } from "drizzle-orm";
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

    // ── Sections ────────────────────────────────────
    listSections: (projectId: string) =>
      db.select().from(schema.sections).where(eq(schema.sections.projectId, projectId)).all(),

    getSection: (id: string) =>
      db.select().from(schema.sections).where(eq(schema.sections.id, id)).get(),

    insertSection: (section: typeof schema.sections.$inferInsert) =>
      db.insert(schema.sections).values(section).run(),

    updateSection: (id: string, data: Partial<typeof schema.sections.$inferInsert>) =>
      db.update(schema.sections).set(data).where(eq(schema.sections.id, id)).run(),

    deleteSection: (id: string) =>
      db.delete(schema.sections).where(eq(schema.sections.id, id)).run(),

    // ── Task Comments ──────────────────────────────
    listTaskComments: (taskId: string) =>
      db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId)).all(),

    insertTaskComment: (comment: typeof schema.taskComments.$inferInsert) =>
      db.insert(schema.taskComments).values(comment).run(),

    updateTaskComment: (id: string, data: Partial<typeof schema.taskComments.$inferInsert>) =>
      db.update(schema.taskComments).set(data).where(eq(schema.taskComments.id, id)).run(),

    deleteTaskComment: (id: string) =>
      db.delete(schema.taskComments).where(eq(schema.taskComments.id, id)).run(),

    // ── Task Activity ──────────────────────────────
    listTaskActivity: (taskId: string) =>
      db.select().from(schema.taskActivity).where(eq(schema.taskActivity.taskId, taskId)).all(),

    insertTaskActivity: (activity: typeof schema.taskActivity.$inferInsert) =>
      db.insert(schema.taskActivity).values(activity).run(),

    // ── Daily Stats ────────────────────────────────
    getDailyStat: (date: string) =>
      db.select().from(schema.dailyStats).where(eq(schema.dailyStats.date, date)).get(),

    upsertDailyStat: (stat: typeof schema.dailyStats.$inferInsert) => {
      db.insert(schema.dailyStats)
        .values(stat)
        .onConflictDoUpdate({
          target: schema.dailyStats.date,
          set: {
            tasksCompleted: stat.tasksCompleted,
            tasksCreated: stat.tasksCreated,
            minutesTracked: stat.minutesTracked,
            streak: stat.streak,
          },
        })
        .run();
      return { changes: 1 };
    },

    listDailyStats: (startDate: string, endDate: string) =>
      db
        .select()
        .from(schema.dailyStats)
        .where(and(gte(schema.dailyStats.date, startDate), lte(schema.dailyStats.date, endDate)))
        .all(),

    // ── Task Relations ────────────────────────────────
    listTaskRelations: () => db.select().from(schema.taskRelations).all(),

    getTaskRelations: (taskId: string) =>
      db
        .select()
        .from(schema.taskRelations)
        .where(
          or(
            eq(schema.taskRelations.taskId, taskId),
            eq(schema.taskRelations.relatedTaskId, taskId),
          ),
        )
        .all(),

    insertTaskRelation: (relation: typeof schema.taskRelations.$inferInsert) =>
      db.insert(schema.taskRelations).values(relation).run(),

    deleteTaskRelation: (taskId: string, relatedTaskId: string) =>
      db
        .delete(schema.taskRelations)
        .where(
          and(
            eq(schema.taskRelations.taskId, taskId),
            eq(schema.taskRelations.relatedTaskId, relatedTaskId),
          ),
        )
        .run(),

    deleteAllTaskRelations: (taskId: string) =>
      db
        .delete(schema.taskRelations)
        .where(
          or(
            eq(schema.taskRelations.taskId, taskId),
            eq(schema.taskRelations.relatedTaskId, taskId),
          ),
        )
        .run(),

    // ── AI Memories ────────────────────────────────
    listAiMemories: () => db.select().from(schema.aiMemories).all(),

    insertAiMemory: (memory: typeof schema.aiMemories.$inferInsert) =>
      db.insert(schema.aiMemories).values(memory).run(),

    updateAiMemory: (
      id: string,
      content: string,
      category: "preference" | "habit" | "context" | "instruction" | "pattern",
    ) =>
      db
        .update(schema.aiMemories)
        .set({ content, category, updatedAt: new Date().toISOString() })
        .where(eq(schema.aiMemories.id, id))
        .run(),

    deleteAiMemory: (id: string) =>
      db.delete(schema.aiMemories).where(eq(schema.aiMemories.id, id)).run(),
  };
}

export type Queries = ReturnType<typeof createQueries>;
