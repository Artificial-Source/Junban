import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Inbox, Pencil } from "lucide-react";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { TaskMetadataSidebar } from "../components/TaskMetadataSidebar.js";
import { SubtaskSection } from "../components/SubtaskSection.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { MarkdownMessage } from "../components/chat/MarkdownMessage.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

interface TaskPageProps {
  task: Task;
  allTasks: Task[];
  projects: { id: string; name: string }[];
  onUpdate: (id: string, input: UpdateTaskInput) => void;
  onDelete: (id: string) => void;
  onNavigateBack: () => void;
  onSelect: (id: string) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onToggleSubtask?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  availableTags?: string[];
}

export function TaskPage({
  task,
  allTasks,
  projects,
  onUpdate,
  onDelete,
  onNavigateBack,
  onSelect,
  onAddSubtask,
  onToggleSubtask,
  onReorder,
  availableTags = [],
}: TaskPageProps) {
  const { settings } = useGeneralSettings();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);

  // Subtask inline edit state
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState("");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [focusedSubtaskIdx, setFocusedSubtaskIdx] = useState(-1);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setEditingDescription(false);
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
    setFocusedSubtaskIdx(-1);
  }, [task]);

  const handleTitleBlur = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdate(task.id, { title: trimmed });
    }
  };

  const handleDescriptionBlur = () => {
    const newDesc = description || null;
    if (newDesc !== task.description) {
      onUpdate(task.id, { description: newDesc });
    }
  };

  const handleStartEdit = useCallback((child: Task) => {
    setEditingSubtaskId(child.id);
    setEditingSubtaskTitle(child.title);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editingSubtaskId) {
      const trimmed = editingSubtaskTitle.trim();
      const original = allTasks.find((t) => t.id === editingSubtaskId);
      if (trimmed && original && trimmed !== original.title) {
        onUpdate(editingSubtaskId, { title: trimmed });
      }
      setEditingSubtaskId(null);
      setEditingSubtaskTitle("");
    }
  }, [editingSubtaskId, editingSubtaskTitle, allTasks, onUpdate]);

  const handleCancelEdit = useCallback(() => {
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
  }, []);

  const handleDelete = () => {
    if (settings.confirm_delete === "true") {
      setConfirmDeleteOpen(true);
      return;
    }
    onDelete(task.id);
    onNavigateBack();
  };

  // Breadcrumb label
  const projectName = task.projectId
    ? (projects.find((p) => p.id === task.projectId)?.name ?? "Project")
    : "Inbox";

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: back button + breadcrumb */}
      <div className="flex items-center gap-2 pb-4 border-b border-border mb-4">
        <button
          onClick={onNavigateBack}
          className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary transition-colors"
          title="Go back"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm text-on-surface-muted flex items-center gap-1.5">
          <Inbox size={14} />
          {projectName}
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden gap-4 md:gap-6">
        {/* Left column — main content */}
        <div className="flex-1 overflow-auto space-y-4">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            className="w-full text-2xl font-bold bg-transparent border-none focus:outline-none focus:ring-0 text-on-surface"
          />

          {/* Description with markdown preview / edit toggle */}
          <div className="relative group/desc">
            {editingDescription ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  handleDescriptionBlur();
                  setEditingDescription(false);
                }}
                autoFocus
                placeholder="Add a description... (supports **markdown**)"
                className="w-full p-0 text-sm bg-transparent border-none text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-0 min-h-[120px] resize-none"
              />
            ) : description ? (
              <div
                className="text-sm text-on-surface cursor-text min-h-[120px] prose-sm"
                onClick={() => setEditingDescription(true)}
              >
                <MarkdownMessage content={description} />
              </div>
            ) : (
              <button
                onClick={() => setEditingDescription(true)}
                className="w-full text-left text-sm text-on-surface-muted/50 min-h-[120px]"
              >
                Add a description...
              </button>
            )}
            {!editingDescription && description && (
              <button
                onClick={() => setEditingDescription(true)}
                className="absolute top-0 right-0 p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-tertiary opacity-0 group-hover/desc:opacity-100 transition-opacity"
                title="Edit description"
              >
                <Pencil size={14} />
              </button>
            )}
          </div>

          <SubtaskSection
            task={task}
            allTasks={allTasks}
            editingSubtaskId={editingSubtaskId}
            editingSubtaskTitle={editingSubtaskTitle}
            focusedSubtaskIdx={focusedSubtaskIdx}
            onEditTitleChange={setEditingSubtaskTitle}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={handleCancelEdit}
            onToggle={onToggleSubtask}
            onSelect={onSelect}
            onAddSubtask={onAddSubtask}
            onReorder={onReorder}
            onFocusedIdxChange={setFocusedSubtaskIdx}
          />
        </div>

        {/* Right column — metadata sidebar */}
        <TaskMetadataSidebar
          task={task}
          onUpdate={onUpdate}
          onDelete={handleDelete}
          availableTags={availableTags}
        />
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete task"
        message="This task will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          onDelete(task.id);
          onNavigateBack();
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
