import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Check, X } from "lucide-react";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { Board } from "./Board.js";
import type { Task, Project as ProjectType, Section } from "../../core/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

interface ProjectProps {
  project: ProjectType;
  tasks: Task[];
  onCreateTask: (parsed: {
    title: string;
    priority: number | null;
    tags: string[];
    project: string | null;
    dueDate: Date | null;
    dueTime: boolean;
  }) => void;
  onToggleTask: (id: string) => void;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: (
    id: string,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onReorder?: (orderedIds: string[]) => void;
  onAddSubtask?: (parentId: string, title: string) => void;
  onUpdateDueDate?: (taskId: string, dueDate: string | null) => void;
  autoFocusTrigger?: number;
  sections?: Section[];
  onCreateSection?: (name: string) => void;
  onUpdateSection?: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  onDeleteSection?: (id: string) => void;
  onMoveTask?: (taskId: string, sectionId: string | null) => void;
  viewStyle?: "list" | "board" | "calendar";
}

/** Inline section name editor (used for renaming). */
function SectionNameEditor({
  initialName,
  onSave,
  onCancel,
}: {
  initialName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialName) {
      onSave(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={handleSubmit}
        className="text-sm font-semibold text-on-surface bg-transparent border-b-2 border-accent outline-none px-0 py-0.5 w-40"
        maxLength={200}
      />
    </div>
  );
}

/** Section header with collapse toggle, editable name, and delete. */
function SectionHeader({
  section,
  taskCount,
  onUpdate,
  onDelete,
}: {
  section: Section;
  taskCount: number;
  onUpdate: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  onDelete: (id: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="group flex items-center gap-2 py-2 px-1 mt-4 first:mt-0 border-b border-border/50">
      {/* Collapse/expand toggle */}
      <button
        onClick={() => onUpdate(section.id, { isCollapsed: !section.isCollapsed })}
        aria-label={section.isCollapsed ? "Expand section" : "Collapse section"}
        className="text-on-surface-muted hover:text-on-surface transition-colors flex-shrink-0"
      >
        {section.isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      </button>

      {/* Section name (click to edit) */}
      {isEditing ? (
        <SectionNameEditor
          initialName={section.name}
          onSave={(name) => {
            onUpdate(section.id, { name });
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      ) : (
        <button
          onClick={() => setIsEditing(true)}
          className="text-sm font-semibold text-on-surface hover:text-accent transition-colors text-left"
        >
          {section.name}
        </button>
      )}

      {/* Task count */}
      <span className="text-xs text-on-surface-muted">{taskCount}</span>

      {/* Delete button (visible on hover) */}
      <button
        onClick={() => onDelete(section.id)}
        aria-label={`Delete section ${section.name}`}
        className="ml-auto text-on-surface-muted hover:text-error opacity-0 group-hover:opacity-100 transition-all duration-150 p-1 rounded hover:bg-error/10"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/** "Add section" button at the bottom of the project. */
function AddSectionButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding) {
      inputRef.current?.focus();
    }
  }, [isAdding]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onCreate(trimmed);
      setName("");
      setIsAdding(false);
    }
  };

  const handleCancel = () => {
    setName("");
    setIsAdding(false);
  };

  if (!isAdding) {
    return (
      <button
        onClick={() => setIsAdding(true)}
        className="flex items-center gap-1.5 text-sm text-on-surface-muted hover:text-accent transition-colors mt-4 py-2 px-1"
      >
        <Plus size={16} />
        Add section
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-4 py-2 px-1">
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") handleCancel();
        }}
        placeholder="Section name..."
        className="text-sm bg-transparent border-b-2 border-accent outline-none px-0 py-0.5 text-on-surface placeholder-on-surface-muted/50 w-48"
        maxLength={200}
      />
      <button
        onClick={handleSubmit}
        aria-label="Confirm add section"
        className="p-1 rounded text-accent hover:bg-accent/10 transition-colors"
      >
        <Check size={16} />
      </button>
      <button
        onClick={handleCancel}
        aria-label="Cancel add section"
        className="p-1 rounded text-on-surface-muted hover:bg-surface-tertiary transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function Project({
  project,
  tasks,
  onCreateTask,
  onToggleTask,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  onReorder,
  onAddSubtask,
  onUpdateDueDate,
  autoFocusTrigger,
  sections,
  onCreateSection,
  onUpdateSection,
  onDeleteSection,
  onMoveTask,
  viewStyle,
}: ProjectProps) {
  const { settings } = useGeneralSettings();
  const sectionsEnabled = settings.feature_sections !== "false";
  const kanbanEnabled = settings.feature_kanban !== "false";

  const projectTasks = tasks.filter((t) => t.status === "pending" && t.projectId === project.id);
  const rawViewStyle = viewStyle ?? project.viewStyle ?? "list";
  const effectiveViewStyle = !kanbanEnabled && rawViewStyle === "board" ? "list" : rawViewStyle;
  const hasSections = sectionsEnabled && sections && sections.length > 0;
  const sortedSections = sections ? [...sections].sort((a, b) => a.sortOrder - b.sortOrder) : [];

  // ── Board view ──
  if (effectiveViewStyle === "board" && sections && onMoveTask) {
    return (
      <div>
        {/* Project header */}
        <div className="flex items-center gap-3 mb-4 md:mb-6">
          {project.icon ? (
            <span className="text-2xl leading-none flex-shrink-0">{project.icon}</span>
          ) : (
            <div
              className="w-4 h-4 rounded-full flex-shrink-0"
              style={{ backgroundColor: project.color }}
            />
          )}
          <h1 className="text-xl md:text-2xl font-bold text-on-surface">{project.name}</h1>
          <span className="text-sm text-on-surface-muted">
            {projectTasks.length} {projectTasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <TaskInput
          onSubmit={onCreateTask}
          placeholder={`Add a task to ${project.name}...`}
          autoFocusTrigger={autoFocusTrigger}
        />
        <div className="mt-4">
          <Board
            project={project}
            tasks={projectTasks}
            sections={sortedSections}
            onMoveTask={onMoveTask}
            onToggleTask={onToggleTask}
            onSelectTask={onSelectTask}
            selectedTaskId={selectedTaskId}
          />
        </div>
        {/* Add section button below the board */}
        {sectionsEnabled && onCreateSection && <AddSectionButton onCreate={onCreateSection} />}
      </div>
    );
  }

  // ── List view (with optional section grouping) ──

  // Group tasks by section for sectioned list view
  const noSectionTasks = projectTasks.filter((t) => t.sectionId === null);
  const tasksBySection = new Map<string, Task[]>();
  for (const section of sortedSections) {
    tasksBySection.set(
      section.id,
      projectTasks.filter((t) => t.sectionId === section.id),
    );
  }

  return (
    <div>
      {/* Project header */}
      <div className="flex items-center gap-3 mb-4 md:mb-6">
        {project.icon ? (
          <span className="text-2xl leading-none flex-shrink-0">{project.icon}</span>
        ) : (
          <div
            className="w-4 h-4 rounded-full flex-shrink-0"
            style={{ backgroundColor: project.color }}
          />
        )}
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">{project.name}</h1>
        <span className="text-sm text-on-surface-muted">
          {projectTasks.length} {projectTasks.length === 1 ? "task" : "tasks"}
        </span>
      </div>
      <TaskInput
        onSubmit={onCreateTask}
        placeholder={`Add a task to ${project.name}...`}
        autoFocusTrigger={autoFocusTrigger}
      />

      {/* If no sections, render the classic flat list */}
      {!hasSections && (
        <TaskList
          tasks={projectTasks}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          emptyMessage="No tasks in this project yet."
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          onReorder={onReorder}
          onAddSubtask={onAddSubtask}
          onUpdateDueDate={onUpdateDueDate}
        />
      )}

      {/* Sectioned list view */}
      {hasSections && (
        <div>
          {/* "No section" group */}
          {noSectionTasks.length > 0 && (
            <div>
              <div className="flex items-center gap-2 py-2 px-1 border-b border-border/50">
                <span className="text-sm font-semibold text-on-surface-muted">No section</span>
                <span className="text-xs text-on-surface-muted">{noSectionTasks.length}</span>
              </div>
              <TaskList
                tasks={noSectionTasks}
                onToggle={onToggleTask}
                onSelect={onSelectTask}
                selectedTaskId={selectedTaskId}
                emptyMessage=""
                selectedTaskIds={selectedTaskIds}
                onMultiSelect={onMultiSelect}
                onReorder={onReorder}
                onAddSubtask={onAddSubtask}
                onUpdateDueDate={onUpdateDueDate}
              />
            </div>
          )}

          {/* Section groups */}
          {sortedSections.map((section) => {
            const sectionTasks = tasksBySection.get(section.id) ?? [];
            return (
              <div key={section.id}>
                {onUpdateSection && onDeleteSection && (
                  <SectionHeader
                    section={section}
                    taskCount={sectionTasks.length}
                    onUpdate={onUpdateSection}
                    onDelete={onDeleteSection}
                  />
                )}
                {!section.isCollapsed && (
                  <TaskList
                    tasks={sectionTasks}
                    onToggle={onToggleTask}
                    onSelect={onSelectTask}
                    selectedTaskId={selectedTaskId}
                    emptyMessage="No tasks in this section."
                    selectedTaskIds={selectedTaskIds}
                    onMultiSelect={onMultiSelect}
                    onReorder={onReorder}
                    onAddSubtask={onAddSubtask}
                    onUpdateDueDate={onUpdateDueDate}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add section button */}
      {sectionsEnabled && onCreateSection && <AddSectionButton onCreate={onCreateSection} />}
    </div>
  );
}
