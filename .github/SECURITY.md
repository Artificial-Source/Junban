# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email us at **security@asfgroup.org** with:

1. A description of the vulnerability
2. Steps to reproduce (if applicable)
3. Affected versions
4. Any potential impact assessment

We will acknowledge your report within **48 hours** and aim to provide a fix within **7 days** for critical issues.

## Scope

Junban is a local-first desktop application. The primary security concerns are:

- **Plugin sandboxing** — community plugins must not escape their sandbox
- **Data integrity** — task data must not be corrupted or exfiltrated
- **Supply chain** — dependencies are audited and pinned
- **API key storage** — encrypted at rest with AES-256-GCM

For the full threat model, plugin sandboxing design, and dependency posture, see [docs/guides/SECURITY.md](../docs/guides/SECURITY.md).

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable time to address the issue before any public disclosure.
