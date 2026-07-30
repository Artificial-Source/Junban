/**
 * Project view: list or board layout with sections.
 * Preserves the legacy project header, section chrome, and task input.
 * Calendar style is absent until Phase 3.
 */
import { useMemo, useState } from "react";
import { TaskInput } from "../components/TaskInput";
import { TaskList } from "../components/TaskList";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useViewTasks } from "../hooks/useViewTasks";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useCatalogMutations } from "../hooks/useCatalogMutations";
import { useHierarchyActions } from "../hooks/useHierarchyActions";
import { useWorkspace } from "../context/WorkspaceContext";
import { useToday } from "../hooks/useToday";
import type { ProjectDto, SectionDto, TagDto, TaskDto } from "../api/client";
import { Board } from "./Board";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";

type MultiSelectHandler = (
  id: string,
  event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  orderedIds: string[],
) => void;

interface ProjectProps {
  project: ProjectDto;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: MultiSelectHandler;
  autoFocusTrigger?: number;
  onToggleTask: (id: string) => Promise<boolean>;
}

export function Project({
  project,
  onSelectTask,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  autoFocusTrigger,
  onToggleTask,
}: ProjectProps) {
  const today = useToday();
  const { catalog } = useWorkspace();
  const { parseQuickEntry, createFromQuickEntry, moveTask, reorderTasks } = useTaskMutations();
  const { createSection, patchSection, deleteSection } = useCatalogMutations();
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [sectionPending, setSectionPending] = useState(false);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<SectionDto | null>(null);

  const sections = useMemo(
    () =>
      (catalog?.sections ?? [])
        .filter((s) => s.project_id === project.id)
        .sort((a, b) => a.sort_order - b.sort_order),
    [catalog, project.id],
  );

  const tagMap = useMemo(() => {
    const map = new Map<string, TagDto>();
    for (const tag of catalog?.tags ?? []) map.set(tag.id, tag);
    return map;
  }, [catalog]);

  const { tasks, loading, error, reload } = useViewTasks({
    view: "project",
    project_id: project.id,
    limit: 100,
  });

  const projectTasks = useMemo(() => tasks.filter((t) => t.status === "pending"), [tasks]);
  const { indent, outdent } = useHierarchyActions(projectTasks);

  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === "completed").length,
    [tasks],
  );

  const totalForProgress = projectTasks.length + completedCount;
  const isBoard = project.view === "board";

  const handleParseAndCreate = async (input: string): Promise<boolean> => {
    const parsed = await parseQuickEntry(input);
    const result = await createFromQuickEntry(parsed, { project_id: project.id });
    if (!result) {
      throw new Error("The task could not be created.");
    }
    return true;
  };

  const handleCreateSection = async () => {
    const name = sectionName.trim();
    if (!name || sectionPending) return;
    setSectionPending(true);
    try {
      const result = await createSection({ name, project_id: project.id });
      if (result) {
        setSectionName("");
        setAddingSection(false);
      }
    } finally {
      setSectionPending(false);
    }
  };

  const handleDeleteSectionConfirmed = async () => {
    if (!deleteSectionTarget || sectionPending) return;
    setSectionPending(true);
    try {
      await deleteSection(deleteSectionTarget.id);
      setDeleteSectionTarget(null);
    } finally {
      setSectionPending(false);
    }
  };

  const projectName = () => project.name;
  const projectColor = () => project.color;

  if (loading) {
    return (
      <div>
        <ProjectHeader project={project} taskCount={0} completedCount={0} totalForProgress={0} />
        <p className="mt-4 text-sm text-on-surface-muted" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-4">
        <p className="text-sm font-medium text-error">Could not load project: {error}</p>
        <button
          onClick={reload}
          className="mt-2 rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action"
        >
          Retry
        </button>
      </div>
    );
  }

  // Board view
  if (isBoard && sections.length > 0) {
    return (
      <div>
        <ProjectHeader
          project={project}
          taskCount={projectTasks.length}
          completedCount={completedCount}
          totalForProgress={totalForProgress}
        />
        <TaskInput
          onParseAndCreate={handleParseAndCreate}
          placeholder={`Add a task to ${project.name}...`}
          autoFocusTrigger={autoFocusTrigger}
        />
        <div className="mt-4">
          <Board
            project={project}
            tasks={projectTasks}
            sections={sections}
            onMoveTask={async (taskId, sectionId) => {
              const result = await moveTask(taskId, { section_id: sectionId, order: "keep" });
              return result !== null;
            }}
            onToggleTask={onToggleTask}
            onSelectTask={onSelectTask}
            selectedTaskId={selectedTaskId}
            tagMap={tagMap}
          />
        </div>
        <AddSectionControl
          adding={addingSection}
          name={sectionName}
          pending={sectionPending}
          onStart={() => setAddingSection(true)}
          onNameChange={setSectionName}
          onSubmit={() => void handleCreateSection()}
          onCancel={() => {
            setAddingSection(false);
            setSectionName("");
          }}
        />
      </div>
    );
  }

  // List view with sections
  return (
    <div>
      <ProjectHeader
        project={project}
        taskCount={projectTasks.length}
        completedCount={completedCount}
        totalForProgress={totalForProgress}
      />
      <TaskInput
        onParseAndCreate={handleParseAndCreate}
        placeholder={`Add a task to ${project.name}...`}
        autoFocusTrigger={autoFocusTrigger}
      />

      {/* Unsectioned tasks */}
      {sections.length === 0 ? (
        <TaskList
          tasks={projectTasks}
          onToggle={onToggleTask}
          onSelect={onSelectTask}
          selectedTaskId={selectedTaskId}
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          emptyMessage="No tasks in this project yet"
          emptyDescription="Add a task above to get started."
          todayKey={today}
          tagMap={tagMap}
          projectName={() => projectName()}
          projectColor={() => projectColor()}
          onIndent={indent}
          onOutdent={outdent}
          onReorder={async (ids) => {
            const result = await reorderTasks({ ordered_ids: ids, project_id: project.id });
            return result !== null;
          }}
        />
      ) : (
        <div className="space-y-4">
          {/* Unsectioned tasks first */}
          {projectTasks.some((t) => !t.section_id) && (
            <SectionTaskList
              tasks={projectTasks.filter((t) => !t.section_id)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              selectedTaskId={selectedTaskId}
              selectedTaskIds={selectedTaskIds}
              onMultiSelect={onMultiSelect}
              todayKey={today}
              tagMap={tagMap}
              emptyMessage=""
              onIndent={indent}
              onOutdent={outdent}
              onReorder={async (ids) => {
                const result = await reorderTasks({ ordered_ids: ids, project_id: project.id });
                return result !== null;
              }}
            />
          )}
          {sections.map((section) => (
            <SectionGroup
              key={section.id}
              section={section}
              tasks={projectTasks.filter((t) => t.section_id === section.id)}
              onToggle={onToggleTask}
              onSelect={onSelectTask}
              selectedTaskId={selectedTaskId}
              selectedTaskIds={selectedTaskIds}
              onMultiSelect={onMultiSelect}
              todayKey={today}
              tagMap={tagMap}
              onToggleCollapse={() => patchSection(section.id, { collapsed: !section.collapsed })}
              onRequestDelete={() => setDeleteSectionTarget(section)}
              onIndent={indent}
              onOutdent={outdent}
              onReorder={async (ids) => {
                const result = await reorderTasks({
                  ordered_ids: ids,
                  project_id: project.id,
                  section_id: section.id,
                });
                return result !== null;
              }}
            />
          ))}
          <AddSectionControl
            adding={addingSection}
            name={sectionName}
            pending={sectionPending}
            onStart={() => setAddingSection(true)}
            onNameChange={setSectionName}
            onSubmit={() => void handleCreateSection()}
            onCancel={() => {
              setAddingSection(false);
              setSectionName("");
            }}
          />
        </div>
      )}

      {sections.length === 0 && (
        <div className="mt-3">
          <AddSectionControl
            adding={addingSection}
            name={sectionName}
            pending={sectionPending}
            onStart={() => setAddingSection(true)}
            onNameChange={setSectionName}
            onSubmit={() => void handleCreateSection()}
            onCancel={() => {
              setAddingSection(false);
              setSectionName("");
            }}
          />
        </div>
      )}

      <ConfirmDialog
        open={deleteSectionTarget !== null}
        title="Delete section?"
        message={
          deleteSectionTarget
            ? `Delete section "${deleteSectionTarget.name}"? Tasks in the section become unsectioned.`
            : ""
        }
        confirmLabel="Delete section"
        cancelLabel="Cancel"
        pending={sectionPending}
        onConfirm={() => void handleDeleteSectionConfirmed()}
        onCancel={() => setDeleteSectionTarget(null)}
      />
    </div>
  );
}

function ProjectHeader({
  project,
  taskCount,
  completedCount,
}: {
  project: ProjectDto;
  taskCount: number;
  completedCount: number;
  totalForProgress: number;
}) {
  return (
    <div className="mb-4 md:mb-6">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="h-3 w-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: project.color }}
        />
        <h1 className="text-xl md:text-2xl font-bold text-on-surface">{project.name}</h1>
      </div>
      <p className="mt-1 text-sm text-on-surface-muted">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
        {completedCount > 0 && ` · ${completedCount} completed`}
      </p>
    </div>
  );
}

function SectionTaskList({
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  todayKey,
  tagMap,
  emptyMessage,
  onIndent,
  onOutdent,
  onReorder,
}: {
  tasks: TaskDto[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: MultiSelectHandler;
  todayKey: string;
  tagMap: Map<string, TagDto>;
  emptyMessage: string;
  onIndent: (id: string) => Promise<boolean>;
  onOutdent: (id: string) => Promise<boolean>;
  onReorder: (ids: string[]) => Promise<boolean>;
}) {
  return (
    <TaskList
      tasks={tasks}
      onToggle={onToggle}
      onSelect={onSelect}
      selectedTaskId={selectedTaskId}
      selectedTaskIds={selectedTaskIds}
      onMultiSelect={onMultiSelect}
      emptyMessage={emptyMessage}
      todayKey={todayKey}
      tagMap={tagMap}
      onIndent={onIndent}
      onOutdent={onOutdent}
      onReorder={onReorder}
    />
  );
}

function SectionGroup({
  section,
  tasks,
  onToggle,
  onSelect,
  selectedTaskId,
  selectedTaskIds,
  onMultiSelect,
  todayKey,
  tagMap,
  onToggleCollapse,
  onRequestDelete,
  onIndent,
  onOutdent,
  onReorder,
}: {
  section: SectionDto;
  tasks: TaskDto[];
  onToggle: (id: string) => Promise<boolean>;
  onSelect: (id: string) => void;
  selectedTaskId: string | null;
  selectedTaskIds?: Set<string>;
  onMultiSelect?: MultiSelectHandler;
  todayKey: string;
  tagMap: Map<string, TagDto>;
  onToggleCollapse: () => void;
  onRequestDelete: () => void;
  onIndent: (id: string) => Promise<boolean>;
  onOutdent: (id: string) => Promise<boolean>;
  onReorder: (ids: string[]) => Promise<boolean>;
}) {
  return (
    <div>
      <div className="flex items-center mb-1 px-1">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!section.collapsed}
          className="flex items-center gap-1 text-sm font-semibold text-on-surface-secondary hover:text-on-surface transition-colors"
        >
          {section.collapsed ? (
            <ChevronRight size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
          {section.name}
        </button>
        <span className="ml-2 text-xs text-on-surface-muted">{tasks.length}</span>
        <button
          type="button"
          onClick={onRequestDelete}
          aria-label={`Delete section ${section.name}`}
          className="ml-auto text-xs text-on-surface-muted hover:text-error transition-colors"
        >
          Delete
        </button>
      </div>
      {!section.collapsed && (
        <TaskList
          tasks={tasks}
          onToggle={onToggle}
          onSelect={onSelect}
          selectedTaskId={selectedTaskId}
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          emptyMessage="No tasks in this section"
          todayKey={todayKey}
          tagMap={tagMap}
          onIndent={onIndent}
          onOutdent={onOutdent}
          onReorder={onReorder}
        />
      )}
    </div>
  );
}

function AddSectionControl({
  adding,
  name,
  pending,
  onStart,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  adding: boolean;
  name: string;
  pending: boolean;
  onStart: () => void;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  if (!adding) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="flex items-center gap-1.5 text-sm text-on-surface-muted hover:text-on-surface transition-colors"
      >
        <Plus size={14} />
        Add section
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-secondary p-2">
      <label htmlFor="new-section-name" className="sr-only">
        Section name
      </label>
      <input
        id="new-section-name"
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Section name"
        disabled={pending}
        autoFocus
        className="min-w-[12rem] flex-1 px-3 py-1.5 border border-border rounded-lg bg-surface text-on-surface text-sm focus:outline-none focus:ring-2 focus:ring-focus"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending || !name.trim()}
        className="rounded-md bg-accent-action px-3 py-1.5 text-sm text-on-accent-action disabled:opacity-50"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="rounded-md border border-border px-3 py-1.5 text-sm text-on-surface-secondary"
      >
        Cancel
      </button>
    </div>
  );
}
