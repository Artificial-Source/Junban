# Product Documentation

This is the permanent index for Junban's product-documentation domain.

Product docs live under `docs/product/` so mission, roadmap, status, and PRD-style planning stay separate from the contributor/codebase docs library in `docs/guides/`, `docs/reference/`, and `docs/internal/`.

## Start Here

| You want to...                                     | Read this doc                                            |
| -------------------------------------------------- | -------------------------------------------------------- |
| Understand Junban's mission and product principles | [`mission-and-principles.md`](mission-and-principles.md) |
| Review milestone-level product direction           | [`roadmap.md`](roadmap.md)                               |
| Check the current shipped-product snapshot         | [`status.md`](status.md)                                 |
| Review lightweight PRD-style planning docs         | [`prds/README.md`](prds/README.md)                       |
| Route back to contributor/codebase docs            | [`../README.md`](../README.md)                           |

## Domains

| Domain  | Location                                                 | Scope                                                                       |
| ------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Mission | [`mission-and-principles.md`](mission-and-principles.md) | Product intent, positioning, and decision principles                        |
| Roadmap | [`roadmap.md`](roadmap.md)                               | Milestone-level product direction and feature sequencing                    |
| Status  | [`status.md`](status.md)                                 | Current product maturity and shipped capability snapshot                    |
| PRDs    | [`prds/`](prds/)                                         | Lightweight product requirement docs derived from current planning material |

## Scope Boundary

- `docs/product/` is for product-level intent, roadmap, status, and PRD-style planning.
- `docs/guides/` and `docs/reference/` remain the contributor and engineering documentation library.
- `docs/internal/` remains the internal execution-planning library.
- `docs/site/` may publish website-facing product narratives, but canonical product source docs stay in `docs/product/`.
- `docs/planning/ROADMAP.md` is now a compatibility alias only; the canonical roadmap surface is this product docs domain.
- Compatibility-stub lifecycle guidance lives in [`../guides/LEGACY_COMPATIBILITY_POLICY.md`](../guides/LEGACY_COMPATIBILITY_POLICY.md).

## Promotion Rule: Internal Planning → Product PRD

Keep internal planning as the execution source of truth, and promote to a product PRD only when all of the following are true:

1. The work is a roadmap-level milestone or materially changes product positioning/capability.
2. Scope and user-facing outcome are stable enough to describe without sprint-level task detail.
3. The milestone is expected to span multiple execution items (not a single backlog ticket).

When promoted, create or update a doc in [`prds/`](prds/) with problem, target outcome, in/out scope, and dependencies. Keep sprint plans, ticket inventories, and delivery history in [`../internal/`](../internal/).
