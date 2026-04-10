import { z } from "zod";

export const TaskStatus = z.enum(["pending", "completed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Priority = z.number().int().min(1).max(4).nullable();
export type Priority = z.infer<typeof Priority>;

export const CreateTaskInput = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullable().optional(),
  priority: Priority.optional(),
  dueDate: z.string().datetime().nullable().optional(),
  dueTime: z.boolean().optional().default(false),
  projectId: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  remindAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  estimatedMinutes: z.number().int().min(1).nullable().optional(),
  actualMinutes: z.number().int().min(0).nullable().optional(),
  deadline: z.string().datetime().nullable().optional(),
  isSomeday: z.boolean().optional(),
  sectionId: z.string().nullable().optional(),
  dreadLevel: z.number().int().min(1).max(5).nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = CreateTaskInput.partial().extend({
  status: TaskStatus.optional(),
  completedAt: z.string().datetime().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number | null;
  dueDate: string | null;
  dueTime: boolean;
  completedAt: string | null;
  projectId: string | null;
  recurrence: string | null;
  parentId: string | null;
  remindAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  deadline: string | null;
  isSomeday: boolean;
  sectionId: string | null;
  dreadLevel: number | null;
  tags: Tag[];
  children?: Task[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const RestoreTaskInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: TaskStatus,
  priority: Priority,
  dueDate: z.string().datetime().nullable(),
  dueTime: z.boolean(),
  completedAt: z.string().datetime().nullable(),
  projectId: z.string().nullable(),
  recurrence: z.string().nullable(),
  parentId: z.string().nullable(),
  remindAt: z.string().datetime().nullable(),
  estimatedMinutes: z.number().int().min(1).nullable(),
  actualMinutes: z.number().int().min(0).nullable(),
  deadline: z.string().datetime().nullable(),
  isSomeday: z.boolean(),
  sectionId: z.string().nullable(),
  dreadLevel: z.number().int().min(1).max(5).nullable(),
  tags: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
    }),
  ),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RestoreTaskInput = z.infer<typeof RestoreTaskInput>;

export interface Project {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  parentId: string | null;
  isFavorite: boolean;
  viewStyle: "list" | "board" | "calendar";
  sortOrder: number;
  archived: boolean;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).nullable().optional(),
  parentId: z.string().nullable().optional(),
  isFavorite: z.boolean().optional().default(false),
  viewStyle: z.enum(["list", "board", "calendar"]).optional().default("list"),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = CreateProjectInput.partial();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const CreateTagInput = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(50).optional(),
});
export type CreateTagInput = z.infer<typeof CreateTagInput>;

export const CreateTemplateInput = z.object({
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullable().optional(),
  priority: Priority.optional(),
  tags: z.array(z.string()).optional().default([]),
  projectId: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

export const UpdateTemplateInput = CreateTemplateInput.partial();
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: number | null;
  tags: string[];
  projectId: string | null;
  recurrence: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Section {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  isCollapsed: boolean;
  createdAt: string;
}

export const CreateSectionInput = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
});
export type CreateSectionInput = z.infer<typeof CreateSectionInput>;

export const UpdateSectionInput = z.object({
  name: z.string().min(1).max(200).optional(),
  isCollapsed: z.boolean().optional(),
});
export type UpdateSectionInput = z.infer<typeof UpdateSectionInput>;

export const ReorderInput = z.object({
  orderedIds: z.array(z.string().min(1)).max(500),
});
export type ReorderInput = z.infer<typeof ReorderInput>;

export const CommentContentInput = z.object({
  content: z.string().min(1).max(10000),
});
export type CommentContentInput = z.infer<typeof CommentContentInput>;

export const InstantiateTemplateInput = z.object({
  variables: z.record(z.string(), z.string()).optional(),
});
export type InstantiateTemplateInput = z.infer<typeof InstantiateTemplateInput>;

export interface TaskComment {
  id: string;
  taskId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivity {
  id: string;
  taskId: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface TaskRelation {
  taskId: string;
  relatedTaskId: string;
  type: "blocks";
}

export interface DailyStat {
  id: string;
  date: string;
  tasksCompleted: number;
  tasksCreated: number;
  minutesTracked: number;
  streak: number;
  createdAt: string;
}
