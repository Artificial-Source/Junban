/**
 * Bounded template management surface (Phase 2).
 * Lives under Filters & Labels until full Settings arrives in Phase 4.
 * Recurrence controls stay hidden even though the schema stores a field.
 */
import { useMemo, useState } from "react";
import { FileStack, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  CreateTemplateRequest,
  PatchTemplateRequest,
  TagDto,
  TemplateDto,
} from "../api/client";
import { useCatalogMutations } from "../hooks/useCatalogMutations";
import { ConfirmDialog } from "./ConfirmDialog";

interface TemplatesSectionProps {
  templates: TemplateDto[];
  tags: TagDto[];
}

interface TemplateFormState {
  name: string;
  title: string;
  description: string;
  priority: string;
  tagNames: string[];
}

function emptyForm(): TemplateFormState {
  return { name: "", title: "", description: "", priority: "", tagNames: [] };
}

function formFromTemplate(template: TemplateDto): TemplateFormState {
  return {
    name: template.name,
    title: template.title,
    description: template.description ?? "",
    priority: template.priority != null ? String(template.priority) : "",
    tagNames: [...template.tag_names],
  };
}

export function TemplatesSection({ templates, tags }: TemplatesSectionProps) {
  const { createTemplate, patchTemplate, deleteTemplate } = useCatalogMutations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TemplateDto | null>(null);
  const [form, setForm] = useState<TemplateFormState>(emptyForm);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateDto | null>(null);

  const sorted = useMemo(
    () =>
      [...templates].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [templates],
  );

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setForm(emptyForm());
    setError(null);
  };

  const openEdit = (template: TemplateDto) => {
    setEditing(template);
    setCreating(false);
    setForm(formFromTemplate(template));
    setError(null);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setForm(emptyForm());
    setError(null);
  };

  const handleSubmit = async () => {
    if (pending) return;
    const name = form.name.trim();
    const title = form.title.trim();
    if (!name || !title) {
      setError("Name and title are required.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const priority = form.priority ? Number.parseInt(form.priority, 10) : null;
      if (editing) {
        const body: PatchTemplateRequest = {
          name,
          title,
          description: form.description.trim() || null,
          priority,
          tag_names: form.tagNames,
        };
        const result = await patchTemplate(editing.id, body);
        if (!result) {
          setError("Could not update template.");
          return;
        }
      } else {
        const body: CreateTemplateRequest = {
          name,
          title,
          description: form.description.trim() || null,
          priority,
          tag_names: form.tagNames,
        };
        const result = await createTemplate(body);
        if (!result) {
          setError("Could not create template.");
          return;
        }
      }
      closeForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template.");
    } finally {
      setPending(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget || pending) return;
    setPending(true);
    try {
      await deleteTemplate(deleteTarget.id);
      setDeleteTarget(null);
      if (editing?.id === deleteTarget.id) closeForm();
    } finally {
      setPending(false);
    }
  };

  const showForm = creating || editing !== null;

  return (
    <section className="mb-6" aria-labelledby="templates-heading">
      <div className="flex items-center justify-between mb-2">
        <h2
          id="templates-heading"
          className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider flex items-center gap-1.5"
        >
          <FileStack size={12} aria-hidden="true" />
          Templates
        </h2>
        {!showForm && (
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-1 rounded-md bg-accent-action px-2.5 py-1 text-xs text-on-accent-action hover:bg-accent-action-hover"
          >
            <Plus size={12} />
            New Template
          </button>
        )}
      </div>

      <p className="text-sm text-on-surface-muted mb-3">
        Templates create tasks with predefined fields. Use {"{{variable}}"} in the title or
        description for placeholders filled when the template is applied.
      </p>

      {showForm && (
        <TemplateForm
          form={form}
          tags={tags}
          pending={pending}
          error={error}
          isEdit={editing !== null}
          onChange={setForm}
          onSubmit={() => void handleSubmit()}
          onCancel={closeForm}
        />
      )}

      {sorted.length === 0 && !showForm ? (
        <p className="text-sm text-on-surface-muted py-2">
          No templates yet. Click &quot;New Template&quot; to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between px-4 py-3 border border-border rounded-lg bg-surface-secondary"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-on-surface text-sm">{template.name}</div>
                <div className="text-sm text-on-surface-secondary truncate">{template.title}</div>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {template.priority != null && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      P{template.priority}
                    </span>
                  )}
                  {template.tag_names.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-1.5 py-0.5 rounded bg-accent-action/10 text-accent-foreground"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-3">
                <button
                  type="button"
                  onClick={() => openEdit(template)}
                  aria-label={`Edit template ${template.name}`}
                  className="p-1.5 text-on-surface-muted hover:text-on-surface rounded hover:bg-surface-tertiary"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(template)}
                  aria-label={`Delete template ${template.name}`}
                  className="p-1.5 text-on-surface-muted hover:text-error rounded hover:bg-surface-tertiary"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete template?"
        message={
          deleteTarget
            ? `Delete template "${deleteTarget.name}"? Existing tasks created from it are not affected.`
            : ""
        }
        confirmLabel="Delete template"
        cancelLabel="Cancel"
        pending={pending}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function TemplateForm({
  form,
  tags,
  pending,
  error,
  isEdit,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: TemplateFormState;
  tags: TagDto[];
  pending: boolean;
  error: string | null;
  isEdit: boolean;
  onChange: (next: TemplateFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const availableTags = tags.filter((tag) => !form.tagNames.includes(tag.name));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mb-4 p-4 border border-accent-action/30 rounded-lg bg-surface space-y-3"
    >
      <h3 className="font-medium text-on-surface text-sm">
        {isEdit ? "Edit Template" : "New Template"}
      </h3>

      <div>
        <label
          htmlFor="template-name"
          className="block text-sm font-medium text-on-surface-secondary mb-1"
        >
          Name
        </label>
        <input
          id="template-name"
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="e.g., Bug Report"
          required
          autoFocus
          disabled={pending}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
        />
      </div>

      <div>
        <label
          htmlFor="template-title"
          className="block text-sm font-medium text-on-surface-secondary mb-1"
        >
          Title Template
        </label>
        <input
          id="template-title"
          type="text"
          value={form.title}
          onChange={(e) => onChange({ ...form, title: e.target.value })}
          placeholder={"e.g., Fix: {{issue}}"}
          required
          disabled={pending}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
        />
        <p className="text-xs text-on-surface-muted mt-1">
          Use {"{{variable}}"} for dynamic values
        </p>
      </div>

      <div>
        <label
          htmlFor="template-description"
          className="block text-sm font-medium text-on-surface-secondary mb-1"
        >
          Description (optional)
        </label>
        <textarea
          id="template-description"
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
          placeholder="Task description..."
          rows={2}
          disabled={pending}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus resize-none"
        />
      </div>

      <div>
        <label
          htmlFor="template-priority"
          className="block text-sm font-medium text-on-surface-secondary mb-1"
        >
          Priority
        </label>
        <select
          id="template-priority"
          value={form.priority}
          onChange={(e) => onChange({ ...form, priority: e.target.value })}
          disabled={pending}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
        >
          <option value="">None</option>
          <option value="1">P1 - Urgent</option>
          <option value="2">P2 - High</option>
          <option value="3">P3 - Medium</option>
          <option value="4">P4 - Low</option>
        </select>
      </div>

      <div>
        <span className="block text-sm font-medium text-on-surface-secondary mb-1">Tags</span>
        <div className="flex flex-wrap gap-1.5">
          {form.tagNames.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-tertiary px-2 py-0.5 font-mono text-xs text-on-surface-secondary"
            >
              #{name}
              <button
                type="button"
                onClick={() =>
                  onChange({ ...form, tagNames: form.tagNames.filter((tag) => tag !== name) })
                }
                aria-label={`Remove tag ${name}`}
                className="text-on-surface-muted hover:text-error"
              >
                ×
              </button>
            </span>
          ))}
          {availableTags.length > 0 && (
            <select
              aria-label="Add template tag"
              defaultValue=""
              disabled={pending}
              onChange={(e) => {
                if (!e.target.value) return;
                onChange({ ...form, tagNames: [...form.tagNames, e.target.value] });
                e.target.value = "";
              }}
              className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-on-surface-secondary"
            >
              <option value="" disabled>
                + Add tag
              </option>
              {availableTags.map((tag) => (
                <option key={tag.id} value={tag.name}>
                  {tag.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface rounded-lg hover:bg-surface-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !form.name.trim() || !form.title.trim()}
          className="px-4 py-1.5 text-sm bg-accent-action text-on-accent-action rounded-lg hover:bg-accent-action-hover disabled:opacity-50 transition-colors"
        >
          {pending ? "Saving…" : isEdit ? "Update" : "Create"}
        </button>
      </div>
    </form>
  );
}
