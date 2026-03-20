import { vi } from "vitest";

/**
 * Creates a mock `api` object matching the full surface of `src/ui/api/index.ts`.
 * Every method is a `vi.fn()` with a sensible default return value.
 */
export function createMockApi() {
  return {
    // tasks
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue(makeTask()),
    completeTask: vi.fn().mockResolvedValue(makeTask({ status: "completed" })),
    updateTask: vi.fn().mockResolvedValue(makeTask()),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    completeManyTasks: vi.fn().mockResolvedValue([]),
    deleteManyTasks: vi.fn().mockResolvedValue(undefined),
    updateManyTasks: vi.fn().mockResolvedValue([]),
    fetchDueReminders: vi.fn().mockResolvedValue([]),
    listTaskTree: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),
    indentTask: vi.fn().mockResolvedValue(makeTask()),
    outdentTask: vi.fn().mockResolvedValue(makeTask()),
    reorderTasks: vi.fn().mockResolvedValue(undefined),
    importTasks: vi.fn().mockResolvedValue({ imported: 0, errors: [] }),

    // templates
    listTemplates: vi.fn().mockResolvedValue([]),
    createTemplate: vi.fn().mockResolvedValue(makeTemplate()),
    updateTemplate: vi.fn().mockResolvedValue(makeTemplate()),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    instantiateTemplate: vi.fn().mockResolvedValue(makeTask()),

    // projects
    listTags: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn().mockResolvedValue(makeProject()),
    updateProject: vi.fn().mockResolvedValue(makeProject()),
    deleteProject: vi.fn().mockResolvedValue(undefined),

    // plugins
    listPlugins: vi.fn().mockResolvedValue([]),
    getPluginSettings: vi.fn().mockResolvedValue({}),
    updatePluginSetting: vi.fn().mockResolvedValue(undefined),
    listPluginCommands: vi.fn().mockResolvedValue([]),
    executePluginCommand: vi.fn().mockResolvedValue(undefined),
    getStatusBarItems: vi.fn().mockResolvedValue([]),
    getPluginPanels: vi.fn().mockResolvedValue([]),
    getPluginViews: vi.fn().mockResolvedValue([]),
    getPluginViewContent: vi.fn().mockResolvedValue(""),
    getPluginPermissions: vi.fn().mockResolvedValue(null),
    approvePluginPermissions: vi.fn().mockResolvedValue(undefined),
    revokePluginPermissions: vi.fn().mockResolvedValue(undefined),
    getPluginStore: vi.fn().mockResolvedValue({ plugins: [] }),
    installPlugin: vi.fn().mockResolvedValue(undefined),
    uninstallPlugin: vi.fn().mockResolvedValue(undefined),
    togglePlugin: vi.fn().mockResolvedValue(undefined),

    // ai
    listAIProviders: vi.fn().mockResolvedValue([]),
    fetchModels: vi.fn().mockResolvedValue([]),
    loadModel: vi.fn().mockResolvedValue(undefined),
    unloadModel: vi.fn().mockResolvedValue(undefined),
    getAIConfig: vi.fn().mockResolvedValue({
      provider: null,
      model: null,
      baseUrl: null,
      hasApiKey: false,
    }),
    updateAIConfig: vi.fn().mockResolvedValue(undefined),
    sendChatMessage: vi.fn().mockResolvedValue(null),
    getChatMessages: vi.fn().mockResolvedValue([]),
    clearChat: vi.fn().mockResolvedValue(undefined),
    listChatSessions: vi.fn().mockResolvedValue([]),
    renameChatSession: vi.fn().mockResolvedValue(undefined),
    deleteChatSession: vi.fn().mockResolvedValue(undefined),
    switchChatSession: vi.fn().mockResolvedValue([]),
    createNewChatSession: vi.fn().mockResolvedValue(""),

    // settings
    getAllSettings: vi.fn().mockResolvedValue({}),
    getAppSetting: vi.fn().mockResolvedValue(null),
    setAppSetting: vi.fn().mockResolvedValue(undefined),
    exportAllData: vi.fn().mockResolvedValue({ tasks: [], projects: [], tags: [] }),
    getStorageInfo: vi.fn().mockResolvedValue({ mode: "sqlite", path: "test.db" }),
  };
}

// ── Factory helpers ──────────────────────────────────────────

export function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "Test Task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: null,
    dueTime: false,
    completedAt: null,
    projectId: null,
    recurrence: null,
    parentId: null,
    remindAt: null,
    tags: [],
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Test Project",
    color: "#3b82f6",
    icon: null,
    parentId: null,
    isFavorite: false,
    viewStyle: "list",
    sortOrder: 0,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl1",
    name: "Test Template",
    title: "Template Task",
    description: null,
    priority: null,
    tags: [],
    projectId: null,
    recurrence: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeTag(overrides: Record<string, unknown> = {}) {
  return {
    id: "tag1",
    name: "test-tag",
    color: "#ef4444",
    ...overrides,
  };
}
