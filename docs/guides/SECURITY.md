# Security

## Overview

Junban is a local-first application. By default, no data leaves the user's machine. The primary security concerns are:

1. **Plugin sandboxing** — community plugins must not be able to harm the host system
2. **Data integrity** — task data must not be corrupted or lost
3. **Supply chain** — dependencies must be audited and minimal
4. **Remote access exposure** — packaged desktop remote access must stay limited to trusted networks and a single active browser session

## Threat Model

### What We Protect

| Asset | Value | Location |
|-------|-------|----------|
| Task data | Personal/work task content | Local SQLite or Markdown files |
| Plugin settings | Plugin configuration | Local database |
| User preferences | App settings, themes | Local database |
| Plugin code | Third-party JavaScript | Local `plugins/` directory |

### Threat Actors

| Actor | Motivation | Risk Level |
|-------|------------|------------|
| Malicious plugin author | Data exfiltration, code execution | High |
| Compromised dependency | Supply chain attack | Medium |
| Local attacker (shared machine) | Read sensitive task data | Low |
| Network attacker | Intercept sync data | Low (no network by default) |
| Remote-network attacker | Reach a user-enabled remote-access endpoint | Medium when the feature is enabled |

### Attack Surfaces

| Surface | Threat | Mitigation |
|---------|--------|------------|
| Plugin system | Arbitrary code execution | Sandboxed execution, permission model |
| Plugin registry | Supply malicious plugin | Manual review, signature verification (future) |
| Natural language parser | Input injection | Parser produces structured data, no eval |
| SQLite database | SQL injection | Drizzle ORM parameterized queries |
| CLI arguments | Command injection | Commander.js argument parsing, no shell exec |
| Desktop remote access | Unauthorized browser access, accidental exposure | Off by default, trusted-network guidance, optional password, single-session lock, local mutation guard |
| Sync (future) | MITM, data tampering | TLS required, integrity checks |

## Plugin Sandboxing

### Execution Environment

Plugins run in a restricted JavaScript context with controlled access:

```
┌───────────────────────────────────────────┐
│              Host Environment             │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │          Sandbox Boundary           │  │
│  │                                     │  │
│  │  ┌───────────┐  ┌───────────────┐  │  │
│  │  │  Plugin A  │  │   Plugin B    │  │  │
│  │  │           │  │              │  │  │
│  │  │  Can see: │  │  Can see:    │  │  │
│  │  │  - API    │  │  - API       │  │  │
│  │  │  - Own    │  │  - Own       │  │  │
│  │  │    store  │  │    store     │  │  │
│  │  └───────────┘  └───────────────┘  │  │
│  │                                     │  │
│  │  Cannot see:                        │  │
│  │  - process, require, __dirname      │  │
│  │  - fs, path, child_process          │  │
│  │  - Other plugins' storage           │  │
│  │  - DOM outside plugin UI slots      │  │
│  │  - eval(), new Function()           │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  Full access:                             │
│  - Database                               │
│  - Filesystem                             │
│  - Network                                │
│  - OS APIs (via Tauri)                    │
└───────────────────────────────────────────┘
```

### What Plugins CAN Access

| Feature | Requires Permission | Notes |
|---------|-------------------|-------|
| Read tasks | `task:read` | Via Plugin API only |
| Write tasks | `task:write` | Via Plugin API only |
| Register commands | `commands` | Command palette integration |
| Add UI panels | `ui:panel` | Rendered in designated slots |
| Add views | `ui:view` | Full-page views in the app |
| Add status bar items | `ui:status` | Bottom status bar |
| Plugin storage | `storage` | Isolated key-value store per plugin |
| Plugin settings | `settings` | Defined in manifest, managed by Junban |
| HTTP requests | `network` | Prompted per-domain, user must approve |

### What Plugins CANNOT Access

| Feature | Why |
|---------|-----|
| Filesystem (`fs`, `path`) | Data exfiltration risk |
| Process APIs (`process`, `child_process`) | Arbitrary code execution |
| `require()` / dynamic `import()` | Module system escape |
| `eval()` / `new Function()` | Code injection |
| `__dirname`, `__filename` | Path disclosure |
| Other plugins' storage | Isolation boundary |
| DOM outside allocated slots | UI hijacking |
| `window.location` modification | Navigation hijacking |
| `localStorage` / `sessionStorage` | Uncontrolled state |

### Network Permission

The `network` permission is special:

1. Plugin declares `network` in manifest permissions
2. On install, user sees: "This plugin wants to make network requests"
3. On first request, user sees: "Plugin X wants to connect to api.example.com — Allow?"
4. User can approve per-domain or deny
5. Approved domains are remembered in plugin settings
6. All network requests are logged

### Permission Enforcement

Permissions are enforced at the API layer, not at the plugin level:

```typescript
// Inside the Plugin API proxy
function createTaskAPI(pluginId: string, permissions: string[]) {
  return {
    list: permissions.includes("task:read")
      ? () => taskService.list()
      : () => { throw new PermissionError("task:read required"); },
    create: permissions.includes("task:write")
      ? (data) => taskService.create(data)
      : () => { throw new PermissionError("task:write required"); },
    // ...
  };
}
```

Plugins receive a proxy object with only the methods their permissions allow. Attempting to access unauthorized APIs throws a `PermissionError`.

## Data Privacy

### What Junban Stores

| Data | Location | Encrypted |
|------|----------|-----------|
| Tasks, projects, tags | `data/junban.db` or `tasks/*.md` | No (local files) |
| Plugin settings | `data/junban.db` | No |
| App settings | `data/junban.db` | No |
| Plugin storage | `data/junban.db` | No |

### What Junban Does NOT Do

- **No telemetry**: Zero analytics, crash reports, or usage tracking
- **No network calls**: The core app makes no network requests (plugins can, with permission)
- **No accounts**: No user accounts, no authentication, no server
- **No cloud storage**: Data is local by default. Sync is opt-in via plugins.

### Data at Rest

Task data is stored unencrypted in local files. This is a deliberate trade-off:

- **Pro**: Users can read/edit data with external tools (SQLite browsers, text editors)
- **Pro**: No risk of losing data due to a forgotten encryption key
- **Con**: Anyone with filesystem access can read task data

For users who need encryption at rest, we recommend:
- Full-disk encryption (FileVault, BitLocker, LUKS)
- Encrypted containers (VeraCrypt) for the `data/` directory

## Desktop Remote Access

Packaged desktop builds can optionally expose a personal remote-access web UI. This changes the threat model because the app is no longer purely local while the endpoint is running.

### Security posture

- **Off by default**: remote access is only available after the user enables it from `Settings -> Data -> Remote Access`.
- **Trusted-network feature**: it is intended for LAN or overlay-network use such as Tailscale, not direct public-internet exposure.
- **Single active browser session**: only one remote browser can hold the live session at a time. To switch devices, the user must stop and restart remote access from the desktop app.
- **Optional password gate**: users can require a password before the first browser session is authorized.
- **Local mutation guard**: while remote access is running, local desktop write actions are blocked so the desktop UI does not race the remote browser for changes.

### What the built-in protections do

| Control | Purpose |
|---------|---------|
| Optional password | Prevents opportunistic access on a trusted network when enabled |
| Session cookie after login | Keeps the authorized browser connected without re-entering the password on every request |
| Single-session claim/lock | Prevents multiple remote browsers from mutating the same live desktop session |
| Desktop mutation lock | Keeps local desktop edits, quick capture, and imports from writing while the remote browser is active |

### Operator guidance

- Prefer Tailscale, a private LAN, or another trusted/private network path.
- Do **not** expose the built-in remote-access port directly to the public internet.
- Turn on password protection when the feature is enabled anywhere beyond a tightly controlled local network.
- If you suspect the wrong browser has access, stop remote access from the desktop app and start it again before reconnecting.

### Future: Sync Security

When sync plugins are available, they must:
- Use TLS for all network communication
- Support end-to-end encryption (the sync server never sees plaintext)
- Handle conflicts without data loss (last-write-wins with conflict log)
- Allow users to revoke sync access and delete remote data

## Supply Chain

### Dependencies

Junban uses a minimal dependency set. Each dependency was chosen intentionally:

| Dependency | Purpose | Risk Mitigation |
|------------|---------|----------------|
| React | UI framework | Facebook-maintained, massive audit surface |
| better-sqlite3 | Database | Native module, well-audited |
| Drizzle ORM | Type-safe DB access | SQL-close, no hidden magic |
| chrono-node | NLP date parsing | Pure JS, no native code |
| Commander.js | CLI framework | Industry standard, minimal |
| Zod | Validation | Pure TS, no native code |
| Tailwind CSS | Styling | Build-time only, no runtime |
| Vite | Build tool | Dev dependency only |
| Vitest | Testing | Dev dependency only |

### Practices

- **Lock file committed**: `pnpm-lock.yaml` is committed to ensure reproducible installs
- **No post-install scripts**: Dependencies with install scripts are reviewed
- **Regular audits**: `pnpm audit` run as part of CI
- **Minimal production deps**: Dev tools are devDependencies, not bundled

## Reporting Vulnerabilities

If you discover a security vulnerability in Junban:

1. **Do NOT open a public issue**
2. Email security concerns to the ASF maintainers (see repository for contact)
3. Include a description of the vulnerability, steps to reproduce, and potential impact
4. We will acknowledge within 48 hours and provide a timeline for a fix

For plugin vulnerabilities, open an issue in the plugin's repository and notify us so we can flag it in the registry.
