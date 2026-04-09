# Plugin Subsystem

This document covers the internal plugin architecture in `src/plugins/`. It is for Junban contributors working on plugin discovery, loading, permissions, runtime cleanup, and the plugin-facing API surface.

For author-facing documentation, see:

- `docs/plugins/API.md`
- `docs/plugins/EXAMPLES.md`

## Goals

The plugin system is designed to support a few product goals at once:

- Keep the app extensible without turning every feature into core code
- Preserve explicit permission boundaries
- Keep the API usable for both human authors and code generation tools
- Let plugins extend commands, UI, settings, and AI safely

## High-Level Flow

```text
Plugin discovery -> manifest validation -> approval/permission check -> API creation -> module load -> plugin instance -> onLoad -> active runtime
```

On unload, the system should reverse plugin-owned registrations and detach listeners cleanly.

## Layout

```text
src/plugins/
  api.ts                Permission-gated plugin API factory
  command-registry.ts   Plugin command registry
  installer.ts          Download/install/uninstall helpers
  lifecycle.ts          Base Plugin class
  loader.ts             Discovery and activation flow
  registry.ts           Community plugin registry client
  sandbox.ts            Sandbox hook point
  settings.ts           Per-plugin settings manager
  types.ts              Manifest, settings, and permission schemas
  ui-registry.ts        Plugin panels, views, status items
  builtin/              Built-in extensions bundled with the app
```

## Manifest And Permissions

`src/plugins/types.ts` defines the plugin manifest schema, plugin setting definitions, and the recognized permission list.

Current permission groups cover:

- task access
- project access
- tag access
- UI registration
- commands
- plugin storage/settings
- network access
- AI provider and tool registration

The exact permission list is defined in `VALID_PERMISSIONS` and should be treated as the source of truth.

## Loader

`src/plugins/loader.ts` is the main orchestration layer.

It is responsible for:

- discovering plugin directories
- validating `manifest.json`
- distinguishing built-in vs community plugins
- enforcing activation and approval rules
- creating the plugin API instance
- loading the plugin module
- calling lifecycle hooks with timeouts
- cleaning up commands, UI, providers, tools, and event listeners on failure or unload

### Built-in vs community plugins

The loader treats built-in and community plugins differently:

- Community plugins are affected by the community-plugin enablement setting and permission approval flow.
- Built-in extensions are trusted from a manifest perspective but still remain explicitly activated by the user.

This distinction matters when modifying loader behavior.

### Approval model

Permissions are not simply whatever the manifest requests.

For community plugins, the effective permissions are the intersection of:

- requested permissions from the manifest
- approved permissions stored by the app

If a plugin has never been approved and requests permissions, it stays pending instead of loading.

## Lifecycle Base Class

`src/plugins/lifecycle.ts` provides the base `Plugin` class that plugin implementations extend.

The loader injects:

- `app` for the plugin-facing API
- `settings` for plugin settings access

The two main lifecycle hooks are:

- `onLoad()`
- `onUnload()`

Contributors working on lifecycle behavior should preserve the rule that plugins must be able to clean up after themselves without leaving orphaned listeners or registrations.

## Plugin API Surface

`src/plugins/api.ts` builds a permission-gated API object per plugin.

Design properties:

- API methods are always present
- Missing permissions produce clear runtime errors
- plugin authors do not have to optional-chain every namespace
- AI, UI, data, and command extensions all flow through one explicit surface

Major namespaces include:

- `tasks`
- `projects`
- `tags`
- `commands`
- `ui`
- `storage`
- `network`
- `events`
- `ai`
- `settings`

The plugin API version and stability metadata are also defined here.

## Settings

`src/plugins/settings.ts` manages per-plugin settings and storage-backed values.

Responsibilities:

- load persisted values
- expose plugin-scoped reads and writes
- fall back to manifest-defined defaults where appropriate
- persist updates through the shared storage layer

This manager supports both plugin settings UX and plugin key-value storage behavior.

## Command Registry

`src/plugins/command-registry.ts` stores plugin-provided commands.

It exists so commands can be:

- registered without directly coupling to the UI layer
- executed programmatically
- cleaned up per plugin on unload

## UI Registry

`src/plugins/ui-registry.ts` stores plugin-provided UI extensions.

Current extension categories include:

- sidebar panels
- custom views
- status bar items

The UI registry gives the frontend a stable way to discover plugin-owned UI without the loader or plugin instances leaking directly into React code.

## Registry And Installation

Two files support community plugin distribution:

- `registry.ts` for reading/searching the plugin registry metadata
- `installer.ts` for downloading and installing plugin archives

This keeps discovery metadata separate from installation and runtime activation concerns.

## Sandbox

`src/plugins/sandbox.ts` is the sandbox hook point.

The current system relies primarily on permission-gated API access and controlled registrations rather than full process isolation. If you change this area, be explicit about whether you are changing:

- API-level capability gating
- runtime isolation
- both

Do not describe stronger isolation guarantees in docs than the code actually provides.

## Runtime Cleanup

Plugin cleanup is a first-class requirement, not a nice-to-have.

When a plugin unloads or fails during load, the system should clean up:

- command registrations
- UI registrations
- AI provider registrations
- AI tool registrations
- event listeners tracked by the loader

This is one of the most important invariants in the subsystem.

## Design Constraints

When working on the plugin system:

1. Preserve explicit permission checks.
2. Keep the plugin API understandable and stable.
3. Distinguish clearly between built-in and community plugin behavior.
4. Treat cleanup on unload and load failure as mandatory.
5. Keep author-facing docs in sync with internal API changes.
6. Avoid over-claiming sandbox guarantees.

## Related Docs

- `docs/plugins/API.md`
- `docs/plugins/EXAMPLES.md`
- `docs/backend/AI.md`
- `docs/frontend/VIEWS.md`
- `docs/guides/ARCHITECTURE.md`
