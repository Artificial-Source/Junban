import { X, Link } from "lucide-react";
import type { Task } from "../../../core/types.js";
import * as taskApi from "../../api/tasks.js";

interface TaskRelationsProps {
  task: Task;
  allTasks: Task[];
  relBlocks: Task[];
  setRelBlocks: React.Dispatch<React.SetStateAction<Task[]>>;
  relBlockedBy: Task[];
  setRelBlockedBy: React.Dispatch<React.SetStateAction<Task[]>>;
  relSearch: string;
  setRelSearch: (value: string) => void;
  relSearchOpen: boolean;
  setRelSearchOpen: (value: boolean) => void;
  onSelect?: (id: string) => void;
}

export function TaskRelations({
  task,
  allTasks,
  relBlocks,
  setRelBlocks,
  relBlockedBy,
  setRelBlockedBy,
  relSearch,
  setRelSearch,
  relSearchOpen,
  setRelSearchOpen,
  onSelect,
}: TaskRelationsProps) {
  return (
    <>
      {(relBlocks.length > 0 || relBlockedBy.length > 0 || relSearchOpen) && (
        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2 mb-2">
            <Link size={14} className="text-on-surface-muted" />
            <h3 className="text-sm font-medium text-on-surface">Relations</h3>
          </div>

          {relBlocks.length > 0 && (
            <div className="mb-2">
              <span className="text-xs text-on-surface-muted font-medium uppercase tracking-wider">
                Blocks
              </span>
              <div className="mt-1 space-y-1">
                {relBlocks.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between group rounded px-2 py-1 hover:bg-surface-secondary"
                  >
                    <button
                      className="text-sm text-on-surface hover:text-accent truncate text-left"
                      onClick={() => onSelect?.(t.id)}
                    >
                      {t.title}
                    </button>
                    <button
                      className="p-0.5 rounded text-on-surface-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove relation"
                      onClick={async () => {
                        await taskApi.removeTaskRelation(task.id, t.id);
                        setRelBlocks((prev) => prev.filter((r) => r.id !== t.id));
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {relBlockedBy.length > 0 && (
            <div className="mb-2">
              <span className="text-xs text-on-surface-muted font-medium uppercase tracking-wider">
                Blocked by
              </span>
              <div className="mt-1 space-y-1">
                {relBlockedBy.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between group rounded px-2 py-1 hover:bg-surface-secondary"
                  >
                    <button
                      className="text-sm text-on-surface hover:text-accent truncate text-left"
                      onClick={() => onSelect?.(t.id)}
                    >
                      {t.title}
                    </button>
                    <button
                      className="p-0.5 rounded text-on-surface-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove relation"
                      onClick={async () => {
                        await taskApi.removeTaskRelation(t.id, task.id);
                        setRelBlockedBy((prev) => prev.filter((r) => r.id !== t.id));
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add relation search */}
          {relSearchOpen && (
            <div className="mt-2">
              <input
                type="text"
                value={relSearch}
                onChange={(e) => setRelSearch(e.target.value)}
                placeholder="Search tasks to link..."
                autoFocus
                className="w-full text-sm bg-transparent border border-border rounded-md px-3 py-1.5 text-on-surface placeholder-on-surface-muted/50 focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {relSearch.trim() && (
                <div className="mt-1 max-h-32 overflow-y-auto rounded-md border border-border bg-surface">
                  {allTasks
                    .filter(
                      (t) =>
                        t.id !== task.id &&
                        t.status === "pending" &&
                        t.title.toLowerCase().includes(relSearch.toLowerCase()) &&
                        !relBlocks.some((r) => r.id === t.id) &&
                        !relBlockedBy.some((r) => r.id === t.id),
                    )
                    .slice(0, 8)
                    .map((t) => (
                      <button
                        key={t.id}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-secondary text-on-surface truncate"
                        onClick={async () => {
                          try {
                            await taskApi.addTaskRelation(task.id, t.id);
                            setRelBlocks((prev) => [...prev, t]);
                            setRelSearch("");
                            setRelSearchOpen(false);
                          } catch {
                            // cycle or other error — ignore
                          }
                        }}
                      >
                        {t.title}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add relation button */}
      {!relSearchOpen && (
        <button
          className="flex items-center gap-1.5 text-xs text-on-surface-muted hover:text-accent mt-2"
          onClick={() => setRelSearchOpen(true)}
        >
          <Link size={12} />
          Add relation
        </button>
      )}
    </>
  );
}
