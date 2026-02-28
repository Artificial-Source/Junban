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
  tags: Tag[];
  children?: Task[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

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
