import { lazy, Suspense, useMemo } from "react";
import { TaskInput } from "../components/TaskInput.js";
import { TaskList } from "../components/TaskList.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import type { Task, Project as ProjectType, Section } from "../../core/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import { ProjectHeader } from "./project/ProjectHeader.js";
import { AddSectionButton, SectionedTaskList } from "./project/ProjectSections.js";

const Board = lazy(() => import("./Board.js").then((module) => ({ default: module.Board })));

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
  onContextMenu?: (taskId: string, position: { x: number; y: number }) => void;
  autoFocusTrigger?: number;
  sections?: Section[];
  onCreateSection?: (name: string) => void;
  onUpdateSection?: (id: string, data: { name?: string; isCollapsed?: boolean }) => void;
  onDeleteSection?: (id: string) => void;
  onMoveTask?: (taskId: string, sectionId: string | null) => void;
  viewStyle?: "list" | "board" | "calendar";
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
  onContextMenu,
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
  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === "completed" && t.projectId === project.id).length,
    [tasks, project.id],
  );
  const totalForProgress = projectTasks.length + completedCount;
  const rawViewStyle = viewStyle ?? project.viewStyle ?? "list";
  const effectiveViewStyle = !kanbanEnabled && rawViewStyle === "board" ? "list" : rawViewStyle;
  const hasSections = sectionsEnabled && sections && sections.length > 0;
  const sortedSections = sections ? [...sections].sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const boardFallback = (
    <div className="mt-4 flex items-center justify-center rounded-xl border border-border bg-surface-secondary/40 p-6 text-sm text-on-surface-muted">
      Loading board...
    </div>
  );

  // Board view
  if (effectiveViewStyle === "board" && sections && onMoveTask) {
    return (
      <div>
        <ProjectHeader
          project={project}
          taskCount={projectTasks.length}
          completedCount={completedCount}
          totalForProgress={totalForProgress}
        />
        <TaskInput
          onSubmit={onCreateTask}
          placeholder={`Add a task to ${project.name}...`}
          autoFocusTrigger={autoFocusTrigger}
        />
        <div className="mt-4">
          <ErrorBoundary fallback={boardFallback}>
            <Suspense fallback={boardFallback}>
              <Board
                project={project}
                tasks={projectTasks}
                sections={sortedSections}
                onMoveTask={onMoveTask}
                onToggleTask={onToggleTask}
                onSelectTask={onSelectTask}
                selectedTaskId={selectedTaskId}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
        {sectionsEnabled && onCreateSection && <AddSectionButton onCreate={onCreateSection} />}
      </div>
    );
  }

  // List view (with optional section grouping)
  return (
    <div>
      <ProjectHeader
        project={project}
        taskCount={projectTasks.length}
        completedCount={completedCount}
        totalForProgress={totalForProgress}
      />
      <TaskInput
        onSubmit={onCreateTask}
        placeholder={`Add a task to ${project.name}...`}
        autoFocusTrigger={autoFocusTrigger}
      />

      {/* Flat list when no sections */}
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
          onContextMenu={onContextMenu}
        />
      )}

      {/* Sectioned list view */}
      {hasSections && (
        <SectionedTaskList
          projectTasks={projectTasks}
          sortedSections={sortedSections}
          onToggleTask={onToggleTask}
          onSelectTask={onSelectTask}
          selectedTaskId={selectedTaskId}
          selectedTaskIds={selectedTaskIds}
          onMultiSelect={onMultiSelect}
          onReorder={onReorder}
          onAddSubtask={onAddSubtask}
          onUpdateDueDate={onUpdateDueDate}
          onUpdateSection={onUpdateSection}
          onDeleteSection={onDeleteSection}
        />
      )}

      {sectionsEnabled && onCreateSection && <AddSectionButton onCreate={onCreateSection} />}
    </div>
  );
}
