# Developer Guide: Plugins

Canonical source: [`../../reference/plugins/README.md`](../../reference/plugins/README.md)

This page explains how plugin work is organized in Junban and where to go for deeper details.

## Two plugin audiences

- **Plugin authors**: build extensions against the public plugin API.
- **Core contributors**: maintain plugin runtime internals, loading, sandboxing, and policy enforcement.

Junban keeps these concerns separated to reduce accidental breakage.

## Plugin model at a glance

Built-in plugins are located in `src/plugins/builtin/`.

Community plugins are discovered under `plugins/` (or a custom directory from `PLUGIN_DIR`) and loaded through the runtime plugin directory loader.

Stable lifecycle shape:

```text
discover -> validate manifest -> permission/approval gates -> load -> onLoad -> active runtime
```

On unload/failure, plugin-owned registrations must be cleaned up.

## Built-in vs community plugins

- **Built-in plugins** are trusted app extensions but still explicitly activated.
- **Community plugins** run in a sandbox and follow permission approval flow.

Practical implication: do not assume runtime capabilities are identical across both classes.

## Permission-first API design

Plugin capabilities are permission-gated. Authors should request only what they need, and runtime code should preserve strict boundary checks.

Use canonical docs for exact permission names and behavior:

- Author surface: [`../../reference/plugins/API.md`](../../reference/plugins/API.md)
- Runtime internals: [`../../reference/backend/PLUGINS.md`](../../reference/backend/PLUGINS.md)

## What contributors should preserve

When editing plugin internals:

- Keep loader, sandbox, and permission policy aligned
- Keep unload/load-failure cleanup comprehensive
- Keep author-facing API and runtime behavior consistent
- Avoid adding undocumented hidden capability paths

## Where to continue

- Plugin docs index (author-first): [`../../reference/plugins/README.md`](../../reference/plugins/README.md)
- Plugin API reference: [`../../reference/plugins/API.md`](../../reference/plugins/API.md)
- Plugin examples: [`../../reference/plugins/EXAMPLES.md`](../../reference/plugins/EXAMPLES.md)
- Internal runtime docs: [`../../reference/backend/PLUGINS.md`](../../reference/backend/PLUGINS.md)
