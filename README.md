<div align="center">

<img src="public/images/logo-192.png" alt="Junban logo" width="80" />

# ASF Junban

**The task manager that doesn't exist yet.**<br />
Beautiful and simple out of the box, with a real AI assistant<br />
and a plugin system so simple that anyone can build features.

Local-first. No accounts. No tracking. Your data stays on your machine.

<p>
  <a href="https://github.com/Artificial-Source-Foundation/Junban">Home</a> &nbsp;&middot;&nbsp;
  <a href="docs/site/README.md">Documentation</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/SETUP.md">Setup</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/ARCHITECTURE.md">Architecture</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/RELEASES.md">Releases</a> &nbsp;&middot;&nbsp;
  <a href="docs/reference/plugins/API.md">Plugin API</a> &nbsp;&middot;&nbsp;
  <a href="docs/product/README.md">Product Docs</a> &nbsp;&middot;&nbsp;
  <a href="docs/product/roadmap.md">Roadmap</a>
</p>

[![CI](https://github.com/Artificial-Source-Foundation/Junban/actions/workflows/ci.yml/badge.svg)](https://github.com/Artificial-Source-Foundation/Junban/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Artificial-Source-Foundation/Junban?style=social)](https://github.com/Artificial-Source-Foundation/Junban/stargazers)

Built by the [AI Strategic Forum (ASF)](https://github.com/Artificial-Source-Foundation) community.

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/today-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="screenshots/today-light.png" />
  <img src="screenshots/today-light.png" alt="Junban - Today view" width="720" />
</picture>

</div>

<br />

<details>
<summary><strong>More screenshots</strong></summary>

<br />

<div align="center">

|                               Inbox (light)                               |                              Inbox (dark)                               |
| :-----------------------------------------------------------------------: | :---------------------------------------------------------------------: |
| <img src="screenshots/inbox-light.png" alt="Inbox - light" width="400" /> | <img src="screenshots/inbox-dark.png" alt="Inbox - dark" width="400" /> |

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

Latest release:

<https://github.com/Artificial-Source-Foundation/Junban/releases/latest>

| Platform              | Pick this asset on the latest release page |
| --------------------- | ------------------------------------------ |
| Windows               | `.exe` installer or `.msi`                 |
| macOS (Apple Silicon) | `.dmg` with `aarch64` in the filename      |
| macOS (Intel)         | `.dmg` with `x64` in the filename          |
| Linux (Debian/Ubuntu) | `.deb` with `amd64` in the filename        |
| Linux (portable)      | `.AppImage` with `amd64` in the filename   |

## Why Junban

Most task managers are either too simple or too heavy. Junban is trying to keep the core fast and local, while still giving you AI, voice, and extensibility when you want them.

- Type tasks naturally: `buy milk tomorrow 3pm p1 #groceries +shopping`
- Use AI that can see your tasks, projects, and schedule
- Talk instead of type with STT/TTS and voice activity detection
- Extend the app with plugins
- Keep your data portable with SQLite or Markdown storage
- Use the same core from the UI, API server, CLI, and MCP server

## Features

### Natural language input

Dates, priorities, tags, recurrence, and projects can be parsed from plain text.

```text
buy milk tomorrow 3pm p1 #groceries +shopping
finish report next friday p2 #work
call dentist 9am #health
```

### AI assistant

Junban includes an optional AI assistant with:

- Chat-driven task and project management
- Built-in tool calling for planning, querying, organization, and updates
- Pluggable providers, including cloud and local options
- Task-aware responses grounded in your actual Junban data

Nothing AI-related runs unless you configure it.

### Voice

Voice support includes speech-to-text, text-to-speech, and voice activity detection.

Current built-in providers include browser, hosted, and local model paths. See `docs/reference/backend/VOICE.md` for the up-to-date provider matrix.

### Plugins

Junban has an Obsidian-style plugin system with:

- Manifest-based discovery
- Sandboxed execution
- Permission-gated APIs
- Commands, views, panels, settings, and AI extension points

Plugin author docs:

- `docs/reference/plugins/API.md`
- `docs/reference/plugins/EXAMPLES.md`

### Interfaces

- React desktop/web UI
- Standalone Hono API server
- Commander-based CLI
- MCP server for external AI agents

## Development

See `docs/guides/SETUP.md` for the full setup guide.

Quick start:

```bash
git clone https://github.com/Artificial-Source-Foundation/Junban.git
cd Junban
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Useful commands:

```bash
pnpm dev
pnpm dev:full
pnpm server
pnpm build
pnpm test
pnpm test:e2e
pnpm check
pnpm tauri:dev
pnpm mcp
pnpm cli
```

Source-run dev commands use an isolated dev profile by default. Packaged desktop installs use Tauri app data instead of the repo-local dev database.

## Tech Stack

| Area     | Choice                                                 |
| -------- | ------------------------------------------------------ |
| Runtime  | Node.js 22, TypeScript                                 |
| Frontend | React 19, Tailwind CSS 4, Vite 6                       |
| Desktop  | Tauri v2                                               |
| API      | Hono                                                   |
| Database | SQLite via better-sqlite3 and sql.js                   |
| ORM      | Drizzle                                                |
| AI       | Provider abstraction with cloud and local integrations |
| Voice    | Browser, hosted, and local adapters                    |
| CLI      | Commander.js                                           |
| Tests    | Vitest, Testing Library, Playwright                    |

## Docs

| Domain / Entry             | Purpose                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md`           | Canonical docs index and single source of truth for ownership mapping/doc-governance routing                               |
| `docs/site/README.md`      | Website-facing docs hub that routes readers by audience (`users`, `developers`, `agents`) to canonical docs                        |
| `docs/product/README.md`   | Product-doc index for mission, roadmap, status, and PRD-style planning                                                     |
| `docs/guides/`             | Contributor and maintainer workflows (setup, architecture, releases, security)                                             |
| `docs/reference/README.md` | Technical-reference library index for `docs/reference/frontend/`, `docs/reference/backend/`, and `docs/reference/plugins/` |
| `docs/internal/README.md`  | Internal planning library index for `docs/internal/planning/` and `docs/internal/sprints/`                                 |
| `AGENTS.md`                | Quick-start for coding agents                                                                                              |
| `CLAUDE.md`                | Contributor and agent development guide                                                                                    |

Historical compatibility:

- `docs/planning/ROADMAP.md` remains available as a legacy roadmap alias that redirects into `docs/product/`.
- Lifecycle and retirement policy for legacy stubs: `docs/guides/LEGACY_COMPATIBILITY_POLICY.md`.

Common docs:

- `docs/guides/CONTRIBUTING.md` for contributor workflow and branch targeting
- `docs/guides/SECURITY.md` for security model and reporting guidance
- `docs/guides/SETUP.md` for local development setup

## Contributing

See `docs/guides/CONTRIBUTING.md`. Run `pnpm check` before opening a PR.

Current branch flow:

- `developer` is the integration branch for normal work.
- `main` is reserved for production-ready release promotions and hotfixes.
- Desktop releases are tagged from `main` as `v<version>`.

## License

MIT
