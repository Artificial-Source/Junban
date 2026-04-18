# Plugin system as a guarded extension boundary

Junban treats plugins as an extension boundary, not an alternate product core. The domain model (tasks, projects, tags, reminders, stats, etc.) remains in `src/core/`; plugins are allowed to _contribute_ via explicit extension points.

This is the key boundary discipline:

- Core semantics stay invariant.
- Extensions can only act through declared, capability-gated APIs.
- The loader and registries enforce lifecycle safety so unload/reload does not leak runtime state.

## Extension entry and composition points

`src/plugins/loader.ts` is the composition root for plugin behavior. The important idea is not the step-by-step loader sequence, but the boundary it enforces: discovery, approval, API creation, load, and cleanup are controlled by the host rather than by plugin code.

## Permission-gated API as capability boundary

`src/plugins/api.ts` exposes one concrete API object per plugin and always returns the same method shape.

Behavior is enforced dynamically:

- API methods are always present.
- Missing permissions produce deterministic runtime errors that include the permission and calling method.
- This gives plugin authors a stable typing model while keeping safety checks strict.

That design avoids “optional method” drift and prevents plugin code from testing behavior on `undefined` capabilities.

## Built-in vs community plugin paths

The system intentionally has two execution paths:

- **Built-in plugins** use trusted native loading via `import()`.
- **Community plugins** execute through the VM sandbox in `src/plugins/sandbox.ts`.

Both paths use the same permission model and register through the same registries, but they differ in trust assumptions and runtime constraints.

### Runtime and policy implications

- Community plugins do not get direct Node builtins or host globals.
- Import style and module resolution are constrained for community plugins.
- `import.meta`, bare imports, and disallowed URL/host access are blocked.
- Network requests from plugin runtime pass shared policy checks (`src/plugins/network-policy.ts`).
- Module state is scoped per plugin load so unload can be deterministic.

This is not “less powerful” for the sake of friction; it is the boundary that lets community code participate while keeping host safety as a hard invariant.

## Registries: decoupling and cleanup

Junban tracks plugin contributions centrally so unload and failure cleanup do not rely only on plugin discipline. That is why commands, UI contributions, and plugin-scoped settings go through host-owned registries and managers.

## Lifecycle safety and invariants

Loader and plugin lifecycle code enforces three invariants:

1. **Activation intent is explicit**

   A plugin instance is only active when approved/activated according to manifest and permission state.

2. **Load failures do not partially mutate global runtime state**

   Failed loads are cleaned up before activation continues.

3. **Unloads restore host state deterministically**

   Command/UI/tool/provider/event hooks are removed via registries.

This is what keeps plugin behavior restartable across updates and test runs.

## Optionality and environment split

The same loader graph is used by Node, web, and direct-services code paths, but environment constraints differ:

- Approval, permission, and discovery logic is central and shared.
- Execution strategy differs for built-ins vs community and for web bootstrap constraints.

The boundary lets Junban keep “plugin features are optional” as a runtime property, not a branchy exception in domain code.

## Relationship to AI and MCP

Plugins can contribute AI tools/providers and UI commands through the same extension points used by core AI tooling, and MCP surfaces those tools from the shared tool registry.

So plugin extensibility remains compatible with external protocol surfaces without creating dedicated plugin-to-MCP code paths.

## Tradeoffs to keep in mind

1. **Powerful customization vs attack surface**

   Plugins expand behavior significantly, so sandboxing and capability checks are non-negotiable boundaries.

2. **Speed of extension vs strict loading costs**

   Validation, approval, and registration add startup overhead, but preserve deterministic behavior.

3. **Shared APIs vs plugin-specific ergonomics**

   A single API surface reduces entropy and drift, but means plugin capability changes must be made deliberately through the loader/API contract.

## What must stay true

- Extensions should act through capability-gated APIs rather than host internals.
- Community plugins should stay behind explicit enablement and approval steps.
- The host should retain responsibility for cleanup and lifecycle safety.

## See also

- [`architecture.md`](./architecture.md)
- [`../reference/backend/PLUGINS.md`](../reference/backend/PLUGINS.md)
- [`../reference/plugins/README.md`](../reference/plugins/README.md)
- [`../reference/plugins/API.md`](../reference/plugins/API.md)
- [`../reference/plugins/EXAMPLES.md`](../reference/plugins/EXAMPLES.md)
