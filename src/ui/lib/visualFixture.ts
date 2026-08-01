/** Explicit, query-scoped rendering fixtures used only by immutable visual tests. */
export function isVisualFixture(search: string, fixture: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  return params.get("visual-fixture") === fixture;
}
