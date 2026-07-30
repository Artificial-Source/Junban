/**
 * Catalog live query: small organization snapshot + monotonic revision.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogResponse, CommittedEventDto } from "../api/client";
import { ApiError, getCatalog, hasStoredToken } from "../api/client";
import { nextStateFromRevisionSnapshot, RefreshCoalescer } from "./liveQuery";

export interface CatalogState {
  catalog: CatalogResponse | null;
  revision: number;
  loading: boolean;
  error: string | null;
}

export function formatCatalogError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}

/**
 * Decide whether a catalog snapshot may replace local state.
 * Equal revisions are allowed so a snapshot can confirm the same head.
 */
export function nextCatalogFromSnapshot(
  currentRevision: number,
  snapshot: CatalogResponse,
): CatalogResponse | null {
  const next = nextStateFromRevisionSnapshot(currentRevision, {
    revision: snapshot.revision,
    value: snapshot,
  });
  return next ? next.value : null;
}

function patchCatalogFromEvent(
  catalog: CatalogResponse,
  event: CommittedEventDto,
): CatalogResponse | null {
  if (event.resync.catalog) return null;
  const snapshot = event.snapshot;
  if (!snapshot) return null;

  const revision = Math.max(catalog.revision, event.revision);
  switch (snapshot.resource_type) {
    case "project": {
      const projects = upsertById(catalog.projects, snapshot.project);
      return { ...catalog, revision, projects };
    }
    case "section": {
      const sections = upsertById(catalog.sections, snapshot.section);
      return { ...catalog, revision, sections };
    }
    case "tag": {
      const tags = upsertById(catalog.tags, snapshot.tag);
      return { ...catalog, revision, tags };
    }
    case "template": {
      const templates = upsertById(catalog.templates, snapshot.template);
      return { ...catalog, revision, templates };
    }
    case "saved_filter": {
      const saved_filters = upsertById(catalog.saved_filters, snapshot.saved_filter);
      return { ...catalog, revision, saved_filters };
    }
    default:
      return null;
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function removeByIds<T extends { id: string }>(items: T[], ids: string[] | undefined): T[] {
  if (!ids || ids.length === 0) return items;
  const drop = new Set(ids);
  const next = items.filter((item) => !drop.has(item.id));
  return next.length === items.length ? items : next;
}

export function applyCatalogEvent(
  catalog: CatalogResponse,
  event: CommittedEventDto,
): { catalog: CatalogResponse; needsRefresh: boolean } {
  if (event.revision < catalog.revision) {
    return { catalog, needsRefresh: false };
  }

  if (event.resync.catalog) {
    return { catalog, needsRefresh: true };
  }

  if (event.event_type.endsWith(".deleted") && event.affected) {
    const next: CatalogResponse = {
      ...catalog,
      revision: event.revision,
      projects: removeByIds(catalog.projects, event.affected.project_ids),
      sections: removeByIds(catalog.sections, event.affected.section_ids),
      tags: removeByIds(catalog.tags, event.affected.tag_ids),
      templates: removeByIds(catalog.templates, event.affected.template_ids),
      saved_filters: removeByIds(catalog.saved_filters, event.affected.saved_filter_ids),
    };
    return { catalog: next, needsRefresh: false };
  }

  const patched = patchCatalogFromEvent(catalog, event);
  if (patched) return { catalog: patched, needsRefresh: false };

  // No applicable snapshot — leave local catalog alone; caller may still advance revision.
  return { catalog: { ...catalog, revision: event.revision }, needsRefresh: false };
}

export function useCatalog(): CatalogState & {
  refresh: () => void;
  applyEvent: (event: CommittedEventDto) => void;
  requestResync: () => void;
} {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const appliedRevisionRef = useRef(0);
  const coalescerRef = useRef(new RefreshCoalescer());
  const catalogRef = useRef<CatalogResponse | null>(null);

  const applySnapshot = useCallback((snapshot: CatalogResponse) => {
    const next = nextCatalogFromSnapshot(appliedRevisionRef.current, snapshot);
    if (!next) return false;
    appliedRevisionRef.current = next.revision;
    catalogRef.current = next;
    setCatalog(next);
    setRevision(next.revision);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!hasStoredToken()) {
      setLoading(false);
      return;
    }
    await coalescerRef.current.run(async () => {
      try {
        const snapshot = await getCatalog();
        applySnapshot(snapshot);
        setError(null);
      } catch (err) {
        setError(formatCatalogError(err));
      } finally {
        setLoading(false);
      }
    });
  }, [applySnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyEvent = useCallback(
    (event: CommittedEventDto) => {
      const current = catalogRef.current;
      if (!current) {
        void refresh();
        return;
      }
      const result = applyCatalogEvent(current, event);
      if (result.needsRefresh) {
        void refresh();
        return;
      }
      if (result.catalog !== current) {
        appliedRevisionRef.current = result.catalog.revision;
        catalogRef.current = result.catalog;
        setCatalog(result.catalog);
        setRevision(result.catalog.revision);
      } else if (event.revision > appliedRevisionRef.current) {
        appliedRevisionRef.current = event.revision;
        setRevision(event.revision);
      }
    },
    [refresh],
  );

  return {
    catalog,
    revision,
    loading,
    error,
    refresh: () => {
      setError(null);
      setLoading(true);
      void refresh();
    },
    applyEvent,
    requestResync: () => {
      void refresh();
    },
  };
}
