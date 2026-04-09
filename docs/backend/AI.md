# AI Subsystem

This document describes the internal AI architecture in `src/ai/`. It is intended for Junban contributors working on chat, providers, tool calling, and voice integration.

The goal of the subsystem is consistent across the codebase:

- AI is optional
- Provider integrations are swappable
- Tool calls act on the same core services and data model as the rest of the app
- Browser startup should not eagerly load unnecessary AI runtime code

## Main Responsibilities

The AI subsystem covers four main areas:

- Chat session management
- Provider registration and execution
- Tool registration and execution
- Voice provider infrastructure

At a high level:

```text
User chat or voice input -> chat session -> pipeline -> provider executor -> tool calls -> core services -> storage
```

## Layout

```text
src/ai/
  chat.ts                 Chat sessions and manager
  chat-prompts.ts         System-prompt construction and local-provider tool limits
  message-utils.ts        Message serialization helpers
  errors.ts               Provider error classification
  model-discovery.ts      Provider-backed model discovery helpers
  provider.ts             Browser/default async provider registry factory
  provider-node.ts        Node provider registry factory
  tool-registry.ts        Built-in tool registration
  types.ts                Shared AI types

  core/
    context.ts            Pipeline execution context
    pipeline.ts           Middleware pipeline
    middleware.ts         Timeout/logging/capability middleware
    capabilities.ts       Capability descriptors

  provider/
    interface.ts          Provider and executor interfaces
    registry.ts           Provider registry
    adapters/             Built-in provider adapters

  tools/
    registry.ts           Tool registry
    types.ts              Tool types and tool context
    builtin/              Built-in tool registration modules

  voice/
    interface.ts          STT/TTS interfaces
    registry.ts           Voice provider registry
    provider.ts           Default voice registry setup
    adapters/             Built-in voice providers
```

## Chat Layer

`src/ai/chat.ts` is the main orchestration file for conversational AI.

It owns:

- Chat session state
- Message persistence and restoration
- The LLM/tool loop
- Conversation compaction when context gets too large
- Local-provider tool limiting
- Streaming timeout protection

Important behaviors in the current implementation:

- Sessions serialize concurrent runs so multiple overlapping calls do not corrupt message state.
- Long conversations can be compacted into a summary while keeping recent turns.
- Local providers use a reduced tool set via `LOCAL_PROVIDER_TOOLS`.
- Tool-call loops are bounded and guarded against repeated call signatures.
- Persisted messages are restored through message utility helpers rather than trusting raw stored payloads.

Related files:

- `src/ai/chat-prompts.ts`
- `src/ai/message-utils.ts`

## Provider Layer

The provider layer separates provider registration from runtime execution.

Key files:

- `src/ai/provider/interface.ts`
- `src/ai/provider/registry.ts`
- `src/ai/provider-node.ts`
- `src/ai/provider.ts`

### Provider model

Providers register a plugin-like definition that can:

- describe display and configuration metadata
- create an executor for a concrete config
- discover models
- optionally load or unload models for local runtimes

Executors are the runtime objects that actually process requests.

### Runtime split

There are separate registry factories for Node and browser-style startup:

- `provider-node.ts` registers built-ins for Node paths
- `provider.ts` lazy-loads provider modules for browser/Tauri paths

This keeps the browser startup bundle lighter while preserving the same logical provider surface.

### Built-in providers

Built-in adapters live in `src/ai/provider/adapters/`.

The exact provider list may change over time, so this doc does not treat the set as canonical metadata. Check the adapter directory and the registry factories for the current built-ins.

## Pipeline Layer

The pipeline lives in `src/ai/core/`.

Purpose:

- Normalize execution flow around providers
- Apply middleware consistently
- Carry provider capabilities and request metadata through execution

Key files:

- `context.ts` defines the execution context and result shape
- `pipeline.ts` composes middleware around provider execution
- `middleware.ts` contains built-in middleware such as capability guards and timeouts
- `capabilities.ts` defines provider/model capability descriptors

The pipeline should remain thin and transport-agnostic. Chat sessions decide when to run it; providers decide how to execute; middleware adds cross-cutting behavior.

## Tool Layer

The tool system lives in `src/ai/tools/`.

It is responsible for:

- registering tool definitions
- executing tool calls with access to Junban services
- keeping tool behavior aligned with normal app behavior

The registry entry point for built-ins is `src/ai/tool-registry.ts`.

Design rule:

- AI tools should call shared domain services and use the same rules as the UI, API, CLI, and plugins

That keeps task/project mutations consistent regardless of how they were initiated.

### Built-in tool categories

Built-in tools cover areas such as:

- task CRUD
- project and tag operations
- querying and filtering
- planning and review flows
- organization and analysis
- memory and estimation helpers

For the current list, inspect `src/ai/tools/builtin/` and `src/ai/tool-registry.ts`.

## Voice Layer

The voice subsystem lives in `src/ai/voice/`.

It provides:

- STT/TTS interfaces
- provider registry infrastructure
- default provider wiring
- browser, hosted, and local adapters

The frontend mounts voice features on demand through feature-scoped providers, while the backend/runtime code for voice stays in this subsystem.

See `docs/backend/VOICE.md` for the voice-specific reference.

## Error Handling

`src/ai/errors.ts` classifies provider and network failures into structured categories.

Design intent:

- surface actionable auth/config issues clearly
- mark retryable failures where appropriate
- keep provider-specific error quirks from leaking everywhere else in the codebase

## Model Discovery

`src/ai/model-discovery.ts` provides provider-backed model lookup and local-model lifecycle helpers.

This module exists so the UI and related integrations can query model availability without knowing provider internals.

## Browser Loading Strategy

The browser/Tauri path lazy-loads the AI runtime through `src/bootstrap-web-ai-runtime.ts`.

That runtime provides:

- `ChatManager`
- provider registry
- tool registry

This is an important startup optimization and should be preserved when expanding AI features.

## Design Constraints

When changing the AI subsystem:

1. Keep AI optional.
2. Reuse core services instead of inventing AI-only data paths.
3. Preserve the Node/browser provider split.
4. Avoid coupling provider-specific behavior into unrelated layers.
5. Keep tool registration centralized and auditable.
6. Treat long-running streams and tool loops defensively.

## Related Docs

- `docs/backend/VOICE.md`
- `docs/backend/CORE.md`
- `docs/frontend/CONTEXT.md`
- `docs/frontend/VIEWS.md`
- `docs/guides/ARCHITECTURE.md`
