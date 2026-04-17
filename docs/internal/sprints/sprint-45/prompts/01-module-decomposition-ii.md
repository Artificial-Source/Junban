# Prompt: Module Decomposition II — God File Cleanup (DX-08 through DX-14)

## Context

You are working on **ASF Junban**, a local-first AI-native task manager. The codebase has 7 files over 400 lines that need decomposing into focused, single-responsibility modules. This is the same pattern used in Sprint S38 (DX-01 through DX-07) which successfully split 7 files from 800–1474 lines down to 150–400 lines each.

**Tech stack:** React + TypeScript strict + Tailwind CSS + Vite + Vitest + pnpm
**Key references:**

- `CLAUDE.md` — project conventions, tech stack, architecture
- `AGENTS.md` — codebase navigation guide

## Hard Rules

1. **ZERO behavior changes** — this is pure structural refactoring
2. **All existing imports must keep working** — add re-exports from original files if anything was importable before
3. **No new dependencies** — only move code between files
4. **All tests must pass unchanged** — run `pnpm test` after each phase
5. **TypeScript strict must pass** — run `pnpm check` after each phase (note: there are 4 pre-existing errors in `src/mcp/` and 1 in `useNudges.ts` — ignore those)
6. **No renaming** of exported functions, types, hooks, or components
7. **Keep files under 400 lines** — that's the target ceiling
8. **Preserve co-location** — extracted modules go in the same directory or a new subdirectory next to the original file

## S38 Pattern Reference

In S38, the pattern was:

- Extract logical groups into new files in the same directory (or a new subdirectory)
- Original file becomes a thin orchestrator that imports from the new modules
- Re-export anything that was previously importable from the original file
- Example: `Sidebar.tsx` → a set of smaller focused sidebar modules such as `SidebarPrimitives.tsx`, `ProjectTree.tsx`, `SidebarContextMenu.tsx`, and `ViewNavigation.tsx`

---

## Phase 1: DX-08 — Split TimeblockingView.tsx (1175 → ~150 lines)

**File:** `src/plugins/builtin/timeblocking/components/TimeblockingView.tsx`

This is the worst offender — a 1175-line React component with state management, data loading, navigation, block CRUD, keyboard shortcuts, drag-and-drop, context menus, inline editing, and rendering all in one file.

**Target directory:** `src/plugins/builtin/timeblocking/components/` (same directory) and `src/plugins/builtin/timeblocking/hooks/` (new directory for hooks)

**Extraction plan:**

| New File                                 | Approx Lines | What to Extract                                                                                                                                                  |
| ---------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../hooks/useTimeblockingState.ts`       | ~200         | All 14+ useState hooks, useMemo derived state (taskStatuses, projects, scheduledTaskIds, activeBlock), settings version tracking. Returns a single state object. |
| `../hooks/useTimeblockingData.ts`        | ~80          | `refreshData()`, `refreshTasks()` callbacks and the useEffect hooks that load initial data.                                                                      |
| `../hooks/useTimeblockingNavigation.ts`  | ~50          | `goToPrevious()`, `goToNext()`, `goToToday()` date navigation callbacks.                                                                                         |
| `../hooks/useTimeblockingBlocks.ts`      | ~120         | Block CRUD operations: `createBlockAtNextAvailable()`, `deleteSelectedBlock()`, move/resize/click handlers.                                                      |
| `../hooks/useTimeblockingDnD.ts`         | ~150         | DnD handlers: `handleDragStart()`, `handleDragEnd()`, `handleDragCancel()`, conflict detection, 5 drop scenarios.                                                |
| `../hooks/useTimeblockingContextMenu.ts` | ~200         | Timeline/block/slot context menu handlers + the `contextMenuItems` useMemo that builds 15+ menu items.                                                           |
| `../hooks/useTimeblockingKeyboard.ts`    | ~80          | Keyboard shortcut useEffect with 12+ keybindings.                                                                                                                |
| `../utils/timeblocking-utils.ts`         | ~60          | Pure utility functions: `getPixelsPerHour()`, `formatDateRange()`, `getDateRangeStrings()`, `findActiveBlock()`.                                                 |

**After extraction**, `TimeblockingView.tsx` should be ~150 lines: imports, hook composition, and JSX layout only. It wires the hooks together and renders the template.

**Steps:**

1. Read the full file to understand all the logical sections
2. Create `../hooks/` directory
3. Extract utility functions to `../utils/timeblocking-utils.ts`
4. Extract each hook one at a time, updating imports in TimeblockingView.tsx
5. After all extractions, TimeblockingView.tsx should only contain: hook calls + JSX return
6. Add re-exports from TimeblockingView.tsx for anything that was previously imported by other files (check with grep)
7. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 2, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 2: DX-09 — Split PluginBrowser.tsx (689 → ~150 lines)

**File:** `src/ui/components/PluginBrowser.tsx`

**Target directory:** `src/ui/components/plugin-browser/` (new subdirectory)

**Extraction plan:**

| New File                                     | Approx Lines | What to Extract                                                                          |
| -------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `plugin-browser/plugin-browser-utils.ts`     | ~80          | `BrowserPlugin` interface, `mergePlugins()` function, type definitions                   |
| `plugin-browser/usePluginBrowserState.ts`    | ~100         | 8 useState hooks, filtering/selection useMemo, focus trap, auto-focus                    |
| `plugin-browser/usePluginBrowserHandlers.ts` | ~70          | `handleInstall()`, `handleUninstall()`, `handleToggle()` async operations                |
| `plugin-browser/PluginListItem.tsx`          | ~50          | Clickable list item sub-component with status badges                                     |
| `plugin-browser/PluginDetailView.tsx`        | ~200         | Full detail panel: gradient, metadata, buttons, description, permissions, tags, settings |

**After extraction**, `PluginBrowser.tsx` should be ~150 lines: imports from subdirectory modules, component composition, layout (desktop list+detail vs mobile detail).

**Original file keeps the `PluginBrowser` export** and re-exports anything needed.

**Steps:**

1. Read the full file
2. Create `plugin-browser/` subdirectory
3. Extract each module
4. Update PluginBrowser.tsx to import from new modules
5. Add re-exports for any externally-used symbols
6. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 3, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 3: DX-10 — Split AITab.tsx (637 → ~150 lines)

**File:** `src/ui/views/settings/AITab.tsx`

**Target directory:** `src/ui/views/settings/ai/` (new subdirectory)

**Extraction plan:**

| New File                           | Approx Lines | What to Extract                                                                           |
| ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `ai/MemorySection.tsx`             | ~180         | Self-contained `MemorySection` component with memory CRUD (list, edit, delete, clear all) |
| `ai/CustomInstructionsSection.tsx` | ~55          | Textarea + save handler for custom AI instructions                                        |
| `ai/DailyBriefingSection.tsx`      | ~70          | Briefing toggle + energy level settings                                                   |
| `ai/useAIProviderConfig.ts`        | ~150         | Provider/model state, model discovery, auto-load, `handleSave()` logic                    |
| `ai/ai-tab-constants.ts`           | ~20          | `PROVIDER_HELP`, `CATEGORY_COLORS` maps                                                   |

**After extraction**, `AITab.tsx` should be ~150 lines: imports, hook call, section composition.

**Steps:**

1. Read the full file
2. Create `ai/` subdirectory
3. Extract constants first (no deps)
4. Extract self-contained sections (MemorySection, CustomInstructionsSection, DailyBriefingSection)
5. Extract useAIProviderConfig hook
6. Update AITab.tsx to compose from modules
7. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 4, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 4: DX-11 — Split PluginCard.tsx (561 → ~120 lines)

**File:** `src/ui/components/PluginCard.tsx`

**Target directory:** `src/ui/components/plugin-browser/` (same subdirectory created in Phase 2 — these are related)

**Extraction plan:**

| New File                                 | Approx Lines | What to Extract                                                                                               |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `plugin-browser/gradient-utils.ts`       | ~50          | `GRADIENT_PALETTE`, `hashString()`, `getGradient()`, `formatDownloads()`, `GradientBanner` component          |
| `plugin-browser/PluginSettingsPanel.tsx` | ~120         | `PluginSettings` component + `SettingField` sub-component (settings loading, change handler, input rendering) |
| `plugin-browser/StorePluginCard.tsx`     | ~190         | `StorePluginCard` component (store/marketplace card layout)                                                   |
| `plugin-browser/SettingsPluginCard.tsx`  | ~150         | `SettingsPluginCard` component (installed plugin settings card)                                               |

**After extraction**, `PluginCard.tsx` should be ~50-80 lines: just re-exports of the components that other files import.

**Steps:**

1. Read the full file
2. Check what's imported from `PluginCard.tsx` elsewhere (grep for import paths)
3. Extract each module to `plugin-browser/`
4. Update PluginCard.tsx to re-export everything
5. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 5, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 5: DX-12 — Split ui/api/ai.ts (547 → facade)

**File:** `src/ui/api/ai.ts`

**Target directory:** `src/ui/api/ai/` (new subdirectory, original becomes `src/ui/api/ai.ts` facade)

**Extraction plan:**

| New File             | Approx Lines | What to Extract                                                                                                     |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `ai/ai-types.ts`     | ~45          | Type definitions: `AIConfigInfo`, `AIChatMessage`, `ChatSessionInfo`, `AIProviderInfo`, `ModelDiscoveryInfo`        |
| `ai/ai-providers.ts` | ~100         | `listAIProviders()`, `fetchModels()`, `loadModel()`, `unloadModel()`                                                |
| `ai/ai-config.ts`    | ~55          | `getAIConfig()`, `updateAIConfig()`                                                                                 |
| `ai/ai-chat.ts`      | ~200         | `sendChatMessage()` (with SSE streaming), `getChatMessages()`, `clearChat()`                                        |
| `ai/ai-sessions.ts`  | ~100         | `listChatSessions()`, `renameChatSession()`, `deleteChatSession()`, `switchChatSession()`, `createNewChatSession()` |
| `ai/ai-memories.ts`  | ~60          | `getAiMemories()`, `updateAiMemory()`, `deleteAiMemory()`, `deleteAllAiMemories()`                                  |

**After extraction**, `ai.ts` should be ~30 lines: just re-exports from the subdirectory modules so all existing `import { ... } from "../api/ai.js"` continue to work.

**Steps:**

1. Read the full file
2. Grep for all imports from `api/ai` to know what's externally used
3. Create `ai/` subdirectory
4. Extract each module (types first — other modules depend on them)
5. Replace `ai.ts` content with re-exports
6. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 6, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 6: DX-13 — Split AIContext.tsx (500 → ~150 lines)

**File:** `src/ui/context/AIContext.tsx`

**Target directory:** `src/ui/context/ai/` (new subdirectory)

**Extraction plan:**

| New File                       | Approx Lines | What to Extract                                                                                                                                  |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai/ai-context-types.ts`       | ~50          | `AIState`, `AIContextValue` interfaces, `SAFETY_TIMEOUT_MS`, `TASK_MUTATING_TOOLS`, `DATA_MUTATING_TOOLS` constants, `parseStreamError()` helper |
| `ai/useAISendMessage.ts`       | ~200         | The large `sendMessage` callback + `restoreMessages()` — SSE parsing, tool result handling, streaming state management                           |
| `ai/useAISessionManagement.ts` | ~80          | Session CRUD callbacks: create, switch, rename, delete                                                                                           |
| `ai/useAIMessageActions.ts`    | ~60          | `retryLastMessage()`, `editAndResend()`, `regenerateLastResponse()`                                                                              |

**After extraction**, `AIContext.tsx` should be ~150 lines: state initialization (14 useState), hook composition, context provider wrapper, and the `useAIContext()` hook export.

**Steps:**

1. Read the full file
2. Grep for imports from `AIContext` to know what's externally used
3. Create `ai/` subdirectory
4. Extract types/constants first
5. Extract each hook (sendMessage is the biggest — do it carefully)
6. Update AIContext.tsx to compose hooks
7. Re-export `useAIContext`, `AIContext`, `AIProvider` and any types that were importable
8. Run `pnpm test` and `pnpm check`

**Before proceeding to Phase 7, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Phase 7: DX-14 — Split AIChatPanel.tsx (484 → ~150 lines)

**File:** `src/ui/components/AIChatPanel.tsx`

**Target directory:** `src/ui/components/chat/` (subdirectory already exists from S38)

**Extraction plan:**

| New File                       | Approx Lines | What to Extract                                                                               |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| `chat/useAIChatVoice.ts`       | ~120         | Voice result handler, VAD speech-end handler, browser STT loop, TTS auto-speak on AI response |
| `chat/AIChatNotConfigured.tsx` | ~45          | The "not configured" empty state component                                                    |
| `chat/AIChatMessages.tsx`      | ~100         | Message list rendering with auto-scroll, typing indicator, suggested actions                  |

**After extraction**, `AIChatPanel.tsx` should be ~150 lines: state setup, hook calls, and two render paths (view mode vs panel mode) that compose the extracted components.

**Note:** The `chat/` subdirectory already has files from S38 (`ChatPlanningCards.tsx`, `ChatTaskResults.tsx`, `ChatVisualizations.tsx`). New files go alongside them.

**Steps:**

1. Read the full file
2. Create new files in `chat/`
3. Extract voice integration hook first (biggest chunk)
4. Extract the not-configured component
5. Extract message list rendering
6. Update AIChatPanel.tsx to use extracted modules
7. Run `pnpm test` and `pnpm check`

**Before proceeding to final review, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

---

## Final Verification

After all 7 phases are complete:

1. **Run full test suite:** `pnpm test` — all tests must pass with zero changes to test files
2. **Run type check:** `pnpm check` — only the 5 pre-existing errors should remain
3. **Verify file sizes:** Run `find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -20` — no file should exceed 400 lines (except the 5 pre-existing MCP/nudge files with known issues)
4. **Verify no behavior changes:** Grep for any added/removed exports, ensure all re-exports are in place
5. **Summary:** List every new file created, every file modified, and the before/after line counts

**Invoke the Code Reviewer sub-agent one final time to do a complete pass over ALL changes across all 7 phases. Verify consistency of patterns, correct re-exports, no orphaned imports, and adherence to project conventions.**
