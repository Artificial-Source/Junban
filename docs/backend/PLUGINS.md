# Plugin Subsystem

This document covers the internal plugin architecture in `src/plugins/`. It is for Junban contributors working on plugin discovery, loading, permissions, runtime cleanup, and the plugin-facing API surface.

For author-facing documentation, see:

- `docs/plugins/README.md`
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

module load:
  built-in plugin   -> trusted dynamic import()
  community plugin  -> vm sandbox execute() with local-only module linker
```

On unload, the system should reverse plugin-owned registrations and detach listeners cleanly.

## Layout

```text
src/plugins/
  api.ts                Permission-gated plugin API factory
  command-registry.ts   Plugin command registry
  compatibility.ts      Manifest/app/API/dependency compatibility checks
  installer.ts          Download/install/uninstall helpers
  lifecycle.ts          Base Plugin class
  loader.ts             Discovery and activation flow
  network-policy.ts     Shared outbound URL validation for runtime/install
  registry.ts           Community plugin registry client
  route-policy.ts       Shared route-level policy/permission helpers
  sandbox.ts            Sandbox hook point
  settings.ts           Per-plugin settings manager
  timeblocking-rpc-validation.ts Shared RPC input validation for timeblocking routes
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
- calling lifecycle hooks with timeouts (task hooks are only wired when `task:read` is granted)
- cleaning up commands, UI, providers, tools, and event listeners on failure or unload

### Built-in vs community contributor checklist

Before changing plugin loading or runtime code, decide which path you are touching:

| Concern          | Built-in plugin path               | Community plugin path                                |
| ---------------- | ---------------------------------- | ---------------------------------------------------- |
| Runtime loader   | Host loader / native import path   | `sandbox.ts` VM execution                            |
| Module freshness | Temp staged copy per load          | Fresh sandbox/module cache per load                  |
| UI strategy      | React/text/structured all possible | Prefer text/structured                               |
| Policy gates     | Activation/toggle rules            | Activation, approval, and community enablement rules |
| Common risk      | Stale native module cache          | Sandbox escape / unsupported module syntax           |

Any change in loader behavior should be reviewed against both columns.

### Compatibility enforcement policy

Compatibility checks are enforced as **hard rejections** (not warnings) in discovery/install paths and as hard load failures for dependency resolution:

- `minJunbanVersion` must be valid semver (`x.y.z`) and must be `<=` the running Junban app version.
- `targetApiVersion` (when provided) must be valid semver and must match the current Plugin API **major** version.
- Plugins with incompatible manifest versions are skipped during `discover()` / `discoverBuiltin()` / `discoverOne()`.
- Installer rejects archives whose manifest is version-incompatible (and also rejects manifest ID mismatch vs requested install ID).
- Declared plugin dependencies are enforced at load time:
  - dependency plugin ID must be valid and discovered
  - dependency version must satisfy the declared constraint (`x.y.z`, `^`, `~`, `<`, `<=`, `>`, `>=`, `=`)
  - dependency must be loadable/active before the dependent plugin can load
  - circular dependency chains are rejected

### Plugin ID collision policy

Plugin IDs are unique across the full loader map (built-in + community).

- Built-in plugins take precedence over community plugins for the same ID, regardless of whether `discover()` or `discoverBuiltin()` ran first.
- If a community plugin is already registered and a built-in with the same ID is discovered later, the built-in replaces it in loader state.
- If discovery finds the same ID from a different path/source (without built-in precedence), the new plugin is rejected.
- Existing loader state is preserved (no silent overwrite of enabled/instance/runtime state).
- `discoverOne()` requires `manifest.id` to exactly match the requested/directory `pluginId`; mismatches are rejected.
- `discoverOne()` follows the same collision rules, so install-time discovery cannot shadow an existing plugin.

In normal startup (`discoverBuiltin()` before community `discover()`), this also prevents community plugins from shadowing built-in extensions.

### Built-in vs community plugins

The loader treats built-in and community plugins differently:

- Community plugins are affected by the community-plugin enablement setting and permission approval flow.
- Built-in extensions are trusted from a manifest perspective but still remain explicitly activated by the user.
- Built-in extensions loaded via native `import()` are staged into a fresh temp directory per load so entry and dependency modules both get fresh module URLs (avoids stale dependency caches on unload/reload or reinstall-at-same-path).
- Community plugins execute in a fresh sandbox per load; sandbox module cache is scoped to that sandbox and is destroyed on unload.

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

Route-layer policy and validation that must stay consistent across Hono and Vite surfaces is intentionally shared in:

- `route-policy.ts` for community-plugin gating, settings permission checks, and approval payload validation
- `timeblocking-rpc-validation.ts` for RPC payload and argument validation

There is a third surface to remember: frontend direct-services mode in `src/ui/api/plugins.ts`. Built-in plugin manifest-derived policy is mirrored there for desktop mode, and drift is guarded by `tests/ui/api/plugins.policy-sync.test.ts`.

`network.fetch()` is additionally guarded by a shared outbound URL policy (`src/plugins/network-policy.ts`):

- only `http:` / `https:` schemes are allowed
- local/internal targets are blocked (`localhost`, `127.0.0.0/8`, `::1`, private/link-local ranges, IPv4-mapped IPv6 private/loopback forms, `.local`, `.internal`, `.localhost`)
- redirect responses are blocked (no automatic redirect-follow)
- blocked calls throw clear runtime errors before issuing a request

## Settings

`src/plugins/settings.ts` manages per-plugin settings and storage-backed values.

Responsibilities:

- load persisted values
- expose plugin-scoped reads and writes
- enforce the `settings` permission for plugin settings access
- validate writes against manifest-defined setting IDs/types/constraints
- fall back to manifest-defined defaults where appropriate
- persist updates through the shared storage layer

This manager supports both plugin settings UX and plugin key-value storage behavior.

Implementation note: settings writes and storage writes use separate manager entry points so manifest validation cannot be bypassed accidentally.

Frontend direct-services mode mirrors these rules and now fails explicitly for unsupported plugin-management actions instead of silently no-oping.

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

UI registration IDs are normalized to plugin-scoped IDs (`<pluginId>:<localId>`) by the registry. This prevents cross-plugin ID collisions from silently overwriting panels, views, or status items.

The UI registry gives the frontend a stable way to discover plugin-owned UI without the loader or plugin instances leaking directly into React code.

## Registry And Installation

Two files support community plugin distribution:

- `registry.ts` for reading/searching the plugin registry metadata
- `installer.ts` for downloading and installing plugin archives

Install/download URLs are validated with the same shared outbound URL policy used by plugin runtime networking. For installs, HTTPS is required, local/internal destinations are rejected, and redirect responses are blocked.

Both the Hono server routes and the Vite dev middleware use the same shared policy helpers so plugin approval, toggle, settings, install, and timeblocking RPC behavior stay aligned across dev and production paths.

This keeps discovery metadata separate from installation and runtime activation concerns.

## Sandbox

`src/plugins/sandbox.ts` provides runtime isolation for **community** plugins.

Current behavior:

- Community plugins execute in a dedicated `vm` context.
- The sandbox global object is restricted and does not expose `process`, `global`, or host process globals directly.
- Community plugins cannot import `node:` built-ins or bare package specifiers.
- ESM `import` / dynamic `import()` are blocked in the community sandbox.
- `import.meta` is explicitly rejected in the community sandbox with a clear error.
- Community plugins may only load relative local files via `require()` and must stay inside their own plugin directory.
- Community plugins must use JavaScript module files (`.js`, `.mjs`, `.cjs`) at runtime.
- Sandbox source preflight blocks real `import` syntax while ignoring comment/string text (to avoid false positives).
- Sandbox `destroy()` clears tracked `setTimeout`/`setInterval` handles to reduce post-unload execution.

Built-in extensions remain trusted and use the host loader path.

Permission checks in `createPluginAPI()` are still required. The sandbox is an additional boundary, not a replacement for capability gating.

### Sandbox mechanics that matter when editing it

The sandbox does more than run code in a VM:

1. It preflights source to reject unsupported module syntax such as real `import` usage while ignoring comment/string false positives.
2. It resolves only relative local files and validates real paths so plugins cannot escape their own directory via symlinks or traversal.
3. It tracks timers and intervals so `destroy()` can shut them down on unload/failure.
4. It keeps a sandbox-local module cache so community plugin reloads start from a clean runtime.

## Runtime Cleanup

Plugin cleanup is a first-class requirement, not a nice-to-have.

When a plugin unloads or fails during load, the system should clean up:

- command registrations
- UI registrations
- AI provider registrations
- AI tool registrations
- event listeners tracked by the loader

This is one of the most important invariants in the subsystem.

When adding a new plugin-owned registration surface, update unload and load-failure cleanup in the same change and add a regression test for it.

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
