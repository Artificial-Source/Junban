# AI and MCP as shared execution surfaces

Junban’s AI and MCP layers are intentionally built on top of the same domain services and storage-backed tool definitions as the rest of the app.

The architectural question is not “how do we expose features twice,” but “how do we expose one domain through different runtimes without duplicating business logic?”

## Shared contract foundation

Both AI tool execution and MCP tool execution are based on `ToolRegistry` definitions.

- Tool definitions come from `src/ai/tools/` and are registered centrally.
- Tool execution gets a service context (`TaskService`, `ProjectService`, `TagService`, `StatsService`) with the same domain invariants as UI/API/CLI paths.
- MCP then forwards those same definitions; it does not reimplement tool logic.

This keeps behavior stable even as transport changes.

## AI architecture layers

The AI stack is split into layered responsibilities:

- **Provider registry (`src/ai/provider/registry.ts`)** — tracks provider metadata, model discovery, and executor creation.
- **Provider factories (`src/ai/provider-node.ts`, `src/ai/provider.ts`)** — split Node and browser startup paths so browser starts lighter by default.
- **Chat orchestration (`src/ai/chat.ts`)** — runs prompt/tool loops, sessions, compaction, and concurrency control.
- **Tool registry (`src/ai/tools/registry.ts`) + built-ins (`src/ai/tool-registry.ts`)** — holds executable tool definitions and enforces per-tool timeouts.

A practical invariant here is separation of concerns:

- providers decide *how* to call models,
- tools decide *what* app actions are callable,
- chat orchestrator decides *when/with what context* those tools run.

## Runtime split (Node vs browser)

AI runtime setup is not identical across execution modes:

- Node path uses `createDefaultRegistry` from `provider-node.ts`, registering built-ins eagerly.
- Browser/Tauri path uses async/lazy registry creation in `src/ai/provider.ts` and `src/bootstrap-web-ai-runtime.ts` so optional provider modules are not pulled into early startup paths.

This keeps cold-start and bundle impact predictable for desktop/web while preserving the same logical capabilities.

## AI as optional capability

AI is optional by design:

- Feature registration and execution paths can remain dormant when no provider is configured.
- Local-provider behavior is intentionally constrained, and the chat/tool loop is guarded with timeouts and related safety checks.
- Chat history and provider-specific settings stay integrated with storage (`IStorage`) rather than introducing standalone stores.

## MCP as protocol adapter, not a second domain

`src/mcp/server.ts` creates the same app services as other runtimes and then exposes:

- tool handlers from `ToolRegistry`,
- resources from shared service reads,
- prompts from `src/mcp/prompts.ts`.

Two concrete guardrails make MCP robust:

- JSON-RPC tool schemas pass through `schema-converter.ts` so MCP validation matches expected tool shapes.
- MCP requires protocol-clean output discipline on stdio, so runtime logs are routed to stderr in `src/mcp/server.ts`.

The MCP layer therefore acts as transport projection of existing behavior rather than another product model.

## Cross-system invariants

1. **Tool inventory single source of truth**

   MCP uses the same `ToolRegistry` source as AI. This avoids drift between AI and MCP feature sets.

2. **Error model normalization**

   MCP wraps known domain errors into MCP error text responses to keep wire behavior stable under client tools.

3. **Context continuity**

   Both AI tool calls and MCP calls operate against the same service graph, so the same authorization checks, validation, and storage contract apply.

4. **Non-fragmented extension model**

   Plugin-registered AI tools are treated like built-ins in the same registry path, so MCP inherits plugin extensibility naturally.

Voice sits next to this architecture rather than inside the same explanation scope. The voice subsystem has its own adapters and registry under `src/ai/voice/`, and the repository treats it as a related but separate technical surface.

Plugins can also extend the broader AI stack through the plugin API, including plugin-scoped tools, LLM provider registration, and voice provider registration paths that feed the same shared registries used elsewhere.

## Tradeoffs and constraints

1. **Flexibility vs startup cost**

   Pluggable provider registry and lazy browser loading improve startup behavior but add initialization complexity.

2. **Protocol compliance vs convenience**

   MCP stdio requires strict output discipline; this constrains logging and debug patterns in that path.

3. **Optional AI vs deterministic behavior**

   AI adds asynchronous loops and tool execution dynamics, so concurrency and timeout controls are required at chat orchestration and tool execution levels.

## What must stay true

- AI tools and MCP tools should continue to reuse the same underlying tool and service model.
- MCP should stay an adapter layer, not a second business-logic layer.
- Optional AI features should not become an unconditional startup cost.

## See also

- [`architecture.md`](./architecture.md)
- [`../reference/backend/AI.md`](../reference/backend/AI.md)
- [`../reference/backend/MCP.md`](../reference/backend/MCP.md)
- [`../reference/backend/STORAGE.md`](../reference/backend/STORAGE.md)
- [`../reference/plugins/API.md`](../reference/plugins/API.md)
