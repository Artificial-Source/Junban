# Security Policy

## Supported versions

Junban has not published a production release from this repository yet. Security fixes land on the default branch as the rewrite proceeds.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for this repository, or by contacting the maintainers through the organization contact channel on GitHub.

Include:

- a clear description of the issue and impact;
- reproduction steps or proof of concept when possible;
- affected commit, branch, or package when known.

Do not open a public issue for unfixed vulnerabilities.

## Project security posture

- All shipped backend and integration runtime code is Rust.
- Node.js is development/build tooling for the React frontend only.
- SQLite is the sole live database.
- Hosted mode defaults to loopback binding, authentication on application endpoints, and exact hostname allowlisting (implemented in later phases).
- Plugins are capability-limited portable packages; unrestricted native plugin loading is out of scope.
- Optional AI, voice, and plugin subsystems must not initialize by default when unused.

Canonical detail lives in [`docs/security.md`](docs/security.md).
