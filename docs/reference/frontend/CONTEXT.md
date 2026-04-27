# Frontend Context Providers Reference

> Overview of the app's context providers and how they relate to each other. This reference focuses on state ownership and provider responsibilities (not transport details from `API_LAYER.md` or theme/CSS token implementation from `THEMES.md`).

---

## Provider Nesting Order

Root providers are composed by `src/ui/app/AppProviders.tsx` in this order (outermost first):

```
ErrorBoundary
  SettingsProvider
    TaskProvider
      PluginProvider
        UndoProvider
          <AppContent />
```

`AppStateProvider` is not part of the root provider stack. It is applied inside `src/ui/app/AppLayout.tsx` around the rendered shell after `App.tsx` and `useAppState()` have computed the read-only aggregate value.

`AIProvider` and `VoiceProvider` are now feature-scoped instead of app-global. They mount only around AI/voice entry points like `AIChat`, `AITab`, and experimental voice surfaces, which keeps those chunks off the default startup path while preserving the same feature APIs. The Voice settings tab implementation still exists, but it is currently hidden from Settings navigation and direct `voice` tab requests sanitize to `AI`.

This nesting order still matters because inner providers can depend on outer ones (for example, feature-scoped AI still depends on `TaskProvider`, and `AppStateProvider` aggregates read-only state from the global providers before passing it deeper into the layout).

---

## TaskContext.tsx

- **Path:** `src/ui/context/TaskContext.tsx`
- **Purpose:** Central task state management. Provides all tasks and CRUD operations to the component tree via a reducer-based state pattern.
- **Key Exports:**
  - `TaskProvider` -- context provider component
  - `useTaskContext()` -- hook to consume the context
- **Context Value:**
  - `state: TaskState` -- task state object containing:
    - `tasks: Task[]` -- all tasks in the system
    - `loading: boolean` -- initial load state
    - `error: string | null` -- last error message
  - `createTask: (input: CreateTaskInput) => Promise<void>` -- create a new task (optimistic add)
  - `updateTask: (id, input: UpdateTaskInput) => Promise<void>` -- update task fields
  - `completeTask: (id) => Promise<void>` -- mark task as completed (triggers full refresh if task has recurrence)
  - `deleteTask: (id) => Promise<void>` -- delete a task
  - `completeManyTasks: (ids) => Promise<void>` -- bulk complete (triggers full refresh if any have recurrence)
  - `deleteManyTasks: (ids) => Promise<void>` -- bulk delete
  - `updateManyTasks: (ids, changes: UpdateTaskInput) => Promise<void>` -- bulk update
  - `refreshTasks: () => Promise<void>` -- re-fetch all tasks from the API
- **State Management:** Uses `useReducer` with actions: `LOAD_START`, `LOAD_SUCCESS`, `LOAD_ERROR`, `TASK_ADDED`, `TASK_UPDATED`, `TASK_REMOVED`, `TASKS_UPDATED`, `TASKS_REMOVED`
- **Key Dependencies:** `api` (listTasks, createTask, completeTask, updateTask, deleteTask, completeManyTasks, deleteManyTasks, updateManyTasks)
- **Used By:** Nearly every view and many components that display or modify tasks. AIContext depends on `refreshTasks` for syncing AI-created tasks.
- **Notes:** Fetches all tasks on mount via `refreshTasks`, but schedules that first refresh just after the initial paint (`requestIdleCallback` with a short timeout or a minimal timer fallback) so the shell can render its skeleton immediately. Each CRUD operation dispatches an optimistic update to the reducer and calls the API in the background. Errors are captured via `LOAD_ERROR` dispatches rather than thrown. In packaged desktop mode, it also listens for runtime update events and surfaces sidecar-unavailable errors when the backend transitions to an unready state after startup. The `TASKS_UPDATED` and `TASKS_REMOVED` actions use `Map`/`Set` for efficient bulk operations. All callbacks are memoized with `useCallback`, and the context value is wrapped in `useMemo`.

---

## AIContext.tsx

- **Path:** `src/ui/context/AIContext.tsx`
- **Purpose:** AI chat state and operations. Manages chat messages, SSE streaming, tool call handling, configuration, voice call mode, message editing/regeneration, and multi-session management.
- **Key Exports:**
  - `AIProvider` -- context provider component
  - `useAIContext()` -- hook to consume the context
- **Context Value (stable surface):**
  - Config lifecycle (`config`, `isConfigured`, `updateConfig`, `refreshConfig`)
  - Chat lifecycle (`messages`, `isStreaming`, `sendMessage`, `clearChat`, `restoreMessages`, retry/edit/regenerate helpers)
  - Session lifecycle (`sessions`, `activeSessionId`, create/switch/delete/rename/refresh)
  - Voice-call bridge + mutation signaling (`voiceCallActive`, `setVoiceCallMode`, `dataMutationCount`)
- **Streaming behavior:** Handles SSE rounds (`token`, `tool_call`, `tool_result`, `done`, `error`) and triggers targeted task/data refresh after tool mutations. For exact event payloads and parsing flow, use `src/ui/context/AIContext.tsx` plus `src/ui/context/ai/useAISendMessage.ts` as source of truth.
- **Safety Timeout:** A 90-second safety timeout (`SAFETY_TIMEOUT_MS`) cancels the stream reader if no `done` event is received, preventing a stuck spinner.
- **Key Dependencies:** `api` (getAIConfig, updateAIConfig, sendChatMessage, getChatMessages, clearChat, listChatSessions, createNewChatSession, switchChatSession, deleteChatSession, renameChatSession), `useTaskContext` (refreshTasks)
- **Used By:** `AIChatPanel.tsx`, `AITab.tsx` (settings), `SessionHistory.tsx`, any component tracking `dataMutationCount`
- **Notes:** Messages are loaded via `restoreMessages` to restore chat history across page refreshes (tool messages are filtered out). The `sendMessage` function handles the full SSE lifecycle: creates user message, opens stream, processes events per round (with `roundFinalized` tracking for multi-round tool use), and creates assistant messages. After the stream ends, a safety-net refresh fires if any mutations were detected. Sessions list is refreshed after every `sendMessage` completes (a new session may have been auto-created). The `isConfigured` check also handles plugin providers (names containing `:`). Initial config hydration is deferred with a shared idle-or-timeout startup scheduler to avoid the earliest startup window.
- **Mounting:** This provider is no longer mounted at the app root. It is wrapped around AI surfaces on demand via `src/ui/context/AIFeatureProvider.tsx` and `src/ui/context/AIVoiceFeatureProviders.tsx`.

---

## PluginContext.tsx

- **Path:** `src/ui/context/PluginContext.tsx`
- **Purpose:** Plugin system state. Manages installed plugins, registered commands, status bar items, panels, and views with individual refresh functions.
- **Key Exports:**
  - `PluginProvider` -- context provider component
  - `usePluginContext()` -- hook to consume the context
- **Context Value:**
  - `plugins: PluginInfo[]` -- installed plugins with status
  - `commands: PluginCommandInfo[]` -- registered plugin commands
  - `statusBarItems: StatusBarItemInfo[]` -- status bar items
  - `panels: PanelInfo[]` -- sidebar panels
  - `views: ViewInfo[]` -- custom views
  - `refreshPlugins: () => Promise<void>` -- re-fetch plugin list
  - `refreshCommands: () => Promise<void>` -- re-fetch commands
  - `refreshStatusBar: () => Promise<void>` -- re-fetch status bar items
  - `refreshPanels: () => Promise<void>` -- re-fetch panels
  - `refreshViews: () => Promise<void>` -- re-fetch views
  - `executeCommand: (id: string) => Promise<void>` -- execute a command by ID (also refreshes status bar and panels)
- **Polling:** Status bar items and panels are polled every 30 seconds via `setInterval` to pick up dynamic updates from running plugins.
- **Key Dependencies:** `api` (listPlugins, listPluginCommands, getStatusBarItems, getPluginPanels, getPluginViews, executePluginCommand)
- **Used By:** `Sidebar.tsx` (panels, views), `App.tsx` (commands, status bar), `PluginsTab.tsx`, `PluginStoreView.tsx`
- **Notes:** Plugin and plugin-view hydration still run eagerly on mount so plugin-provided start views and sidebar entries are available immediately. Plugin commands, status bar items, and panels are deferred through a shared idle-or-timeout startup scheduler to reduce startup contention while preserving the same eventual data flow. Uses a `mountedRef` to prevent state updates after unmount, avoiding React warnings. The `executeCommand` function automatically refreshes status bar and panels after execution completes.

---

## VoiceContext.tsx

- **Path:** `src/ui/context/VoiceContext.tsx`
- **Purpose:** Voice system state and operations. Manages STT/TTS providers, voice settings, listening state, transcription, and TTS playback.
- **Key Exports:**
  - `VoiceProvider` -- context provider component
  - `useVoiceContext()` -- hook to consume the context
- **Context Value:**
  - `settings: VoiceSettings` -- all voice settings (providers, mode, mic, API keys, etc.)
  - `updateSettings: (patch: Partial<VoiceSettings>) => void` -- update settings (persisted to localStorage)
  - `registry: VoiceProviderRegistry` -- STT/TTS provider registry (rebuilt when API keys change)
  - `sttProvider: STTProviderPlugin | undefined` -- currently selected STT provider instance
  - `ttsProvider: TTSProviderPlugin | undefined` -- currently selected TTS provider instance
  - `ttsVoices: Voice[]` -- available TTS voices for current provider
  - `ttsModels: TTSModel[]` -- available TTS models for current provider
  - `isListening: boolean` -- STT listening active (set by consumers; context just tracks the flag)
  - `isTranscribing: boolean` -- STT transcription in progress
  - `isSpeaking: boolean` -- TTS playback active
  - `ensureRegistryLoaded: () => Promise<void>` -- lazily initialize the provider registry when voice features are entered/used
  - `localProvidersLoaded: boolean` -- whether local voice providers have been registered
  - `ensureLocalProvidersLoaded: () => Promise<void>` -- lazily register local STT/TTS providers when needed
  - `startListening: () => void` -- set listening state to true
  - `stopListening: () => void` -- set listening state to false
  - `speak: (text: string) => Promise<void>` -- TTS playback (strips markdown, truncates, supports browser and API-based TTS)
  - `cancelSpeech: () => void` -- cancel TTS playback (handles both browser speechSynthesis and audio buffer playback)
  - `transcribeAudio: (audio: Blob) => Promise<string>` -- transcribe an audio blob via STT provider
- **VoiceSettings Interface:**
  - `sttProviderId, ttsProviderId` -- selected provider IDs
  - `voiceMode: "off" | "push-to-talk" | "vad"` -- input mode
  - `ttsEnabled, ttsVoice, ttsModel` -- TTS settings
  - `autoSend: boolean` -- auto-send transcript to AI
  - `microphoneId: string` -- selected microphone device
  - `smartEndpoint: boolean` -- VAD smart endpoint detection
  - `gracePeriodMs: number` -- VAD grace period (default 1500ms)
  - `groqApiKey, inworldApiKey` -- provider API keys
- **Key Dependencies:** `VoiceProviderRegistry` from `ai/voice/registry.js`, `createDefaultVoiceRegistry` from `ai/voice/provider.js`, `BrowserTTSProvider` from `ai/voice/adapters/browser-tts.js`, `playAudioBuffer` from `ai/voice/audio-utils.js`, `localStorage` for persistence
- **Used By:** `AIChatPanel.tsx`, experimental `VoiceTab.tsx`, `useVoiceCall.ts`, `useVAD.ts`
- **Notes:** Settings are persisted to `localStorage` under `junban-voice-settings`. The provider registry and local-provider registration are lazy/on-demand (via `ensureRegistryLoaded` and `ensureLocalProvidersLoaded`) instead of auto-warming on provider mount. Voice list and model list refresh when the TTS provider changes. The `speak` function strips markdown formatting (code blocks, inline code, markdown punctuation), truncates to 5000 chars for browser TTS or 2000 chars for API TTS, and supports both `BrowserTTSProvider.speakDirect()` and API-based `synthesize()` + `playAudioBuffer()`. Cancellation handles both `window.speechSynthesis.cancel()` and audio buffer cancellation via a ref.
- **Mounting:** This provider is feature-scoped. `src/ui/context/VoiceFeatureProvider.tsx` mounts it for experimental voice settings work, and `src/ui/context/AIVoiceFeatureProviders.tsx` mounts it for AI chat. Voice settings are currently hidden from the Settings sidebar until the feature is tested enough to expose.

---

## UndoContext.tsx

- **Path:** `src/ui/context/UndoContext.tsx`
- **Purpose:** Undo/redo system backed by an `UndoManager` class, with toast notifications for undo/redo feedback.
- **Key Exports:**
  - `UndoProvider` -- context provider component
  - `useUndoContext()` -- hook to consume the context
- **Context Value:**
  - `undoManager: UndoManager` -- the underlying undo manager instance (from `core/undo.js`)
  - `undo: () => Promise<void>` -- undo the last action (shows toast with redo option)
  - `redo: () => Promise<void>` -- redo the last undone action (shows toast with description)
  - `canUndo: boolean`
  - `canRedo: boolean`
  - `toast: ToastInfo | null` -- current toast notification to display
  - `dismissToast: () => void` -- dismiss the current toast
  - `showToast: (message: string, action?: { label: string; onClick: () => void }) => void` -- show a custom toast notification
- **ToastInfo Interface:**
  - `message: string` -- text displayed in the toast
  - `actionLabel?: string` -- optional action button label (e.g., "Redo")
  - `onAction?: () => void` -- callback for the action button
- **Key Dependencies:** `UndoManager` from `core/undo.js`
- **Used By:** `App.tsx` (renders Toast from undo context), `useTaskHandlers.ts` (pushes undo entries for task completion/deletion)
- **Notes:** The `UndoManager` is created once via `useState` initializer. The context subscribes to `undoManager.subscribe()` to reactively update `canUndo`/`canRedo` state. When undo is triggered, a toast appears with the description and a "Redo" action button. The context value is memoized with `useMemo`.

---

## SettingsContext.tsx

- **Path:** `src/ui/context/SettingsContext.tsx`
- **Purpose:** General application settings management. Loads all settings on mount, persists changes to the API, and applies visual effects (accent color, density, font size, animations) immediately.
- **Key Exports:**
  - `SettingsProvider` -- context provider component
  - `useGeneralSettings()` -- hook to consume the context
- **Context Value:**
  - `settings: GeneralSettings` -- current settings object
  - `loaded: boolean` -- whether settings have been loaded from storage
  - `updateSetting: <K>(key, value) => void` -- update a single setting
- **GeneralSettings scope:** Appearance, calendar/date/time, defaults, confirmations, sound, and capacity preferences. The canonical schema remains in `src/ui/context/SettingsContext.tsx` (`GeneralSettings` + `DEFAULT_SETTINGS`).
- **Visual side effects:** Settings changes immediately apply theme-adjacent classes/variables on `<html>` (accent, density, font size, motion). Detailed CSS/theme token behavior is documented in `THEMES.md`.
- **Key Dependencies:** `api` (getAppSetting, setAppSetting)
- **Used By:** `GeneralTab.tsx`, `AppearanceTab.tsx`, `DatePicker.tsx`, `useSoundEffect.ts`, `Today.tsx`, `Project.tsx`, and any component that reads user preferences
- **Notes:** The provider loads settings via one batch fetch on mount, but no longer hides the whole app while waiting. Visual defaults come from `DEFAULT_SETTINGS` plus early theme/bootstrap work in `main.tsx`, then persisted settings replace them as soon as the fetch resolves. All setting values are stored as strings in the backend. The `darkenColor` helper converts hex to HSL, reduces lightness, and converts back. The context is created with default values so `useGeneralSettings()` can be called without a provider (returns defaults).

---

## AppStateContext.tsx

- **Path:** `src/ui/context/AppStateContext.tsx`
- **Purpose:** Read-only aggregated app state to reduce prop drilling. Provides a single context with the most commonly needed state values from across the app.
- **Key Exports:**
  - `AppStateProvider` -- context provider component
  - `useAppState()` -- hook to consume the context
- **Context Value (`AppState` interface):**
  - `currentView: View` -- active view/route
  - `projects: ProjectType[]` -- all projects
  - `selectedProjectId: string | null` -- currently selected project
  - `selectedRouteTaskId: string | null` -- task ID from route params
  - `selectedPluginViewId: string | null` -- active plugin view ID
  - `selectedFilterId: string | null` -- active filter ID
  - `selectedTaskId: string | null` -- currently selected task in list
  - `multiSelectedIds: Set<string>` -- bulk-selected task IDs
  - `featureSettings: GeneralSettings` -- current feature flag values
  - `pluginViews: ViewInfo[]` -- registered plugin views
  - `sections: Section[]` -- project sections
  - `availableTags: string[]` -- all tag names
  - `tasks: Task[]` -- all tasks
- **Key Dependencies:** Types from `core/types.js`, `hooks/useRouting.js`, `api/index.js`, `SettingsContext.js`
- **Used By:** Any deeply nested component that needs read-only access to app state without prop drilling
- **Notes:** This is a pure pass-through context -- it does not manage any state itself. The `AppStateProvider` receives its `value` prop from `App.tsx`, which computes it from the various other contexts and local state. Advanced views like calendar, stats, and matrix now enter through `plugin-view` routing plus `pluginViews`, rather than dedicated core route state. Throws if used outside the provider.

---

## BlockedTaskIdsContext.tsx

- **Path:** `src/ui/context/BlockedTaskIdsContext.tsx`
- **Purpose:** Provides the set of task IDs that are currently blocked (e.g., by dependencies or other constraints) to avoid prop drilling.
- **Key Exports:**
  - `BlockedTaskIdsProvider` -- context provider component
  - `useBlockedTaskIds()` -- hook to consume the context
- **Context Value:** `Set<string>` -- IDs of blocked tasks
- **Used By:** `TaskItem.tsx`, `TaskList.tsx`

---

## AIContext — 3-Context Split

The `AIContext.tsx` facade composes three granular contexts from `src/ui/context/ai/`:

| File                   | Context            | Purpose                                                                                                                                                                                    |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AIConfigContext.tsx`  | `AIConfigContext`  | AI provider configuration state (`config`, `isConfigured`, `updateConfig`, `refreshConfig`)                                                                                                |
| `AIChatContext.tsx`    | `AIChatContext`    | Chat messages and streaming (`messages`, `isStreaming`, `sendMessage`, `clearChat`, `retryLastMessage`, `editAndResend`, `regenerateLastResponse`, `voiceCallActive`, `dataMutationCount`) |
| `AISessionContext.tsx` | `AISessionContext` | Multi-session management (`sessions`, `activeSessionId`, `createNewSession`, `switchSession`, `deleteSession`, `renameSession`)                                                            |

Supporting hooks in `src/ui/context/ai/`:

- `useAISendMessage.ts` -- SSE stream processing, tool call handling, mutation tracking
- `useAIMessageActions.ts` -- edit/resend, regenerate, retry logic
- `useAISessionManagement.ts` -- session CRUD and switching

The `useAIContext()` hook from `AIContext.tsx` merges all three contexts into a single flat object for backward compatibility.
