# Website Documentation Hub

Canonical source: [`../README.md`](../README.md)

This is the publication-layer hub for website-facing Junban docs.

Use this page to route by audience, then continue into the canonical docs library for full details.

## Audience entry points

- Users: [`users/README.md`](users/README.md)
- Developers: [`developers/README.md`](developers/README.md)
- AI agents: [`agents/README.md`](agents/README.md)

## Publication contract

- `docs/site/` is publication-only and is **not** canonical source-of-truth documentation.
- Every page under `docs/site/` must include a visible **Canonical source** line.
- Canonical source targets must live in exactly one of these domains:
  - `docs/guides/`
  - `docs/reference/`
  - `docs/product/`
- Exception: `docs/site/README.md` itself is canonicalized by and points to [`../README.md`](../README.md).
- If published wording changes behavior or workflow meaning, update the mapped canonical page in the same PR.

## Canonical routing

- Guides: [`../guides/`](../guides/)
- Technical reference: [`../reference/README.md`](../reference/README.md)
- Product docs: [`../product/README.md`](../product/README.md)
- Docs ownership and governance map: [`../README.md`](../README.md)
