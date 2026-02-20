import { useState, useEffect, useCallback } from "react";
import { X, FileText, Play } from "lucide-react";
import { api } from "../api/index.js";
import type { TaskTemplate, Task } from "../../core/types.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("template-selector");

interface TemplateSelectorProps {
  open: boolean;
  onClose: () => void;
  onTaskCreated: (task: Task) => void;
}

export function TemplateSelector({ open, onClose, onTaskCreated }: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selected, setSelected] = useState<TaskTemplate | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      api
        .listTemplates()
        .then(setTemplates)
        .catch((err) => logger.error("Failed to load templates", { error: String(err) }));
      setSelected(null);
      setVariables({});
    }
  }, [open]);

  const extractVariables = useCallback((template: TaskTemplate): string[] => {
    const vars = new Set<string>();
    const pattern = /\{\{(\w+)\}\}/g;
    let match;
    while ((match = pattern.exec(template.title)) !== null) {
      vars.add(match[1]);
    }
    if (template.description) {
      while ((match = pattern.exec(template.description)) !== null) {
        vars.add(match[1]);
      }
    }
    return Array.from(vars);
  }, []);

  const handleSelect = (template: TaskTemplate) => {
    setSelected(template);
    const vars: Record<string, string> = {};
    for (const v of extractVariables(template)) {
      vars[v] = "";
    }
    setVariables(vars);
  };

  const handleInstantiate = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const nonEmpty: Record<string, string> = {};
      for (const [k, v] of Object.entries(variables)) {
        if (v.trim()) nonEmpty[k] = v.trim();
      }
      const task = await api.instantiateTemplate(
        selected.id,
        Object.keys(nonEmpty).length > 0 ? nonEmpty : undefined,
      );
      onTaskCreated(task);
      onClose();
    } catch (err) {
      logger.error("Failed to instantiate template", { error: String(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      handleInstantiate();
    }
  };

  if (!open) return null;

  const varKeys = selected ? extractVariables(selected) : [];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-semibold text-on-surface flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Create from Template
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-on-surface-muted hover:text-on-surface rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {!selected ? (
            // Template list
            templates.length === 0 ? (
              <p className="text-center text-on-surface-muted py-8">
                No templates yet. Create one in Settings.
              </p>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t)}
                    className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-surface-secondary transition-colors"
                  >
                    <div className="font-medium text-on-surface">{t.name}</div>
                    <div className="text-sm text-on-surface-secondary mt-0.5">{t.title}</div>
                    <div className="flex gap-1.5 mt-1.5">
                      {t.priority && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                          P{t.priority}
                        </span>
                      )}
                      {t.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : (
            // Variable form
            <div>
              <button
                onClick={() => setSelected(null)}
                className="text-sm text-accent hover:underline mb-4"
              >
                &larr; Back to templates
              </button>
              <h3 className="font-medium text-on-surface mb-1">{selected.name}</h3>
              <p className="text-sm text-on-surface-secondary mb-4">{selected.title}</p>

              {varKeys.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-on-surface-muted">Fill in the template variables:</p>
                  {varKeys.map((v) => (
                    <div key={v}>
                      <label className="block text-sm font-medium text-on-surface-secondary mb-1">
                        {`{{${v}}}`}
                      </label>
                      <input
                        type="text"
                        value={variables[v] ?? ""}
                        onChange={(e) => setVariables({ ...variables, [v]: e.target.value })}
                        placeholder={v}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                        autoFocus={varKeys.indexOf(v) === 0}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-on-surface-muted">
                  This template has no variables. Click create to make the task.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {selected && (
          <div className="px-4 py-3 border-t border-border flex justify-end">
            <button
              onClick={handleInstantiate}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors text-sm font-medium"
            >
              <Play className="w-4 h-4" />
              {loading ? "Creating..." : "Create Task"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
