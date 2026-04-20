import { lazy, Suspense } from "react";
import { Toast } from "../components/Toast.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { DatePicker } from "../components/DatePicker.js";
import { StatusBar } from "../components/StatusBar.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import type { SettingsTab } from "../views/settings/types.js";
import type { ContextMenuItem } from "../components/ContextMenu.js";
import type { Task, Project as ProjectType, UpdateTaskInput } from "../../core/types.js";
import type { ParsedTaskInput } from "./ViewRenderer.js";

interface AppCommand {
  id: string;
  name: string;
  callback: () => void;
  hotkey?: string;
}

const FocusMode = lazy(() =>
  import("../components/FocusMode.js").then((module) => ({ default: module.FocusMode })),
);
const Settings = lazy(() =>
  import("../views/Settings.js").then((module) => ({ default: module.Settings })),
);
const ChordIndicator = lazy(() =>
  import("../components/ChordIndicator.js").then((module) => ({ default: module.ChordIndicator })),
);
const CommandPalette = lazy(() =>
  import("../components/CommandPalette.js").then((module) => ({ default: module.CommandPalette })),
);
const SearchModal = lazy(() =>
  import("../components/SearchModal.js").then((module) => ({ default: module.SearchModal })),
);
const AddProjectModal = lazy(() =>
  import("../components/AddProjectModal.js").then((module) => ({
    default: module.AddProjectModal,
  })),
);
const QuickAddModal = lazy(() =>
  import("../components/QuickAddModal.js").then((module) => ({ default: module.QuickAddModal })),
);
const TemplateSelector = lazy(() =>
  import("../components/TemplateSelector.js").then((module) => ({
    default: module.TemplateSelector,
  })),
);
const ExtractTasksModal = lazy(() =>
  import("../components/ExtractTasksModal.js").then((module) => ({
    default: module.ExtractTasksModal,
  })),
);
const OnboardingModal = lazy(() =>
  import("../components/OnboardingModal.js").then((module) => ({
    default: module.OnboardingModal,
  })),
);

interface AppModalsProps {
  // Settings
  settingsOpen: boolean;
  settingsTab: SettingsTab | null | undefined;
  onCloseSettings: () => void;
  mutationsBlocked: boolean;

  // Focus mode
  focusModeOpen: boolean;
  tasks: Task[];
  handleToggleTask: (id: string) => void;
  onCloseFocusMode: () => void;

  // Template selector
  templateSelectorOpen: boolean;
  onCloseTemplateSelector: () => void;
  refreshTasks: () => void;

  // Command palette
  commands: AppCommand[];
  commandPaletteOpen: boolean;
  onCloseCommandPalette: () => void;

  // Chords
  featureChordsEnabled: boolean;

  // Search
  searchOpen: boolean;
  onCloseSearch: () => void;
  projects: ProjectType[];
  handleSelectTask: (id: string) => void;

  // Add project
  projectModalOpen: boolean;
  onCloseProjectModal: () => void;
  handleCreateProject: (
    name: string,
    color: string,
    icon: string,
    parentId: string | null,
    isFavorite: boolean,
    viewStyle: "list" | "board" | "calendar",
  ) => void;

  // Quick add
  quickAddOpen: boolean;
  onCloseQuickAdd: () => void;
  handleCreateTask: (data: ParsedTaskInput) => void;

  // Extract tasks
  extractTasksOpen: boolean;
  onCloseExtractTasks: () => void;
  handleExtractedTasksCreate: (
    tasks: Array<{
      title: string;
      priority: number | null;
      dueDate: string | null;
      description: string | null;
    }>,
    projectId: string | null,
  ) => Promise<void>;

  // Onboarding
  onboardingOpen: boolean;
  onCompleteOnboarding: () => void;
  handleOpenSettingsTab: (tab: SettingsTab) => void;

  // Toast
  toast: {
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null;
  dismissToast: () => void;

  // Context menu
  contextMenu: { taskId: string; position: { x: number; y: number } } | null;
  contextMenuItems: ContextMenuItem[];
  setContextMenu: (menu: { taskId: string; position: { x: number; y: number } } | null) => void;

  // Custom date picker
  customDatePicker: {
    taskId: string;
    mode: "dueDate" | "reminder";
    position: { x: number; y: number };
  } | null;
  setCustomDatePicker: (
    picker: {
      taskId: string;
      mode: "dueDate" | "reminder";
      position: { x: number; y: number };
    } | null,
  ) => void;
  handleUpdateTask: (id: string, data: UpdateTaskInput) => void;
}

export function AppModals({
  settingsOpen,
  settingsTab,
  onCloseSettings,
  mutationsBlocked,
  focusModeOpen,
  tasks,
  handleToggleTask,
  onCloseFocusMode,
  templateSelectorOpen,
  onCloseTemplateSelector,
  refreshTasks,
  commands,
  commandPaletteOpen,
  onCloseCommandPalette,
  featureChordsEnabled,
  searchOpen,
  onCloseSearch,
  projects,
  handleSelectTask,
  projectModalOpen,
  onCloseProjectModal,
  handleCreateProject,
  quickAddOpen,
  onCloseQuickAdd,
  handleCreateTask,
  extractTasksOpen,
  onCloseExtractTasks,
  handleExtractedTasksCreate,
  onboardingOpen,
  onCompleteOnboarding,
  handleOpenSettingsTab,
  toast,
  dismissToast,
  contextMenu,
  contextMenuItems,
  setContextMenu,
  customDatePicker,
  setCustomDatePicker,
  handleUpdateTask,
}: AppModalsProps) {
  const modalFallback = null;

  return (
    <>
      {settingsOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <Settings
              activeTab={settingsTab ?? undefined}
              onClose={onCloseSettings}
              mutationsBlocked={mutationsBlocked}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {focusModeOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <FocusMode
              tasks={tasks.filter((t) => t.status === "pending")}
              onComplete={handleToggleTask}
              onClose={onCloseFocusMode}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {templateSelectorOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <TemplateSelector
              open={templateSelectorOpen}
              onClose={onCloseTemplateSelector}
              onTaskCreated={() => {
                refreshTasks();
                onCloseTemplateSelector();
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <div className="hidden md:block">
        <StatusBar mutationsBlocked={mutationsBlocked} />
      </div>
      {commandPaletteOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <CommandPalette
              commands={commands}
              isOpen={commandPaletteOpen}
              onClose={onCloseCommandPalette}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {featureChordsEnabled && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <ChordIndicator />
          </Suspense>
        </ErrorBoundary>
      )}
      {searchOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <SearchModal
              isOpen={searchOpen}
              onClose={onCloseSearch}
              tasks={tasks}
              projects={projects}
              onSelectTask={handleSelectTask}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {projectModalOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <AddProjectModal
              open={projectModalOpen}
              onClose={onCloseProjectModal}
              onSubmit={handleCreateProject}
              projects={projects}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {quickAddOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <QuickAddModal
              open={quickAddOpen}
              onClose={onCloseQuickAdd}
              onCreateTask={handleCreateTask}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {extractTasksOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <ExtractTasksModal
              open={extractTasksOpen}
              onClose={onCloseExtractTasks}
              projects={projects}
              onCreateTasks={handleExtractedTasksCreate}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {onboardingOpen && (
        <ErrorBoundary fallback={modalFallback}>
          <Suspense fallback={modalFallback}>
            <OnboardingModal
              open={onboardingOpen}
              onComplete={onCompleteOnboarding}
              onRequestOpenSettings={(tab) => handleOpenSettingsTab(tab as SettingsTab)}
              mutationsBlocked={mutationsBlocked}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {toast && (
        <Toast
          message={toast.message}
          actionLabel={toast.actionLabel}
          onAction={toast.onAction}
          onDismiss={dismissToast}
        />
      )}
      {contextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
      {customDatePicker &&
        (() => {
          const pickerTask = tasks.find((t) => t.id === customDatePicker.taskId);
          const currentValue =
            customDatePicker.mode === "dueDate"
              ? (pickerTask?.dueDate ?? null)
              : (pickerTask?.remindAt ?? null);
          return (
            <DatePicker
              value={currentValue}
              onChange={(date) => {
                if (customDatePicker.mode === "dueDate") {
                  const dueTime = date ? !date.endsWith("T00:00:00") : false;
                  handleUpdateTask(customDatePicker.taskId, { dueDate: date, dueTime });
                } else handleUpdateTask(customDatePicker.taskId, { remindAt: date });
                setCustomDatePicker(null);
              }}
              showTime
              onClose={() => setCustomDatePicker(null)}
              fixedPosition={customDatePicker.position}
            />
          );
        })()}
    </>
  );
}
