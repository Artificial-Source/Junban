# Utilities & Configuration Documentation

This document covers two directories: `src/utils/` (shared utility modules) and `src/config/` (application configuration and constants).

---

## Utilities (`src/utils/`)

### `logger.ts`

**Path:** `src/utils/logger.ts`
**Purpose:** Simple structured JSON logger with module-scoped instances. Each logger is created with a module name and outputs JSON entries with level, timestamp, module, message, and optional data fields. Log levels can be set globally at startup.

**Key Exports:**

- `LogLevel` -- type: `"debug" | "info" | "warn" | "error"`
- `setDefaultLogLevel(level: LogLevel): void` -- sets the global threshold (called once at startup)
- `createLogger(module: string, level?: LogLevel)` -- creates a scoped logger with `.debug()`, `.info()`, `.warn()`, `.error()` methods
- `Logger` -- the return type of `createLogger`

**Key Dependencies:** None

**Used By:** Nearly every module in the project. Created at module scope with `const logger = createLogger("module-name")`.

**Example Output:**

```json
{
  "level": "info",
  "time": "2026-02-20T12:00:00.000Z",
  "module": "tasks",
  "msg": "Task created",
  "id": "abc123",
  "title": "Buy milk"
}
```

---

### `ids.ts`

**Path:** `src/utils/ids.ts`
**Purpose:** Generates unique 21-character URL-safe IDs using the Web Crypto API. Similar to nanoid but with no external dependency.

**Key Exports:**

- `generateId(): string` -- returns a 21-char ID from the alphabet `0-9A-Za-z_-`

**Key Dependencies:** `crypto.getRandomValues` (Web Crypto API, available in both Node.js and browsers)

**Used By:** `src/core/tasks.ts`, `src/core/projects.ts`, `src/core/tags.ts`, `src/core/templates.ts`, `src/ai/chat.ts`

---

### `dates.ts`

**Path:** `src/utils/dates.ts`
**Purpose:** Basic date utility functions for checking if a date is today, overdue, formatting dates, and getting today's start/end boundaries.

**Key Exports:**

- `isToday(dateStr: string): boolean`
- `isOverdue(dateStr: string): boolean`
- `formatDate(dateStr: string, includeTime?: boolean): string`
- `todayStart(): string` -- ISO string for start of today (00:00:00.000)
- `todayEnd(): string` -- ISO string for end of today (23:59:59.999)

**Key Dependencies:** None

**Used By:** UI components

---

### `format-date.ts`

**Path:** `src/utils/format-date.ts`
**Purpose:** Advanced date formatting with four modes: relative (Today, Tomorrow, Yesterday, weekday name, or short date), short (Feb 20, 2026), long (February 20, 2026), and ISO (2026-02-20). Also provides time formatting in 12h or 24h modes.

**Key Exports:**

- `formatTaskDate(isoDate: string, format: "relative" | "short" | "long" | "iso"): string`
- `formatTaskTime(isoDate: string, timeFormat: "12h" | "24h"): string`

**Key Dependencies:** None

**Used By:** UI components (task display, date pickers)

---

### `tauri.ts`

**Path:** `src/utils/tauri.ts`
**Purpose:** Detects whether the app is running inside a Tauri WebView by checking for the `__TAURI__` global.

**Key Exports:**

- `isTauri(): boolean`

**Key Dependencies:** None

**Used By:** UI initialization code to determine bootstrap path (web vs. desktop)

---

### `color.ts`

**Path:** `src/utils/color.ts`
**Purpose:** Converts hex color strings to `rgba()` CSS values. Handles shorthand (#abc), full (#aabbcc), and bare (aabbcc) formats. Returns a fallback gray on invalid input.

**Key Exports:**

- `hexToRgba(hex: string, alpha: number): string`

**Key Dependencies:** None

**Used By:** UI components (project colors, priority colors with transparency)

---

### `sounds.ts`

**Path:** `src/utils/sounds.ts`
**Purpose:** Procedural UI sound effects using the Web Audio API. Each sound event has a unique musical signature synthesized at runtime -- no audio files needed. Supports volume control and lazy AudioContext initialization.

**Key Exports:**

- `SoundEvent` -- type: `"complete" | "create" | "delete" | "reminder"`
- `playSound(event: SoundEvent, volume: number): Promise<void>`
- `previewSound(event: SoundEvent, volume: number): Promise<void>`
- `_resetAudioContext(): void` -- for testing only

**Sound Signatures:**
| Event | Notes | Character |
|-------|-------|-----------|
| complete | C5 -> G5 (ascending fifth) | "success" |
| create | A4 triangle (short tick) | "acknowledged" |
| delete | A4 -> E4 (descending fourth) | "going away" |
| reminder | D5+G5 chord x2 pulses | "attention" |

**Key Dependencies:** Web Audio API (`AudioContext`, `OscillatorNode`, `GainNode`)

**Used By:** UI components (task interactions, reminders)

---

## Configuration (`src/config/`)

### `env.ts`

**Path:** `src/config/env.ts`
**Purpose:** Schema-validated environment loading shared by backend startup paths.

**Key Exports:**

- `Env` -- inferred type from Zod schema
- `loadEnv(): Env` -- parses `process.env` through the schema

**Configuration details:** Environment variables and runtime/env-scope boundaries are documented in [`CONFIG.md`](CONFIG.md).

**Used By:** `src/bootstrap.ts`, `src/api/settings.ts`, `src/db/migrate.ts`, `src/main.ts`, `src/server.ts`

---

### `defaults.ts`

**Path:** `src/config/defaults.ts`
**Purpose:** Application-wide constants and default values: priority definitions (label, value, color), task statuses, project color palette, and UI constants.

**Key Exports:**

- `PRIORITIES` -- `{ P1: { value: 1, label: "P1", color: "#ef4444" }, P2: {...}, P3: {...}, P4: {...} }`
- `TASK_STATUSES` -- `["pending", "completed", "cancelled"]`
- `DEFAULT_PROJECT_COLORS` -- array of 8 hex colors
- `COMMAND_PALETTE_HOTKEY` -- `"Ctrl+K"`
- `MAX_TASK_TITLE_LENGTH` -- `500`
- `MAX_DESCRIPTION_LENGTH` -- `10000`

**Key Dependencies:** None

**Used By:** `src/core/priorities.ts`, UI components

---

### `themes.ts`

**Path:** `src/config/themes.ts`
**Purpose:** Built-in theme definitions with id, display name, and type (light/dark).

**Key Exports:**

- `Theme` -- interface: `{ id: string; name: string; type: "light" | "dark" }`
- `BUILT_IN_THEMES` -- array of three themes: Light, Dark, and Nord

**Key Dependencies:** None

**Used By:** UI settings and theme switching
