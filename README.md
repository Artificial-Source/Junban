# ASF Saydo

**The task manager that doesn't exist yet.** Beautiful and simple out of the box, with a real AI assistant and a plugin system so simple that anyone can build features — no coding required.

Local-first. No accounts. No tracking. Your data stays on your machine.

Built by the [AI Strategic Forum (ASF)](https://github.com/asf-org) community.

<!-- ![Saydo Screenshot](docs/assets/screenshot.png) -->

## Why Saydo

Most task managers are either too simple (no AI, no extensibility) or too complex (enterprise bloat). Saydo sits in the middle:

- **Type naturally** — `buy milk tomorrow 3pm p1 #groceries +shopping` just works
- **Talk to AI** — a sidebar chat that actually sees your tasks, projects, and schedule
- **Speak instead of type** — voice input via browser, Groq, Inworld AI, or local models
- **Extend with plugins** — describe what you want to Claude or ChatGPT, drop the file in a folder, done
- **Own your data** — SQLite or Markdown files. Export anytime. No vendor lock-in.

## Quick start

```bash
git clone https://github.com/asf-org/saydo.git && cd saydo
pnpm install
cp .env.example .env
mkdir -p data && pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173`. Type a task. Press Enter.

For the desktop app (requires Rust + Tauri CLI):

```bash
pnpm tauri:dev
```

See the [local setup guide](docs/development/SETUP_LOCAL.md) for details.

## Features

| | |
|---|---|
| **Natural language input** | Dates, priorities, tags, and projects — parsed from plain text |
| **AI assistant** | Sidebar chat with task CRUD, scheduling, pattern analysis, workload insights |
| **Voice** | STT + TTS via browser, Groq, Inworld AI, Whisper, Kokoro, or Piper |
| **Plugins** | Obsidian-style — commands, sidebar panels, views, task hooks, storage |
| **Dual storage** | SQLite (default) or Markdown files with YAML frontmatter |
| **Sub-tasks & templates** | Break down work, reuse common patterns |
| **Recurring tasks** | Daily, weekly, monthly — with natural language scheduling |
| **Reminders** | Set reminders on any task, get notified when they're due |
| **Focus mode** | Distraction-free, keyboard-driven |
| **CLI companion** | `saydo add`, `saydo list`, `saydo done` from the terminal |
| **Themes** | Light/dark + custom CSS |
| **960+ tests** | Solid coverage across the entire codebase |

## Plugins

Plugins are TypeScript files you drop into `plugins/`. No build step.

```typescript
import { Plugin } from "@asf-saydo/plugin-api";

export default class MyPlugin extends Plugin {
  async onLoad() {
    this.app.commands.register({
      id: "hello",
      name: "Say Hello",
      callback: () => console.log("Hello from my plugin!"),
    });
  }

  async onUnload() {}
}
```

Plugins can register commands, add sidebar panels, add full-page views, hook into task events, and store data. The API is stable (v1.0.0, semver).

Docs: [Plugin API](docs/plugins/API.md) / [Examples](docs/plugins/EXAMPLES.md)

## AI assistant

The sidebar chat connects to your LLM provider. It sees your tasks, projects, and schedule — so it gives suggestions that are actually useful.

**19 built-in tools**: task CRUD, project management, reminders, pattern analysis, workload detection, smart organization, and energy-based scheduling recommendations.

Supported providers: OpenAI, Anthropic, OpenRouter, Ollama, LM Studio — or write a custom provider plugin.

Nothing AI-related runs unless you configure it. No keys are stored or proxied by Saydo.

## Voice

Full speech-to-text and text-to-speech pipeline. Pick your provider:

| Provider | Type | Notes |
|----------|------|-------|
| Browser Speech API | STT + TTS | Zero config, works everywhere |
| Groq | STT + TTS | Whisper STT + PlayAI TTS, free tier available |
| Inworld AI | TTS | High-quality voices, ~100-200ms latency, 15 languages |
| Whisper (local) | STT | Runs on your machine, no API key |
| Kokoro (local) | TTS | Local neural TTS via Web Worker |
| Piper (local) | TTS | Lightweight local TTS |

Voice activation with VAD (voice activity detection) — just start talking.

## Tech stack

| | |
|---|---|
| Runtime | Node.js 22, TypeScript |
| Desktop | Tauri v2 |
| Frontend | React 19, Tailwind CSS 4 |
| Database | SQLite (better-sqlite3 / sql.js) + Drizzle ORM |
| AI | OpenAI, Anthropic, OpenRouter, Ollama, LM Studio |
| Voice | Browser, Groq, Inworld AI, Whisper, Kokoro, Piper |
| CLI | Commander.js |
| Tests | Vitest (960+) |
| Build | Vite 6 |

## Status

v1.0 shipped. Desktop app works on Mac, Windows, Linux.

Latest additions: Inworld AI TTS, AI intelligence tools (pattern analysis, workload detection, smart organization), project & reminder AI tools, contextual settings UX.

Next milestone: **Saydo Sync** — optional paid cross-device sync.

## Docs

- [Architecture](docs/development/ARCHITECTURE.md) — how the codebase is organized
- [Local setup](docs/development/SETUP_LOCAL.md) — getting it running
- [Contributing](docs/development/CONTRIBUTING.md) — how to help
- [Security](docs/development/SECURITY.md) — threat model, plugin sandboxing
- [Plugin API](docs/plugins/API.md) — building plugins
- [Plugin examples](docs/plugins/EXAMPLES.md) — walkthroughs
- [Roadmap](docs/planning/ROADMAP.md) — what's planned

## Contributing

See [CONTRIBUTING.md](docs/development/CONTRIBUTING.md). Run `pnpm check` before submitting PRs.

## License

MIT
