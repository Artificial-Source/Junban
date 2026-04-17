# Product Requirements Docs

These are lightweight PRD-style docs derived from the current roadmap and planning material.

They are intentionally high level: product problem, target outcome, scope, and dependencies. Detailed implementation planning still belongs in `docs/internal/` and engineering specifics still belong in `docs/guides/` and `docs/reference/`.

Promotion rule:

1. Keep ideas and execution detail in `docs/internal/` while scope is still fluid.
2. Promote work into a product PRD when it is milestone-level, has stable scope, and bundles multiple related implementation items.
3. Keep the PRD linked back to its internal planning source so roadmap, PRD, and execution docs stay traceable.

## Current PRDs

| PRD                                                    | Status                                | Derived from                                                                                    |
| ------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`calendar-integrations.md`](calendar-integrations.md) | Backlog / next major integration area | v1.2 roadmap milestone + [`../../internal/planning/epics.md`](../../internal/planning/epics.md) |
| [`junban-sync.md`](junban-sync.md)                     | Future                                | v1.5 roadmap milestone + internal backlog / epic promotion later                                |
| [`mobile-and-web.md`](mobile-and-web.md)               | Future                                | v2.0 and v3.0 roadmap milestones + sync-dependent follow-on planning                            |

## Unscoped Ideas

Unpromoted ideas and plugin concepts stay in the internal planning backlog until they meet the promotion rule above.
Use [`../../internal/planning/backlog.md`](../../internal/planning/backlog.md) as the execution source of truth for idea-stage work.
