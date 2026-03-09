import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status", { enum: ["pending", "completed", "cancelled"] })
    .notNull()
    .default("pending"),
  priority: integer("priority"),
  dueDate: text("due_date"),
  dueTime: integer("due_time", { mode: "boolean" }).default(false),
  completedAt: text("completed_at"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  recurrence: text("recurrence"),
  parentId: text("parent_id").references((): any => tasks.id, { onDelete: "cascade" }),
  remindAt: text("remind_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  estimatedMinutes: integer("estimated_minutes"),
  actualMinutes: integer("actual_minutes"),
  deadline: text("deadline"),
  isSomeday: integer("is_someday", { mode: "boolean" }).notNull().default(false),
  sectionId: text("section_id").references(() => sections.id, { onDelete: "set null" }),
  dreadLevel: integer("dread_level"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#3b82f6"),
  icon: text("icon"),
  parentId: text("parent_id").references((): any => projects.id, { onDelete: "set null" }),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  viewStyle: text("view_style", { enum: ["list", "board", "calendar"] })
    .notNull()
    .default("list"),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#6b7280"),
});

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.tagId] })],
);

export const taskRelations = sqliteTable(
  "task_relations",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    relatedTaskId: text("related_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["blocks"] }).notNull().default("blocks"),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.relatedTaskId] })],
);

export const pluginSettings = sqliteTable("plugin_settings", {
  pluginId: text("plugin_id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskTemplates = sqliteTable("task_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  priority: integer("priority"),
  tags: text("tags"),
  projectId: text("project_id").references(() => projects.id),
  recurrence: text("recurrence"),
  sortOrder: integer("sort_order").default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  toolCallId: text("tool_call_id"),
  toolCalls: text("tool_calls"),
  createdAt: text("created_at").notNull(),
});

export const sections = sqliteTable("sections", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isCollapsed: integer("is_collapsed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const taskComments = sqliteTable("task_comments", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskActivity = sqliteTable("task_activity", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  field: text("field"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: text("created_at").notNull(),
});

export const aiMemories = sqliteTable("ai_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  category: text("category", {
    enum: ["preference", "habit", "context", "instruction", "pattern"],
  })
    .notNull()
    .default("context"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dailyStats = sqliteTable("daily_stats", {
  id: text("id").primaryKey(),
  date: text("date").notNull().unique(),
  tasksCompleted: integer("tasks_completed").notNull().default(0),
  tasksCreated: integer("tasks_created").notNull().default(0),
  minutesTracked: integer("minutes_tracked").notNull().default(0),
  streak: integer("streak").notNull().default(0),
  createdAt: text("created_at").notNull(),
});
