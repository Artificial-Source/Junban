import { CommandPalette } from "../components/CommandPalette.js";
import { SearchModal } from "../components/SearchModal.js";
import { AddProjectModal } from "../components/AddProjectModal.js";
import { FocusMode } from "../components/FocusMode.js";
import { TemplateSelector } from "../components/TemplateSelector.js";
import { Toast } from "../components/Toast.js";
import { Settings } from "../views/Settings.js";
import { ChordIndicator } from "../components/ChordIndicator.js";
import { ContextMenu } from "../components/ContextMenu.js";
import { DatePicker } from "../components/DatePicker.js";
import { QuickAddModal } from "../components/QuickAddModal.js";
import { ExtractTasksModal } from "../components/ExtractTasksModal.js";
import { OnboardingModal } from "../components/OnboardingModal.js";
import { StatusBar } from "../components/StatusBar.js";
import type { SettingsTab } from "../views/Settings.js";
import type { ContextMenuItem } from "../components/ContextMenu.js";
import type { Task, Project as ProjectType, UpdateTaskInput } from "../../core/types.js";
import type { ParsedTaskInput } from "./ViewRenderer.js";

interface AppCommand {
  id: string;
  name: string;
  callback: () => void;
  hotkey?: string;
}

interface AppModalsProps {
  // Settings
  settingsOpen: boolean;
  settingsTab: SettingsTab | null | undefined;
  onCloseSettings: () => void;

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
  return (
    <>
      {settingsOpen && (
        <Settings activeTab={settingsTab ?? undefined} onClose={onCloseSettings} />
      )}
      {focusModeOpen && (
        <FocusMode
          tasks={tasks.filter((t) => t.status === "pending")}
          onComplete={handleToggleTask}
          onClose={onCloseFocusMode}
        />
      )}
      <TemplateSelector
        open={templateSelectorOpen}
        onClose={onCloseTemplateSelector}
        onTaskCreated={() => {
          refreshTasks();
          onCloseTemplateSelector();
        }}
      />
      <div className="hidden md:block">
        <StatusBar />
      </div>
      <CommandPalette
        commands={commands}
        isOpen={commandPaletteOpen}
        onClose={onCloseCommandPalette}
      />
      {featureChordsEnabled && <ChordIndicator />}
      <SearchModal
        isOpen={searchOpen}
        onClose={onCloseSearch}
        tasks={tasks}
        projects={projects}
        onSelectTask={handleSelectTask}
      />
      <AddProjectModal
        open={projectModalOpen}
        onClose={onCloseProjectModal}
        onSubmit={handleCreateProject}
        projects={projects}
      />
      <QuickAddModal
        open={quickAddOpen}
        onClose={onCloseQuickAdd}
        onCreateTask={handleCreateTask}
      />
      <ExtractTasksModal
        open={extractTasksOpen}
        onClose={onCloseExtractTasks}
        projects={projects}
        onCreateTasks={handleExtractedTasksCreate}
      />
      <OnboardingModal
        open={onboardingOpen}
        onComplete={onCompleteOnboarding}
        onRequestOpenSettings={(tab) => handleOpenSettingsTab(tab as SettingsTab)}
      />
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
