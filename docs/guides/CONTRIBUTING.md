# Contributing to ASF Saydo

Thank you for considering contributing to Saydo! This guide covers everything you need to get started.

## Getting Started

1. **Fork the repository** and clone your fork
2. Follow [SETUP.md](SETUP.md) to get your development environment running
3. Create a branch for your work (see [Branching](#branching) below)
4. Make your changes
5. Run `pnpm check` to verify lint, typecheck, and tests pass
6. Submit a pull request

## What to Contribute

### Good First Contributions

- Bug fixes with a clear reproduction
- Unit tests for uncovered core logic
- Documentation improvements (typos, clarifications, examples)
- Accessibility improvements
- Performance optimizations with benchmarks

### Feature Contributions

Before starting significant work:

1. **Check the [Roadmap](../planning/ROADMAP.md)** — the feature may already be planned
2. **Open an issue** describing what you want to build and why
3. **Wait for discussion** — maintainers will confirm the direction before you invest time
4. **Reference the issue** in your PR

### Plugin Contributions

Plugins are the best way to add features without modifying core code:

1. Build your plugin following the [Plugin API](../plugins/API.md) reference
2. Test it locally in the `plugins/` directory
3. Publish it to npm or a Git repository
4. Submit a PR to add it to `sources.json` (the community plugin registry)

See [Plugin Registry Submission](#plugin-registry-submission) below.

## Development Workflow

### Branching

| Branch | Purpose |
|--------|---------|
| `main` | Stable, deployable |
| `feat/<name>` | New features |
| `fix/<name>` | Bug fixes |
| `docs/<name>` | Documentation changes |
| `plugin/<name>` | Plugin system changes |
| `test/<name>` | Test additions |

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add recurring task support
fix(parser): handle "next Monday" edge case
docs(plugin): add settings API examples
test(core): add edge cases for priority sorting
refactor(ui): extract TaskInput into separate component
```

**Scope** should match the directory: `core`, `parser`, `plugins`, `ui`, `cli`, `db`, `config`, `docs`.

### Pull Requests

- **Title**: Follow the commit convention (e.g., `feat(core): add recurring tasks`)
- **Description**: Explain what and why, not just how
- **Size**: Keep PRs focused. One feature or fix per PR. Large PRs are harder to review.
- **Tests**: Include tests for new logic. Fix failing tests before submitting.
- **Docs**: Update relevant documentation if behavior changes

### Code Review

All PRs require at least one review. Reviewers will check:

- Does it work as described?
- Are there tests?
- Does it follow project conventions?
- Are there security concerns?
- Is the code clear without excessive comments?

## Code Style

### TypeScript

- **Strict mode**: `tsconfig.json` has `strict: true` — no `any` types
- **Named exports**: Prefer `export function foo()` over `export default`
- **Error handling**: Handle errors explicitly — don't swallow them
- **Validation**: Use Zod schemas at system boundaries (user input, file reads, plugin manifests)

### React

- **Function components**: No class components
- **Tailwind CSS**: Utility-first styling, no CSS modules or inline styles
- **Co-located files**: Component-specific logic stays in the component file or adjacent files
- **No barrel exports**: Import directly from the file, not from `index.ts` re-exports

### File Organization

- One module per file (no mega-files with multiple unrelated exports)
- Test files in `tests/` mirroring `src/` structure
- Types co-located with the code that uses them (in `types.ts` files per module)

## Testing

### What to Test

- **Core logic**: Task CRUD, filtering, sorting, recurrence — always test
- **Parser**: Natural language parsing edge cases — always test
- **Plugin lifecycle**: Load, unload, event dispatch — always test
- **UI components**: Critical flows (task creation, completion) — test key interactions
- **Utilities**: Pure functions — easy to test, always test

### How to Test

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
```

Tests use [Vitest](https://vitest.dev/). Example:

```typescript
import { describe, it, expect } from "vitest";
import { parseTask } from "../src/parser/task-parser";

describe("parseTask", () => {
  it("extracts priority from input", () => {
    const result = parseTask("buy milk p1");
    expect(result.title).toBe("buy milk");
    expect(result.priority).toBe(1);
  });

  it("extracts tags from input", () => {
    const result = parseTask("review PR #dev #urgent");
    expect(result.title).toBe("review PR");
    expect(result.tags).toEqual(["dev", "urgent"]);
  });
});
```

## Plugin Registry Submission

To add your plugin to the community registry:

1. **Publish your plugin** to npm or a public Git repository
2. **Ensure your plugin has**:
   - A valid `manifest.json`
   - A README with description, installation, and usage
   - No bundled dependencies that duplicate Saydo's (React, etc.)
   - Tested on the latest Saydo version
3. **Submit a PR** that adds your plugin to `sources.json`:

```json
{
  "id": "your-plugin-id",
  "name": "Your Plugin Name",
  "description": "Brief description of what it does.",
  "author": "Your Name",
  "version": "1.0.0",
  "repository": "https://github.com/you/saydo-plugin-name",
  "tags": ["relevant", "tags"],
  "minSaydoVersion": "1.0.0"
}
```

### Plugin Guidelines

- **No telemetry**: Plugins must not phone home or collect analytics without explicit user consent
- **No network by default**: Use the `network` permission only when necessary and document why
- **No vendor lock-in**: Don't require a paid service to function (free tier is OK)
- **Respect privacy**: Don't access task data beyond what your plugin needs
- **Graceful degradation**: If a dependency is unavailable, degrade gracefully with a clear message

## Security

- **Never commit secrets** (API keys, tokens, etc.) — use `.env`
- **Validate inputs** — especially in plugins and CLI
- **No `eval()` or `new Function()`** — ever
- **Plugin sandbox**: Plugins run in a restricted environment by design. Don't try to break out.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Sprint Methodology

Development follows two-week sprint cycles. Each sprint has a clear goal and pulls items from the [Backlog](../planning/BACKLOG.md).

### How Sprints Work

- **Duration**: 2 weeks
- **Planning**: Select items from backlog at sprint start
- **Daily work**: Pick the next `ready` item, mark `in-progress`, complete it
- **Review**: At sprint end, update items to `done`, write retro notes, plan next sprint
- **Carry-over**: Incomplete items return to backlog or carry into the next sprint

### Sprint Sizing

| Size | Effort | Example |
|------|--------|---------|
| S | < 2 hours | Wire a single service to DB, add a test file |
| M | 2–6 hours | Build a complete view, implement a CLI command end-to-end |
| L | 1–2 days | Plugin loader with validation, keyboard navigation system |
| XL | 3–5 days | Sandbox implementation, storage abstraction layer |

See [ROADMAP.md](../planning/ROADMAP.md) for sprint history and project status.

## Questions?

- Open a GitHub issue for bugs or feature discussions
- Check existing issues before creating new ones
- Be respectful — ASF values constructive discourse
