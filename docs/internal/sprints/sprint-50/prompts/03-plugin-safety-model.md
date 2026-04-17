# S50-P3: Obsidian-Style Plugin Safety Model

## Context

You are working on ASF Junban, an AI-native task manager with an Obsidian-style plugin system. Currently, community plugins require permission approval before loading, but there's no master "safe mode" toggle. We want to add an Obsidian-inspired safety layer.

**Tech stack:** React + TypeScript + Tailwind CSS, Hono API server, Vitest tests, pnpm.

## Goal

Add a "Restricted Mode" for community plugins — OFF by default, requiring explicit opt-in before any community plugin can be enabled. Built-in plugins (pomodoro, timeblocking) are always available.

## Phase 1: Add the Setting

### 1a. Add `community_plugins_enabled` to GeneralSettings

**File:** `src/ui/context/SettingsContext.tsx`

Add to the `GeneralSettings` interface:

```typescript
community_plugins_enabled: "true" | "false";
```

Add to `DEFAULT_SETTINGS`:

```typescript
community_plugins_enabled: "false",
```

**Before proceeding to Phase 2, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

## Phase 2: Update Plugins Tab UI

**File:** `src/ui/views/settings/PluginsTab.tsx`

Read this file completely first to understand the current layout.

### 2a. Add Restricted Mode Banner

At the top of the Plugins tab (above the existing content), add a banner when `community_plugins_enabled` is `"false"`:

```tsx
{
  settings.community_plugins_enabled !== "true" && (
    <div className="mb-4 p-4 rounded-lg border border-warning/30 bg-warning/5">
      <div className="flex items-start gap-3">
        <ShieldCheck size={20} className="text-warning mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-on-surface">Restricted Mode is ON</h3>
          <p className="text-xs text-on-surface-muted mt-1">
            Community plugins are disabled for security. Only built-in extensions can be enabled.
            Community plugins can execute arbitrary code — only enable this if you trust your plugin
            sources.
          </p>
          <button
            onClick={() => setShowSafetyDialog(true)}
            className="mt-2 text-xs font-medium text-accent hover:underline"
          >
            Turn off Restricted Mode
          </button>
        </div>
      </div>
    </div>
  );
}
```

Import `ShieldCheck` from `lucide-react`.

### 2b. Add Safety Confirmation Dialog

When the user clicks "Turn off Restricted Mode", show a confirmation dialog:

```tsx
{
  showSafetyDialog && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface rounded-xl shadow-2xl max-w-sm w-full mx-4 border border-border p-5">
        <div className="flex items-center gap-3 mb-3">
          <ShieldAlert size={24} className="text-warning" />
          <h3 className="text-base font-semibold text-on-surface">Enable community plugins?</h3>
        </div>
        <p className="text-sm text-on-surface-muted mb-4">
          Community plugins are created by third-party developers and can run arbitrary code on your
          machine. Only enable plugins from sources you trust.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setShowSafetyDialog(false)}
            className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary rounded-lg"
          >
            Keep Restricted
          </button>
          <button
            onClick={() => {
              updateSetting("community_plugins_enabled", "true");
              setShowSafetyDialog(false);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-warning hover:bg-warning/90 rounded-lg"
          >
            I understand, enable
          </button>
        </div>
      </div>
    </div>
  );
}
```

Import `ShieldAlert` from `lucide-react`.

### 2c. Grey Out Community Plugins When Restricted

In the community plugins section of PluginsTab, when `community_plugins_enabled` is `"false"`:

- Show community plugins in a greyed-out state (opacity-50)
- Disable their enable/toggle buttons
- Show a small lock icon or "Enable community plugins first" tooltip

Read `src/ui/components/plugin-browser/SettingsPluginCard.tsx` to understand the plugin card component. Add an `isRestricted?: boolean` prop that disables interactive elements.

### 2d. Add "Restricted Mode" Toggle to Plugins Tab Header

Add a toggle in the Plugins tab header area that lets users quickly turn restricted mode on/off (with the safety dialog when turning OFF restricted mode):

```tsx
<div className="flex items-center justify-between mb-4">
  <div>
    <h3 className="text-sm font-medium text-on-surface">Community Plugins</h3>
    <p className="text-xs text-on-surface-muted">Third-party extensions from the plugin registry</p>
  </div>
  <div className="flex items-center gap-2">
    <span className="text-xs text-on-surface-muted">
      {settings.community_plugins_enabled === "true" ? "Enabled" : "Restricted"}
    </span>
    <Toggle
      enabled={settings.community_plugins_enabled === "true"}
      onToggle={() => {
        if (settings.community_plugins_enabled === "true") {
          updateSetting("community_plugins_enabled", "false");
        } else {
          setShowSafetyDialog(true);
        }
      }}
    />
  </div>
</div>
```

**Before proceeding to Phase 3, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

## Phase 3: Backend Enforcement

### 3a. Plugin API Route Check

**File:** `src/api/plugins.ts`

When handling community plugin toggle/enable requests, check the `community_plugins_enabled` setting. Read the file to find the toggle endpoint.

Before loading a community plugin, verify the setting is enabled:

```typescript
// In the toggle handler, before loading a community plugin:
const communityEnabled = services.storage.getAppSetting("community_plugins_enabled");
if (!loaded.builtin && communityEnabled !== "true") {
  return c.json(
    { error: "Community plugins are disabled. Enable them in Settings > Plugins." },
    403,
  );
}
```

### 3b. Plugin Loader Check

**File:** `src/plugins/loader.ts`

In the `load()` method, add a check for community plugins. The loader needs access to the storage to read the setting. Since `PluginServices` already has a `queries` field (which is `IStorage`), use that:

```typescript
// In load(), after the existing permission checks but before loading:
if (!loaded.builtin) {
  const communityEnabled = this.services.queries.getAppSetting("community_plugins_enabled");
  if (communityEnabled !== "true") {
    logger.info(`Community plugins disabled, skipping "${pluginId}"`);
    return;
  }
}
```

**Before proceeding to Phase 4, invoke the Code Reviewer sub-agent to verify all changes from this phase are correct, consistent, and follow project conventions. Fix any issues it finds before moving on.**

## Phase 4: Show Permissions for Built-in Plugins

### 4a. Built-in Plugin Enable Flow

Currently, built-in plugins can be toggled directly without showing permissions. Change this:

**File:** `src/ui/views/settings/PluginsTab.tsx` (or `SettingsPluginCard.tsx`)

When a user clicks to enable a built-in plugin for the first time:

1. Show the PermissionDialog (already exists at `src/ui/components/PermissionDialog.tsx`)
2. List the permissions the plugin requests
3. User clicks "Enable" to approve and load

Read `PermissionDialog.tsx` to understand its props. It should already handle this — the issue is that the UI might bypass it for built-in plugins. Ensure the same flow applies.

### 4b. Tests

Write tests for the new safety model:

**File:** `tests/plugins/safety-model.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("Plugin Safety Model", () => {
  it("community_plugins_enabled defaults to false", () => {
    // Verify the DEFAULT_SETTINGS value
  });

  it("community plugins cannot load when restricted mode is on", () => {
    // Mock storage with community_plugins_enabled = "false"
    // Attempt to load a community plugin
    // Expect it to be skipped
  });

  it("built-in plugins can load regardless of restricted mode", () => {
    // Mock storage with community_plugins_enabled = "false"
    // Attempt to load a built-in plugin
    // Expect it to load normally
  });

  it("community plugins can load when restricted mode is off", () => {
    // Mock storage with community_plugins_enabled = "true"
    // Attempt to load a community plugin
    // Expect it to proceed (may still need permission approval)
  });
});
```

Use the existing test patterns from `tests/plugins/` — read a few test files there to match conventions.

**After completing all phases, invoke the Code Reviewer sub-agent for a final pass over all changes. Verify:**

1. TypeScript compiles cleanly (`pnpm exec tsc --noEmit`)
2. ESLint passes on all modified files
3. All tests pass (`pnpm test`)
4. The restricted mode banner renders correctly
5. Community plugins are properly blocked when restricted
6. Built-in plugins are unaffected by restricted mode
7. The safety dialog appears before enabling community plugins
