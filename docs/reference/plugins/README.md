# Plugin Docs

This section is the fastest way for developers and AI agents to understand how to build plugins for Junban.

## Read In This Order

1. `docs/reference/plugins/API.md`
2. `docs/reference/plugins/EXAMPLES.md`
3. `docs/reference/backend/PLUGINS.md` if you need loader/runtime internals

## Choose Your Path

| You want to... | Read this first |
| --- | --- |
| Build a community plugin | `API.md` sections on manifest, permissions, sandbox rules, UI, settings, storage, and network |
| Build a built-in plugin | `API.md`, then `EXAMPLES.md`, then `docs/reference/backend/PLUGINS.md` |
| Copy a working pattern | `EXAMPLES.md` |
| Understand why a plugin will not load | `API.md` manifest/lifecycle sections and `docs/reference/backend/PLUGINS.md` compatibility policy |
| Change plugin internals | `docs/reference/backend/PLUGINS.md` |

## First Principles

- Every plugin has a `manifest.json` and a runtime entry file such as `index.mjs`.
- `this.app` is always present. Missing permissions throw clear runtime errors instead of giving you `undefined` APIs.
- `settings` is for user-facing configuration. `storage` is for plugin-owned state.
- Commands, views, panels, and status-bar items are removed automatically on unload.
- Community plugins are sandboxed and must be self-contained JavaScript modules.

## Built-in Vs Community Plugins

| Capability | Built-in | Community |
| --- | --- | --- |
| Language/runtime | App-compiled TypeScript/React allowed | JavaScript runtime files only |
| Module loading | Host loader / native import path | Sandboxed VM with local-only `require()` |
| React UI | Supported | Not portable; prefer `structured` content |
| Node built-ins / host globals | Trusted app code | Blocked |
| Permission approval flow | Explicit activation | Explicit activation plus permission approval |

Junban now treats advanced built-in experiences like `timeblocking`, `pomodoro`, `stats`, `calendar`, `matrix`, `someday`, `completed`, `cancelled`, and `quick wins` as optional extensions instead of core-default views.

## Common Mistakes

- Using `import`, `import()`, or `import.meta` in a community plugin.
- Forgetting the `settings` permission while calling `this.settings.get()` / `this.settings.set()`.
- Putting internal state in `settings` instead of `storage`.
- Assuming local UI IDs are global. Junban namespaces them by plugin automatically.
- Assuming a plugin can reach localhost or private network hosts through `network.fetch()`.
