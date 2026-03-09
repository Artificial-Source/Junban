import { useState, useEffect, useCallback } from "react";
import { useAIContext } from "../../../context/AIContext.js";
import { api } from "../../../api/index.js";
import type { AiMemoryRow } from "../../../../storage/interface.js";
import { CATEGORY_COLORS } from "./ai-tab-constants.js";

export function MemorySection() {
  const [memories, setMemories] = useState<AiMemoryRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<AiMemoryRow["category"]>("context");
  const { dataMutationCount } = useAIContext();

  const loadMemories = useCallback(async () => {
    try {
      const data = await api.getAiMemories();
      setMemories(data);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    loadMemories();
  }, [loadMemories, dataMutationCount]);

  const handleEdit = (memory: AiMemoryRow) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editContent.trim()) return;
    await api.updateAiMemory(editingId, editContent.trim(), editCategory);
    setEditingId(null);
    await loadMemories();
  };

  const handleDelete = async (id: string) => {
    await api.deleteAiMemory(id);
    await loadMemories();
  };

  const handleClearAll = async () => {
    await api.deleteAllAiMemories();
    await loadMemories();
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-on-surface">Memory</h2>
        {memories.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-on-surface-muted">
              {memories.length} {memories.length === 1 ? "memory" : "memories"}
            </span>
            <button onClick={handleClearAll} className="text-xs text-danger hover:text-danger/80">
              Clear all
            </button>
          </div>
        )}
      </div>

      {memories.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No memories yet. The AI will remember important things you share in conversations.
        </p>
      ) : (
        <div className="space-y-2 max-w-lg">
          {memories.map((memory) => (
            <div key={memory.id} className="border border-border rounded-lg p-3 bg-surface">
              {editingId === memory.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-border rounded bg-surface text-on-surface resize-none"
                    rows={2}
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as AiMemoryRow["category"])}
                      className="px-2 py-1 text-xs border border-border rounded bg-surface text-on-surface"
                    >
                      <option value="preference">preference</option>
                      <option value="habit">habit</option>
                      <option value="context">context</option>
                      <option value="instruction">instruction</option>
                      <option value="pattern">pattern</option>
                    </select>
                    <button
                      onClick={handleSaveEdit}
                      className="px-2 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-on-surface">{memory.content}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span
                        className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${CATEGORY_COLORS[memory.category] ?? CATEGORY_COLORS.context}`}
                      >
                        {memory.category}
                      </span>
                      <span className="text-[10px] text-on-surface-muted">
                        {new Date(memory.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleEdit(memory)}
                      className="p-1 text-on-surface-muted hover:text-on-surface rounded"
                      title="Edit"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        <path d="m15 5 4 4" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(memory.id)}
                      className="p-1 text-on-surface-muted hover:text-danger rounded"
                      title="Delete"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
