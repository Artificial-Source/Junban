/**
 * Map a Rust-parsed filter DTO onto list-task query params using catalog IDs.
 * Names never leave this boundary as IDs; resolution failures stay visible.
 */

import type { ParsedFilterResponse, TaskListParams } from "../api/client";
import {
  formatCatalogResolveError,
  resolveCatalogEntity,
  type NamedCatalogEntity,
} from "./catalogResolve";

export type FilterParamsResult =
  { ok: true; params: TaskListParams } | { ok: false; error: string };

export function taskListParamsFromParsedFilter(
  filter: ParsedFilterResponse["filter"],
  catalog: {
    tags: readonly NamedCatalogEntity[];
    projects: readonly NamedCatalogEntity[];
  },
  extras?: Partial<TaskListParams>,
): FilterParamsResult {
  const tagIds: string[] = [];
  for (const name of filter.tag_names ?? []) {
    const resolved = resolveCatalogEntity(catalog.tags, name);
    if (resolved.kind !== "found") {
      return { ok: false, error: formatCatalogResolveError("tag", name, resolved) };
    }
    if (!tagIds.includes(resolved.id)) tagIds.push(resolved.id);
  }

  let projectId: string | undefined;
  if (filter.project_name) {
    const resolved = resolveCatalogEntity(catalog.projects, filter.project_name);
    if (resolved.kind !== "found") {
      return {
        ok: false,
        error: formatCatalogResolveError("project", filter.project_name, resolved),
      };
    }
    projectId = resolved.id;
  }

  const statuses = filter.statuses ?? [];
  const params: TaskListParams = {
    search: filter.search ?? undefined,
    priority: filter.priority ?? undefined,
    overdue: filter.overdue ?? undefined,
    due_on: filter.due_on ?? undefined,
    due_before: filter.due_before ?? undefined,
    due_after: filter.due_after ?? undefined,
    someday: filter.someday ?? undefined,
    status: statuses.length > 0 ? statuses.join(",") : undefined,
    project_id: projectId,
    // Comma-separated tag IDs; server applies AND semantics across the list.
    tag_ids: tagIds.length > 0 ? tagIds.join(",") : undefined,
    limit: 100,
    ...extras,
  };

  return { ok: true, params };
}
