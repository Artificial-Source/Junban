# Documentation IA Audit (Milestone 1) — Planning Artifact

This is a milestone planning artifact and historical record for the documentation reorganization effort.
It is **not** a stable contributor onboarding guide.

Milestone 3 later moved the technical-reference docs under `docs/reference/` and the internal execution artifacts under `docs/internal/`; the inventory below is the pre-move Milestone 1 snapshot.

Scope of this milestone:

- Capture the current documentation inventory
- Record current information architecture (IA) problems
- Define the target structure for later milestones

Out of scope for this milestone:

- Moving or renaming existing documentation files
- Changing contributor workflows beyond linking to this audit
- Publishing docs to an external docs site or Context7

## Current Documentation Inventory

The repository currently contains multiple documentation types under `docs/`, plus top-level contributor/agent entrypoints.

### Top-level entrypoints

| Path             | Current role                                          | Primary audience          |
| ---------------- | ----------------------------------------------------- | ------------------------- |
| `AGENTS.md`      | Fast navigation and coding-agent operating guide      | AI agents, maintainers    |
| `CLAUDE.md`      | Repo-level development guide and architecture summary | Contributors, maintainers |
| `docs/README.md` | Canonical docs index and ownership map                | Contributors, maintainers |

### Historical `docs/` directories snapshot (pre-Milestone 3 move)

| Path                | Current role                                    | Notes                                                                           |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `docs/guides/`      | Cross-cutting contributor and maintainer guides | Still canonical; setup, architecture, security, releases, contributing          |
| `docs/frontend/`    | Frontend reference by code area                 | Historical path; now a compatibility stub routing to `docs/reference/frontend/` |
| `docs/backend/`     | Backend/internal reference by code area         | Historical path; now a compatibility stub routing to `docs/reference/backend/`  |
| `docs/plugins/`     | Plugin author documentation                     | Historical path; now a compatibility stub routing to `docs/reference/plugins/`  |
| `docs/planning/`    | Product-facing roadmap/status                   | Historical path; now a compatibility alias to `docs/product/`                   |
| `docs/development/` | Internal planning execution artifacts           | Historical path retired after the move to `docs/internal/`                      |

## Current IA Problems

1. **Mixed intent in one namespace**
   - `docs/` currently mixes canonical contributor docs, product-facing planning, and internal planning/execution artifacts.
   - Result: maintainers must know historical context to find the right source of truth quickly.

2. **Organization follows code structure more than docs-library use cases**
   - Strong coverage exists for frontend/backend/component ownership.
   - Navigation is weaker for task-based maintainer flows (for example: "where are product planning docs vs internal planning docs?").

3. **Audience boundaries are implicit instead of explicit**
   - Some docs are public-facing references, while others are internal planning records.
   - The current IA does not clearly label these audience boundaries in a single canonical map.

4. **Future publication constraints are not yet reflected in structure**
   - Planned future publication targets (docs website and Context7 ingestion) benefit from clearer content domains and stable paths.
   - Current structure is serviceable for repo contributors but not yet optimized for external docs distribution.

## Target Structure (Planned for Later Milestones)

The target IA for later milestones is a **library-oriented structure** with explicit audience and purpose boundaries.

Planned content domains:

| Target domain                   | Purpose                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Contributor & Maintainer Guides | Task-based workflows (setup, contributing, maintainers, release/security/process) |
| Technical Reference             | Code/system reference docs (frontend/backend/plugins/API details)                 |
| Product & Public Planning       | Public roadmap/status and user-facing product planning artifacts                  |
| Internal Development Planning   | Backlog/epics/sprint execution records (explicitly marked internal)               |

Planned navigation outcomes:

- Maintainers can find the correct doc family in 1–2 hops from `docs/README.md`.
- Canonical docs are clearly separated from historical/internal planning artifacts.
- Path and taxonomy choices are prepared for future docs website and Context7 publication.

## Milestone Sequencing (Non-binding, Planning Only)

- **Milestone 1 (this doc):** audit + gap map + target IA definition
- **Milestone 2:** introduce/adjust directory taxonomy and index links
- **Milestone 3:** move/normalize docs into target domains with redirects or link updates
- **Milestone 4:** split product-facing docs into `docs/product/` and preserve legacy roadmap routing

## Decision Record

This file is the canonical Milestone 1 artifact for documentation IA planning.
Milestone 2 introduced the taxonomy routing surfaces, Milestone 3 completed the library move, and Milestone 4 split product-facing docs into `docs/product/`; use `docs/README.md` for the current canonical structure.
