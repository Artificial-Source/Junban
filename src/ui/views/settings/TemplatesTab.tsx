import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { api } from "../../api/index.js";
import type { TaskTemplate, CreateTemplateInput } from "../../../core/types.js";
import { createLogger } from "../../../utils/logger.js";

const logger = createLogger("templates-tab");

export function TemplatesTab() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTemplates = useCallback(() => {
    api
      .listTemplates()
      .then(setTemplates)
      .catch((err) => logger.error("Failed to load templates", { error: String(err) }));
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleDelete = async (id: string) => {
    await api.deleteTemplate(id);
    loadTemplates();
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-on-surface">Task Templates</h2>
        <button
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      <p className="text-sm text-on-surface-muted mb-4">
        Templates let you quickly create tasks with predefined fields. Use {"{{variable}}"} syntax
        in title and description for dynamic values.
      </p>

      {(creating || editing) && (
        <TemplateForm
          template={editing}
          onSave={() => {
            setCreating(false);
            setEditing(null);
            loadTemplates();
          }}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {templates.length === 0 && !creating ? (
        <p className="text-on-surface-muted text-sm py-4">
          No templates yet. Click &quot;New Template&quot; to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between px-4 py-3 border border-border rounded-lg bg-surface-secondary"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-on-surface">{t.name}</div>
                <div className="text-sm text-on-surface-secondary truncate">{t.title}</div>
                <div className="flex gap-1.5 mt-1">
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
                  {t.recurrence && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success">
                      {t.recurrence}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-3">
                <button
                  onClick={() => {
                    setEditing(t);
                    setCreating(false);
                  }}
                  className="p-1.5 text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-tertiary"
                  title="Edit template"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(t.id)}
                  className="p-1.5 text-on-surface-muted hover:text-error rounded hover:bg-surface-tertiary"
                  title="Delete template"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TemplateForm({
  template,
  onSave,
  onCancel,
}: {
  template: TaskTemplate | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [priority, setPriority] = useState<string>(
    template?.priority ? String(template.priority) : "",
  );
  const [tags, setTags] = useState(template?.tags.join(", ") ?? "");
  const [recurrence, setRecurrence] = useState(template?.recurrence ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !title.trim()) return;

    setSaving(true);
    try {
      const input: CreateTemplateInput = {
        name: name.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority ? Number(priority) : undefined,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        recurrence: recurrence.trim() || undefined,
      };

      if (template) {
        await api.updateTemplate(template.id, input);
      } else {
        await api.createTemplate(input);
      }
      onSave();
    } catch (err) {
      logger.error("Failed to save template", { error: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 p-4 border border-accent/30 rounded-lg bg-surface space-y-3"
    >
      <h3 className="font-medium text-on-surface">{template ? "Edit Template" : "New Template"}</h3>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Bug Report"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
          required
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Title Template
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={"e.g., Fix: {{issue}}"}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
          required
        />
        <p className="text-xs text-on-surface-muted mt-1">
          Use {"{{variable}}"} for dynamic values
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Description (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task description..."
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent resize-none"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium text-on-surface-secondary mb-1">
            Priority
          </label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="">None</option>
            <option value="1">P1 - Urgent</option>
            <option value="2">P2 - High</option>
            <option value="3">P3 - Medium</option>
            <option value="4">P4 - Low</option>
          </select>
        </div>

        <div className="flex-1">
          <label className="block text-sm font-medium text-on-surface-secondary mb-1">
            Recurrence
          </label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          >
            <option value="">None</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-on-surface-secondary mb-1">
          Tags (comma-separated)
        </label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g., bug, frontend"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface rounded-lg hover:bg-surface-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !name.trim() || !title.trim()}
          className="px-4 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : template ? "Update" : "Create"}
        </button>
      </div>
    </form>
  );
}
