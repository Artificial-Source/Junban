import { useState } from "react";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { StatusSection } from "./task-metadata/StatusSection.js";
import { DateFields } from "./task-metadata/DateFields.js";
import { PriorityDreadSection } from "./task-metadata/PriorityDreadSection.js";
import { TagsSection } from "./task-metadata/TagsSection.js";
import { ReminderRecurrenceSection } from "./task-metadata/ReminderRecurrenceSection.js";
import { DurationSection } from "./task-metadata/DurationSection.js";
import { DeleteAction } from "./task-metadata/DeleteAction.js";

interface TaskMetadataSidebarProps {
  task: Task;
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  availableTags?: string[];
}

export function TaskMetadataSidebar({
  task,
  onUpdate,
  onDelete,
  availableTags = [],
}: TaskMetadataSidebarProps) {
  const { settings } = useGeneralSettings();

  // Reset local state when task changes
  const [trackedTaskId, setTrackedTaskId] = useState(task.id);
  if (task.id !== trackedTaskId) {
    setTrackedTaskId(task.id);
  }

  return (
    <div className="w-full border-t md:w-64 md:border-t-0 md:border-l border-border overflow-auto p-4 md:p-5 space-y-5 flex-shrink-0">
      <StatusSection task={task} onUpdate={onUpdate} />

      <div className="border-t border-border" />

      <DateFields
        task={task}
        onUpdate={onUpdate}
        showDeadline={settings.feature_deadlines !== "false"}
      />

      <div className="border-t border-border" />

      <PriorityDreadSection task={task} onUpdate={onUpdate} />

      <div className="border-t border-border" />

      <TagsSection task={task} onUpdate={onUpdate} availableTags={availableTags} />

      <div className="border-t border-border" />

      <ReminderRecurrenceSection task={task} onUpdate={onUpdate} />

      {settings.feature_duration !== "false" && <DurationSection task={task} onUpdate={onUpdate} />}

      <div className="border-t border-border" />

      <DeleteAction taskId={task.id} onDelete={onDelete} />
    </div>
  );
}
