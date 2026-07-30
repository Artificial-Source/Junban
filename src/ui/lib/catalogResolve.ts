/**
 * Resolve catalog entity names against the authoritative workspace snapshot.
 *
 * Matching is Unicode-trimmed and case-insensitive exact equality. Ambiguous
 * matches (multiple distinct IDs for one key) are reported rather than guessed.
 * Callers own create-on-miss policy; this module never invents entities.
 */

export type NamedCatalogEntity = {
  id: string;
  name: string;
};

export type CatalogResolveResult =
  { kind: "found"; id: string } | { kind: "not_found" } | { kind: "ambiguous" };

/** Unicode trim via String.prototype.trim (ES whitespace + BOM). */
export function trimCatalogName(name: string): string {
  return name.trim();
}

/** Comparison key: trimmed + locale-lowercase. */
export function catalogNameKey(name: string): string {
  return trimCatalogName(name).toLocaleLowerCase();
}

/**
 * Resolve a free-text name to exactly one catalog entity ID.
 * Empty names after trim are treated as not found.
 */
export function resolveCatalogEntity(
  items: readonly NamedCatalogEntity[],
  name: string,
): CatalogResolveResult {
  const key = catalogNameKey(name);
  if (!key) return { kind: "not_found" };

  let foundId: string | undefined;
  for (const item of items) {
    if (catalogNameKey(item.name) !== key) continue;
    if (foundId === undefined) {
      foundId = item.id;
      continue;
    }
    if (foundId !== item.id) return { kind: "ambiguous" };
  }

  if (foundId === undefined) return { kind: "not_found" };
  return { kind: "found", id: foundId };
}

export function formatCatalogResolveError(
  entityKind: "tag" | "project",
  name: string,
  result: Exclude<CatalogResolveResult, { kind: "found" }>,
): string {
  const label = trimCatalogName(name) || name;
  if (result.kind === "ambiguous") {
    return `Ambiguous ${entityKind} name "${label}".`;
  }
  return `Unknown ${entityKind} "${label}".`;
}
