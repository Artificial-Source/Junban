import { useMemo } from "react";
import { themeManager } from "../themes/manager.js";
import type { SettingsTab } from "../views/settings/types.js";
import type { Project } from "../../core/types.js";
import type { PluginCommandInfo } from "../api/plugins.js";
import { useGeneralSettings } from "../context/SettingsContext.js";

export function useAppCommands(
  handleNavigate: (view: string, id?: string) => void,
  openSettingsTab: (tab: SettingsTab) => void,
  setFocusModeOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setTemplateSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>,
  projects: Project[],
  pluginCommands: PluginCommandInfo[],
  executeCommand: (id: string) => void,
  setQuickAddOpen?: React.Dispatch<React.SetStateAction<boolean>>,
  setExtractTasksOpen?: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const { settings } = useGeneralSettings();
  return useMemo(() => {
    const cmds = [
      { id: "nav-inbox", name: "Go to Inbox", callback: () => handleNavigate("inbox") },
      { id: "nav-today", name: "Go to Today", callback: () => handleNavigate("today") },
      { id: "nav-upcoming", name: "Go to Upcoming", callback: () => handleNavigate("upcoming") },
      { id: "nav-settings", name: "Go to Settings", callback: () => openSettingsTab("general") },
      {
        id: "nav-settings-general",
        name: "Go to Settings: General",
        callback: () => openSettingsTab("general"),
      },
      {
        id: "nav-settings-appearance",
        name: "Go to Settings: Appearance",
        callback: () => openSettingsTab("appearance"),
      },
      {
        id: "nav-settings-filters",
        name: "Go to Settings: Filters & Labels",
        callback: () => openSettingsTab("filters"),
      },
      {
        id: "nav-settings-ai",
        name: "Go to Settings: AI Assistant",
        callback: () => openSettingsTab("ai"),
      },
      {
        id: "nav-settings-templates",
        name: "Go to Settings: Templates",
        callback: () => openSettingsTab("templates"),
      },
      {
        id: "nav-settings-keyboard",
        name: "Go to Settings: Keyboard",
        callback: () => openSettingsTab("keyboard"),
      },
      {
        id: "nav-settings-data",
        name: "Go to Settings: Data",
        callback: () => openSettingsTab("data"),
      },
      {
        id: "nav-settings-about",
        name: "Go to Settings: About",
        callback: () => openSettingsTab("about"),
      },
      ...(settings.feature_completed === "true"
        ? [
            {
              id: "nav-completed",
              name: "Go to Completed",
              callback: () => handleNavigate("completed"),
            },
          ]
        : []),
      { id: "theme-toggle", name: "Toggle Dark Mode", callback: () => themeManager.toggle() },
      {
        id: "theme-light",
        name: "Switch to Light Theme",
        callback: () => themeManager.setTheme("light"),
      },
      {
        id: "theme-dark",
        name: "Switch to Dark Theme",
        callback: () => themeManager.setTheme("dark"),
      },
      { id: "ai-chat-toggle", name: "Toggle AI Chat", callback: () => handleNavigate("ai-chat") },
      {
        id: "nav-dopamine-menu",
        name: "Quick Wins / Dopamine Menu",
        callback: () => handleNavigate("dopamine-menu"),
      },
      { id: "focus-mode", name: "Enter Focus Mode", callback: () => setFocusModeOpen(true) },
      ...(setQuickAddOpen
        ? [{ id: "quick-add-task", name: "Quick Add Task", callback: () => setQuickAddOpen(true) }]
        : []),
      {
        id: "create-from-template",
        name: "Create Task from Template",
        callback: () => setTemplateSelectorOpen(true),
      },
      ...(setExtractTasksOpen
        ? [
            {
              id: "extract-tasks-from-text",
              name: "Extract tasks from text",
              callback: () => setExtractTasksOpen(true),
            },
          ]
        : []),
    ];

    for (const project of projects) {
      cmds.push({
        id: `nav-project-${project.id}`,
        name: `Go to Project: ${project.name}`,
        callback: () => handleNavigate("project", project.id),
      });
    }

    // Add plugin commands
    for (const cmd of pluginCommands) {
      cmds.push({
        id: `plugin-${cmd.id}`,
        name: cmd.name,
        callback: () => executeCommand(cmd.id),
      });
    }

    return cmds;
  }, [
    projects,
    pluginCommands,
    executeCommand,
    handleNavigate,
    openSettingsTab,
    setFocusModeOpen,
    setTemplateSelectorOpen,
    setQuickAddOpen,
    setExtractTasksOpen,
    settings.feature_completed,
  ]);
}
