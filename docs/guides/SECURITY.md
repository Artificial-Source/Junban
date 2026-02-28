# Security

## Overview

Saydo is a local-first application. By default, no data leaves the user's machine. The primary security concerns are:

1. **Plugin sandboxing** — community plugins must not be able to harm the host system
2. **Data integrity** — task data must not be corrupted or lost
3. **Supply chain** — dependencies must be audited and minimal

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

### Attack Surfaces

| Surface | Threat | Mitigation |
|---------|--------|------------|
| Plugin system | Arbitrary code execution | Sandboxed execution, permission model |
| Plugin registry | Supply malicious plugin | Manual review, signature verification (future) |
| Natural language parser | Input injection | Parser produces structured data, no eval |
| SQLite database | SQL injection | Drizzle ORM parameterized queries |
| CLI arguments | Command injection | Commander.js argument parsing, no shell exec |
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
| Plugin settings | `settings` | Defined in manifest, managed by Saydo |
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

### What Saydo Stores

| Data | Location | Encrypted |
|------|----------|-----------|
| Tasks, projects, tags | `data/saydo.db` or `tasks/*.md` | No (local files) |
| Plugin settings | `data/saydo.db` | No |
| App settings | `data/saydo.db` | No |
| Plugin storage | `data/saydo.db` | No |

### What Saydo Does NOT Do

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

### Future: Sync Security

When sync plugins are available, they must:
- Use TLS for all network communication
- Support end-to-end encryption (the sync server never sees plaintext)
- Handle conflicts without data loss (last-write-wins with conflict log)
- Allow users to revoke sync access and delete remote data

## Supply Chain

### Dependencies

Saydo uses a minimal dependency set. Each dependency was chosen intentionally:

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

If you discover a security vulnerability in Saydo:

1. **Do NOT open a public issue**
2. Email security concerns to the ASF maintainers (see repository for contact)
3. Include a description of the vulnerability, steps to reproduce, and potential impact
4. We will acknowledge within 48 hours and provide a timeline for a fix

For plugin vulnerabilities, open an issue in the plugin's repository and notify us so we can flag it in the registry.
