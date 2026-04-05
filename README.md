<div align="center">

<img src="public/images/logo-192.png" alt="Junban logo" width="80" />

# ASF Junban

**The task manager that doesn't exist yet.**<br />
Beautiful and simple out of the box, with a real AI assistant<br />
and a plugin system so simple that anyone can build features — no coding required.

Local-first. No accounts. No tracking. Your data stays on your machine.

<p>
  <a href="https://github.com/ASF-GROUP/Junban">Home</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/SETUP.md">Setup</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/ARCHITECTURE.md">Architecture</a> &nbsp;&middot;&nbsp;
  <a href="docs/plugins/API.md">Plugin API</a> &nbsp;&middot;&nbsp;
  <a href="docs/planning/ROADMAP.md">Roadmap</a>
</p>

[![CI](https://github.com/ASF-GROUP/Junban/actions/workflows/ci.yml/badge.svg)](https://github.com/ASF-GROUP/Junban/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ASF-GROUP/Junban?style=social)](https://github.com/ASF-GROUP/Junban/stargazers)

Built by the [AI Strategic Forum (ASF)](https://github.com/ASF-GROUP) community.

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/today-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="screenshots/today-light.png" />
  <img src="screenshots/today-light.png" alt="Junban — Today view" width="720" />
</picture>

</div>

<br />

<details>
<summary><strong>More screenshots</strong></summary>

<br />

<div align="center">

|                               Inbox (light)                               |                              Inbox (dark)                               |
| :-----------------------------------------------------------------------: | :---------------------------------------------------------------------: |
| <img src="screenshots/inbox-light.png" alt="Inbox — light" width="400" /> | <img src="screenshots/inbox-dark.png" alt="Inbox — dark" width="400" /> |

|                                Upcoming                                |                                Calendar                                |
| :--------------------------------------------------------------------: | :--------------------------------------------------------------------: |
| <img src="screenshots/upcoming-dark.png" alt="Upcoming" width="400" /> | <img src="screenshots/calendar-dark.png" alt="Calendar" width="400" /> |

|                         Eisenhower Matrix                          |                                   Command Palette                                    |
| :----------------------------------------------------------------: | :----------------------------------------------------------------------------------: |
| <img src="screenshots/matrix-dark.png" alt="Matrix" width="400" /> | <img src="screenshots/command-palette-dark.png" alt="Command Palette" width="400" /> |

|                                 Task Detail                                  |                                Settings                                |
| :--------------------------------------------------------------------------: | :--------------------------------------------------------------------: |
| <img src="screenshots/task-detail-dark.png" alt="Task Detail" width="400" /> | <img src="screenshots/settings-dark.png" alt="Settings" width="400" /> |

<img src="screenshots/stats-dark.png" alt="Stats dashboard" width="720" />

</div>

</details>

---

## Download

Desktop app for Windows, macOS, and Linux.

👉 **Download from the latest release page:** [github.com/ASF-GROUP/Junban/releases/latest](https://github.com/ASF-GROUP/Junban/releases/latest)

> We use the release page (instead of hardcoded asset URLs) because installer filenames include the app version.

| Platform                  | Pick this asset on the latest release page |
| ------------------------- | ------------------------------------------ |
| **Windows**               | `.exe` installer (recommended) or `.msi`   |
| **macOS (Apple Silicon)** | `.dmg` with `aarch64` in the filename      |
| **macOS (Intel)**         | `.dmg` with `x64` in the filename          |
| **Linux (Debian/Ubuntu)** | `.deb` with `amd64` in the filename        |
| **Linux (AppImage)**      | `.AppImage` with `amd64` in the filename   |

### Download trust & verification (current)

- Download only from the official [ASF-GROUP/Junban Releases](https://github.com/ASF-GROUP/Junban/releases) page.
- Confirm the asset is attached to a published release with notes/tag in this repository.
- We do not currently publish standalone checksum instructions for manual installs in this README.
- For desktop installs, in-app updates use Tauri updater metadata from this same Releases source.

- **Windows:** use `.exe` for the normal installer; `.msi` is mainly for managed or enterprise-friendly installs.
- **macOS:** if Gatekeeper warns on first launch, open the app from Finder or approve it in System Settings.
- **Linux:** use `.deb` on Debian/Ubuntu; use `AppImage` for a portable build on other distros.

## Why Junban

Most task managers are either too simple (no AI, no extensibility) or too complex (enterprise bloat). Junban sits in the middle:

- **Type naturally** — `buy milk tomorrow 3pm p1 #groceries +shopping` just works
- **Talk to AI** — a sidebar chat that actually sees your tasks, projects, and schedule
- **Speak instead of type** — voice input via browser, Groq, Inworld AI, or local models
- **Extend with plugins** — describe what you want to Claude or ChatGPT, drop the file in a folder, done
- **Own your data** — SQLite or Markdown files. Export anytime. No vendor lock-in

## Development

Want to run from source or contribute? See the [local setup guide](docs/guides/SETUP.md), or:

```bash
git clone https://github.com/ASF-GROUP/Junban.git && cd Junban
pnpm install
cp .env.example .env
mkdir -p data && pnpm db:migrate
pnpm dev          # Web app at http://localhost:5173
pnpm tauri:dev    # Desktop app (requires Rust + Tauri CLI)
```

## Features

### Natural Language Input

Type tasks the way you think. Dates, priorities, tags, and projects are parsed from plain text.

```
buy milk tomorrow 3pm p1 #groceries +shopping
finish report next friday p2 #work
call dentist 9am #health
```

### AI Assistant

A conversational sidebar that sees your tasks, projects, and schedule. **34 built-in tools** for task CRUD, project management, scheduling, pattern analysis, workload detection, and energy-based recommendations.

Supported providers: **OpenAI** / **Anthropic** / **OpenRouter** / **Ollama** / **LM Studio** — or write a custom provider plugin.

> Nothing AI-related runs unless you configure it. No keys stored or proxied.

### Voice

Full speech-to-text and text-to-speech pipeline with voice activity detection (VAD).

| Provider           | Type      | Notes                         |
| ------------------ | --------- | ----------------------------- |
| Browser Speech API | STT + TTS | Zero config, works everywhere |
| Groq               | STT + TTS | Whisper STT + PlayAI TTS      |
| Inworld AI         | TTS       | High-quality, 15 languages    |
| Whisper (local)    | STT       | Runs on your machine          |
| Kokoro (local)     | TTS       | Neural TTS via Web Worker     |
| Piper (local)      | TTS       | Lightweight local TTS         |

### Plugins

Obsidian-style plugins — drop a TypeScript file in `plugins/`, no build step.

```typescript
import { Plugin } from "@asf-junban/plugin-api";

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

Plugins can register commands, add sidebar panels, add views, hook into task events, and store data. The API is stable (v1.0.0, semver).

> Docs: [Plugin API](docs/plugins/API.md) / [Examples](docs/plugins/EXAMPLES.md)

### And more...

|                           |                                                              |
| ------------------------- | ------------------------------------------------------------ |
| **Dual storage**          | SQLite (default) or Markdown files with YAML frontmatter     |
| **Sub-tasks & templates** | Break down work, reuse common patterns                       |
| **Recurring tasks**       | Daily, weekly, monthly — with natural language scheduling    |
| **Reminders**             | Set reminders on any task, get notified when they're due     |
| **Eisenhower Matrix**     | Prioritize with the urgent/important quadrant view           |
| **Focus mode**            | Distraction-free, keyboard-driven                            |
| **CLI companion**         | `junban add`, `junban list`, `junban done` from the terminal |
| **Themes**                | Light / Dark / Nord + accent colors + custom CSS             |
| **Sound effects**         | Satisfying audio feedback for task actions                   |
| **1930+ tests**           | Solid coverage across the entire codebase                    |

## Tech stack

|              |                                                   |
| ------------ | ------------------------------------------------- |
| **Runtime**  | Node.js 22, TypeScript                            |
| **Desktop**  | Tauri v2                                          |
| **Frontend** | React 19, Tailwind CSS 4                          |
| **Database** | SQLite (better-sqlite3 / sql.js) + Drizzle ORM    |
| **AI**       | OpenAI, Anthropic, OpenRouter, Ollama, LM Studio  |
| **Voice**    | Browser, Groq, Inworld AI, Whisper, Kokoro, Piper |
| **CLI**      | Commander.js                                      |
| **Tests**    | Vitest (1930+)                                    |
| **Build**    | Vite 6                                            |

## Status

v1.0 shipped. Desktop app works on Mac, Windows, Linux.

Latest: voice call mode, global search, tag management AI tools, sound effects, comprehensive settings, mobile-responsive UI.

Next milestone: **Junban Sync** — optional paid cross-device sync.

## Docs

|                                             |                                 |
| ------------------------------------------- | ------------------------------- |
| [Architecture](docs/guides/ARCHITECTURE.md) | How the codebase is organized   |
| [Local setup](docs/guides/SETUP.md)         | Getting it running              |
| [Contributing](docs/guides/CONTRIBUTING.md) | How to help                     |
| [Security](docs/guides/SECURITY.md)         | Threat model, plugin sandboxing |
| [Plugin API](docs/plugins/API.md)           | Building plugins                |
| [Plugin examples](docs/plugins/EXAMPLES.md) | Walkthroughs                    |
| [Roadmap](docs/planning/ROADMAP.md)         | What's planned                  |

## Contributing

See [CONTRIBUTING.md](docs/guides/CONTRIBUTING.md). Run `pnpm check` before submitting PRs.

## Star History

<div align="center">
  <a href="https://github.com/ASF-GROUP/Junban/stargazers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ASF-GROUP/Junban&theme=dark&type=Date" />
      <img src="https://api.star-history.com/svg?repos=ASF-GROUP/Junban&type=Date" alt="Star History" width="600" />
    </picture>
  </a>
</div>

## License

MIT
