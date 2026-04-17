<div align="center">

<img src="public/images/logo-192.png" alt="Junban logo" width="80" />

# ASF Junban

**A local-first task manager with AI, voice, and plugins.**<br />
Fast for everyday task management, flexible when you need more power,<br />
and private by default because your data stays on your machine.

No accounts. No tracking. No mandatory cloud.

<p>
  <a href="https://github.com/Artificial-Source-Foundation/Junban">Home</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/SETUP.md">Setup</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/ARCHITECTURE.md">Architecture</a> &nbsp;&middot;&nbsp;
  <a href="docs/guides/RELEASES.md">Releases</a> &nbsp;&middot;&nbsp;
  <a href="docs/plugins/API.md">Plugin API</a> &nbsp;&middot;&nbsp;
  <a href="docs/planning/ROADMAP.md">Roadmap</a>
</p>

[![CI](https://github.com/Artificial-Source-Foundation/Junban/actions/workflows/ci.yml/badge.svg)](https://github.com/Artificial-Source-Foundation/Junban/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Artificial-Source-Foundation/Junban?style=social)](https://github.com/Artificial-Source-Foundation/Junban/stargazers)

An open-source project by the [AI Strategic Forum (ASF)](https://github.com/Artificial-Source-Foundation) community.

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

Download the latest desktop release here:

<https://github.com/Artificial-Source-Foundation/Junban/releases/latest>

Pick the file for your platform:

| Platform              | Download this file         |
| --------------------- | -------------------------- |
| Windows               | `.exe` installer or `.msi` |
| macOS (Apple Silicon) | `.dmg` with `aarch64`      |
| macOS (Intel)         | `.dmg` with `x64`          |
| Linux (Debian/Ubuntu) | `.deb` with `amd64`        |
| Linux (portable)      | `.AppImage` with `amd64`   |

Install notes:

- Windows: download the installer and open it.
- macOS: download the `.dmg`, open it, and move Junban to `Applications`.
- Linux: use the commands below, or download the asset in your browser and run the matching install step.

Linux quick install from the latest release:

```bash
# Debian/Ubuntu (.deb) - download latest, then install
curl -fsSL https://api.github.com/repos/Artificial-Source-Foundation/Junban/releases/latest \
  | grep -o 'https://[^"]*amd64\.deb' \
  | head -n 1 \
  | xargs curl -fL -o ASF-Junban-latest-amd64.deb
sudo apt install ./ASF-Junban-latest-amd64.deb

# Portable (.AppImage) - download latest, make executable, then run
curl -fsSL https://api.github.com/repos/Artificial-Source-Foundation/Junban/releases/latest \
  | grep -o 'https://[^"]*amd64\.AppImage' \
  | head -n 1 \
  | xargs curl -fL -o ASF-Junban-latest-amd64.AppImage
chmod +x ./ASF-Junban-latest-amd64.AppImage
./ASF-Junban-latest-amd64.AppImage
```

If you prefer the browser flow, download the `.deb` or `.AppImage` from the release page above and run the same install step on the downloaded file.

## Why Junban

Most task managers force a tradeoff: simple but limited, or powerful but bloated. Junban is built to stay fast for everyday use while still giving you AI, voice, and extensibility when you want them.

- Capture tasks in plain English: `buy milk tomorrow 3pm p1 #groceries +shopping`
- Use an optional AI assistant that can work with your real tasks, projects, and schedule
- Talk instead of type with built-in voice features
- Extend the app with plugins instead of waiting for core features
- Keep your data local and portable with SQLite or Markdown storage
- Use the same core across the desktop app, API server, CLI, and MCP server

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

Current built-in providers include browser, hosted, and local model paths. See `docs/backend/VOICE.md` for the up-to-date provider matrix.

### Plugins

Junban has an Obsidian-style plugin system with:

- Manifest-based discovery
- Sandboxed execution
- Permission-gated APIs
- Commands, views, panels, settings, and AI extension points

Plugin author docs:

- `docs/plugins/API.md`
- `docs/plugins/EXAMPLES.md`

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

| Doc                           | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `docs/guides/SETUP.md`        | Local development setup                 |
| `docs/guides/ARCHITECTURE.md` | System architecture and data flow       |
| `docs/guides/RELEASES.md`     | Packaging and release workflow          |
| `docs/guides/CONTRIBUTING.md` | Contribution workflow                   |
| `docs/guides/SECURITY.md`     | Security model                          |
| `docs/plugins/API.md`         | Plugin author reference                 |
| `docs/plugins/EXAMPLES.md`    | Plugin examples                         |
| `docs/planning/ROADMAP.md`    | Product roadmap                         |
| `AGENTS.md`                   | Quick-start for coding agents           |
| `CLAUDE.md`                   | Contributor and agent development guide |

## Contributing

See `docs/guides/CONTRIBUTING.md`. Run `pnpm check` before opening a PR.

## License

MIT
