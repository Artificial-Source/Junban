import { useTaskContext } from "../context/TaskContext.js";
import { useSoundEffect } from "./useSoundEffect.js";

export function useBulkActions(multiSelectedIds: Set<string>, clearSelection: () => void) {
  const { state, completeManyTasks, deleteManyTasks, updateManyTasks, updateTask } =
    useTaskContext();
  const playSound = useSoundEffect();

  const handleBulkComplete = async () => {
    const ids = Array.from(multiSelectedIds);
    await completeManyTasks(ids);
    playSound("complete");
    clearSelection();
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(multiSelectedIds);
    await deleteManyTasks(ids);
    playSound("delete");
    clearSelection();
  };

  const handleBulkMoveToProject = async (projectId: string | null) => {
    const ids = Array.from(multiSelectedIds);
    await updateManyTasks(ids, { projectId });
    clearSelection();
  };

  const handleBulkAddTag = async (tag: string) => {
    // We need to add a tag to existing tasks. Since updateMany replaces tags,
    // we gather existing tags and append the new one
    const ids = Array.from(multiSelectedIds);
    for (const id of ids) {
      const task = state.tasks.find((t) => t.id === id);
      if (task) {
        const existingTags = task.tags.map((t) => t.name);
        if (!existingTags.includes(tag)) {
          await updateTask(id, { tags: [...existingTags, tag] });
        }
      }
    }
    clearSelection();
  };

  return {
    handleBulkComplete,
    handleBulkDelete,
    handleBulkMoveToProject,
    handleBulkAddTag,
  };
}
