# Legacy Documentation Compatibility Policy

This policy defines how Junban keeps legacy documentation paths alive for link compatibility without treating them as canonical authoring surfaces.

## Canonical vs legacy surfaces

- Canonical documentation lives under `docs/guides/`, `docs/reference/`, `docs/product/`, and `docs/internal/`.
- Legacy compatibility stubs exist under historical paths (`docs/frontend`, `docs/backend`, `docs/plugins`, and `docs/planning`).
- New normative content must be authored in canonical docs, not in legacy stubs.
- `docs/site/` is a website publication layer and must not be treated as canonical documentation.

## Stub requirements

Each compatibility stub should:

1. Clearly state it is a legacy path kept for compatibility.
2. Link directly to the canonical replacement page.
3. Avoid duplicating full documentation content.

Allowed stub edits are limited to link fixes, clarity improvements, and safety-critical notices that immediately route readers to canonical docs.

## Lifecycle and retirement guidance

Compatibility stubs are intentionally temporary but may stay in place across multiple milestones.

Retirement should happen only when all conditions are met:

1. Canonical replacement docs are stable.
2. Internal docs and templates no longer rely on the legacy path.
3. A dedicated cleanup milestone/PR explicitly removes the stubs and updates affected links.

Until then, keep stubs in place.

Review stub retirement during each release-preparation cycle and record whether the stubs should be retained or retired.

## Enforcement notes

- `scripts/docs-check.ts` treats legacy-path usage as restricted and allowlists only intentional references.
- The old `docs/development` namespace is retired and no longer part of active legacy-path enforcement.
