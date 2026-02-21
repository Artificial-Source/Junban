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
