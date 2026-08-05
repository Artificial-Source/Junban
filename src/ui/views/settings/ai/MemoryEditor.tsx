/**
 * AI memory list with create / edit / delete under domain bounds.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { ApiError } from "../../../api/client";
import { createAiOperationId } from "../../../ai/operation-id";
import {
  createAiMemory,
  deleteAiMemory,
  listAiMemories,
  sanitizeTransportError,
  updateAiMemory,
} from "../../../ai/transport";
import type { AiMemoryDto } from "../../../ai/types";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { primaryButtonClass, secondaryButtonClass } from "../settingsHelpers";
import { MEMORY_CONTENT_MAX, MEMORY_PAGE_SIZE, MEMORIES_PER_PROFILE_MAX } from "./constants";
import { readAiSettingsVisualState } from "./aiFixture";

function errorMessage(error: unknown): string {
  const safe = sanitizeTransportError(error);
  if (safe instanceof ApiError) return safe.message;
  return safe.message || "Memory request failed";
}

const FIXTURE_MEMORIES: AiMemoryDto[] = [
  {
    id: "00000000-0000-4000-8000-000000000021",
    content: "Prefers concise morning plans.",
    content_bytes: 32,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
  },
];

export function MemoryEditor() {
  const [memories, setMemories] = useState<AiMemoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const generationRef = useRef(0);
  const createId = useId();
  const fixtureMode = readAiSettingsVisualState() !== null;

  const load = useCallback(async () => {
    if (fixtureMode) {
      setMemories(FIXTURE_MEMORIES);
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listAiMemories({ limit: MEMORY_PAGE_SIZE });
      if (generation !== generationRef.current) return;
      setMemories(page.memories);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [fixtureMode]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const atCapacity = memories.length >= MEMORIES_PER_PROFILE_MAX;

  const handleCreate = async () => {
    const content = draft.trim();
    if (!content || pending) return;
    if (content.length > MEMORY_CONTENT_MAX) {
      setError(`Memory must be at most ${MEMORY_CONTENT_MAX} characters.`);
      return;
    }
    if (atCapacity) {
      setError(`At most ${MEMORIES_PER_PROFILE_MAX} memories are retained.`);
      return;
    }
    if (fixtureMode) {
      setStatus("Fixture mode — memories are not modified.");
      return;
    }
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      await createAiMemory({ content }, { operationId: createAiOperationId() });
      setDraft("");
      setStatus("Memory saved");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId || pending) return;
    const content = editContent.trim();
    if (!content) return;
    if (content.length > MEMORY_CONTENT_MAX) {
      setError(`Memory must be at most ${MEMORY_CONTENT_MAX} characters.`);
      return;
    }
    if (fixtureMode) {
      setStatus("Fixture mode — memories are not modified.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await updateAiMemory(editingId, { content }, { operationId: createAiOperationId() });
      setEditingId(null);
      setEditContent("");
      setStatus("Memory updated");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: string) => {
    setConfirmDeleteId(null);
    if (fixtureMode) {
      setStatus("Fixture mode — memories are not modified.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await deleteAiMemory(id, { operationId: createAiOperationId() });
      setStatus("Memory deleted");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const handleClearAll = async () => {
    setConfirmClearAll(false);
    if (fixtureMode) {
      setStatus("Fixture mode — memories are not modified.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      // Sequential bounded deletes — one operation UUID per memory.
      for (const memory of memories) {
        await deleteAiMemory(memory.id, { operationId: createAiOperationId() });
      }
      setStatus("All memories cleared");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mb-8" data-testid="ai-memory-editor">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-on-surface">Memory</h2>
        {memories.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-on-surface-muted">
              {memories.length} {memories.length === 1 ? "memory" : "memories"}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmClearAll(true)}
              className="text-xs text-error hover:opacity-80 disabled:opacity-50"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      <p className="mb-3 text-xs text-on-surface-muted">
        Explicit memories the assistant may consider (up to {MEMORIES_PER_PROFILE_MAX},{" "}
        {MEMORY_CONTENT_MAX.toLocaleString()} characters each).
      </p>

      <div className="mb-4 max-w-lg space-y-2">
        <label htmlFor={createId} className="sr-only">
          New memory
        </label>
        <textarea
          id={createId}
          value={draft}
          rows={2}
          maxLength={MEMORY_CONTENT_MAX}
          disabled={pending || atCapacity}
          onChange={(event) => setDraft(event.target.value.slice(0, MEMORY_CONTENT_MAX))}
          placeholder="Add something the assistant should remember…"
          className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending || !draft.trim() || atCapacity}
            onClick={() => void handleCreate()}
            className={primaryButtonClass(pending || !draft.trim() || atCapacity)}
          >
            Add memory
          </button>
          <span className="text-xs text-on-surface-muted">
            {draft.length}/{MEMORY_CONTENT_MAX}
          </span>
        </div>
      </div>

      {loading && (
        <p role="status" className="text-sm text-on-surface-muted">
          Loading memories…
        </p>
      )}

      {error && (
        <p role="alert" className="mb-3 text-sm text-error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="mb-3 text-sm text-success">
          {status}
        </p>
      )}

      {!loading && memories.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No memories yet. Save important preferences or context here.
        </p>
      ) : (
        <div className="max-w-lg space-y-2">
          {memories.map((memory) => (
            <div key={memory.id} className="rounded-lg border border-border bg-surface p-3">
              {editingId === memory.id ? (
                <div className="space-y-2">
                  <label htmlFor={`memory-edit-${memory.id}`} className="sr-only">
                    Memory content
                  </label>
                  <textarea
                    id={`memory-edit-${memory.id}`}
                    aria-label="Memory content"
                    value={editContent}
                    rows={2}
                    maxLength={MEMORY_CONTENT_MAX}
                    onChange={(event) =>
                      setEditContent(event.target.value.slice(0, MEMORY_CONTENT_MAX))
                    }
                    className="w-full resize-none rounded border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={pending || !editContent.trim()}
                      onClick={() => void handleSaveEdit()}
                      className={primaryButtonClass(pending || !editContent.trim())}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setEditingId(null);
                        setEditContent("");
                      }}
                      className={secondaryButtonClass(pending)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-on-surface">{memory.content}</p>
                    <p className="mt-1.5 text-[10px] text-on-surface-muted">
                      {new Date(memory.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label="Edit memory"
                      title="Edit"
                      disabled={pending}
                      onClick={() => {
                        setEditingId(memory.id);
                        setEditContent(memory.content);
                      }}
                      className="rounded p-1 text-on-surface-muted hover:text-on-surface disabled:opacity-50"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete memory"
                      title="Delete"
                      disabled={pending}
                      onClick={() => setConfirmDeleteId(memory.id)}
                      className="rounded p-1 text-on-surface-muted hover:text-error disabled:opacity-50"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete memory?"
        message="This memory will be removed permanently."
        confirmLabel="Delete"
        pending={pending}
        onConfirm={() => {
          if (confirmDeleteId) void handleDelete(confirmDeleteId);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
      <ConfirmDialog
        open={confirmClearAll}
        title="Clear all memories?"
        message="Every stored memory will be deleted. This cannot be undone."
        confirmLabel="Clear all"
        pending={pending}
        onConfirm={() => void handleClearAll()}
        onCancel={() => setConfirmClearAll(false)}
      />
    </section>
  );
}
