/**
 * Multi-select state for task lists.
 * Supports single click (select one), ctrl/cmd+click (toggle), and shift+click (range).
 */
import { useCallback, useState } from "react";

export interface MultiSelectState {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
}

export function useMultiSelect() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastSelectedId(id);
  }, []);

  const selectRange = useCallback(
    (id: string, orderedIds: string[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (!lastSelectedId) {
          next.add(id);
          return next;
        }
        const start = orderedIds.indexOf(lastSelectedId);
        const end = orderedIds.indexOf(id);
        if (start === -1 || end === -1) {
          next.add(id);
          return next;
        }
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        for (let i = from; i <= to; i++) {
          next.add(orderedIds[i]!);
        }
        return next;
      });
      setLastSelectedId(id);
    },
    [lastSelectedId],
  );

  const handleSelect = useCallback(
    (
      id: string,
      event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
      orderedIds?: string[],
    ) => {
      if (event.ctrlKey || event.metaKey) {
        toggle(id);
      } else if (event.shiftKey && orderedIds) {
        selectRange(id, orderedIds);
      } else {
        setSelectedIds(new Set([id]));
        setLastSelectedId(id);
      }
    },
    [toggle, selectRange],
  );

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedId(null);
  }, []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return {
    selectedIds,
    handleSelect,
    clear,
    isSelected,
    count: selectedIds.size,
  };
}
