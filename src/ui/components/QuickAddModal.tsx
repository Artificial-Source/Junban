/**
 * Quick Add modal with template selector and quick-entry parsing.
 * Preserves the legacy dialog layout and Escape/close semantics.
 * Templates with `{{variables}}` collect values in-modal before apply.
 */
import { useEffect, useRef, useCallback, useState, useId, useMemo } from "react";
import { X } from "lucide-react";
import { TaskInput } from "./TaskInput";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useWorkspace } from "../context/WorkspaceContext";
import { extractTemplateVariables } from "../lib/templateVariables";
import type { TemplateDto } from "../api/client";

interface QuickAddModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional path to Settings → Templates when none exist yet. */
  onManageTemplates?: () => void;
}

export function QuickAddModal({ open, onClose, onManageTemplates }: QuickAddModalProps) {
  const { catalog } = useWorkspace();
  const { parseQuickEntry, createFromQuickEntry, applyTemplate } = useTaskMutations();
  const [submitting, setSubmitting] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<TemplateDto | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [variableError, setVariableError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const variableFormId = useId();
  useFocusTrap(dialogRef, open);

  const templates = catalog?.templates ?? [];
  const pendingVariables = useMemo(
    () =>
      pendingTemplate
        ? extractTemplateVariables(pendingTemplate.title, pendingTemplate.description)
        : [],
    [pendingTemplate],
  );

  const resetVariableState = useCallback(() => {
    setPendingTemplate(null);
    setVariableValues({});
    setVariableError(null);
  }, []);

  // Reset transient UI when the modal closes.
  useEffect(() => {
    if (!open) {
      setShowTemplates(false);
      resetVariableState();
      setSubmitting(false);
    }
  }, [open, resetVariableState]);

  const handleParseAndCreate = useCallback(
    async (input: string): Promise<boolean> => {
      setSubmitting(true);
      try {
        const parsed = await parseQuickEntry(input);
        const result = await createFromQuickEntry(parsed);
        if (!result) {
          throw new Error("The task could not be created.");
        }
        onClose();
        return true;
      } finally {
        setSubmitting(false);
      }
    },
    [parseQuickEntry, createFromQuickEntry, onClose],
  );

  const commitTemplate = useCallback(
    async (template: TemplateDto, variables: Array<{ name: string; value: string }>) => {
      setSubmitting(true);
      setVariableError(null);
      try {
        const result = await applyTemplate(template.id, variables);
        if (!result) {
          setVariableError("Could not apply template.");
          return;
        }
        resetVariableState();
        onClose();
      } catch (err) {
        setVariableError(err instanceof Error ? err.message : "Could not apply template.");
      } finally {
        setSubmitting(false);
      }
    },
    [applyTemplate, onClose, resetVariableState],
  );

  const handleSelectTemplate = useCallback(
    (template: TemplateDto) => {
      const names = extractTemplateVariables(template.title, template.description);
      if (names.length === 0) {
        void commitTemplate(template, []);
        return;
      }
      setPendingTemplate(template);
      setVariableValues(Object.fromEntries(names.map((name) => [name, ""])));
      setVariableError(null);
    },
    [commitTemplate],
  );

  const handleApplyVariables = useCallback(() => {
    if (!pendingTemplate) return;
    const missing = pendingVariables.filter((name) => !variableValues[name]?.trim());
    if (missing.length > 0) {
      setVariableError("Fill in every template variable.");
      return;
    }
    void commitTemplate(
      pendingTemplate,
      pendingVariables.map((name) => ({ name, value: variableValues[name].trim() })),
    );
  }, [pendingTemplate, pendingVariables, variableValues, commitTemplate]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || submitting) return;
      if (pendingTemplate) {
        resetVariableState();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, submitting, pendingTemplate, resetVariableState]);

  if (!open) return null;

  const variablesComplete =
    pendingVariables.length > 0 &&
    pendingVariables.every((name) => (variableValues[name] ?? "").trim().length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        className="w-full max-w-lg mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in"
        aria-busy={submitting || undefined}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span
            id="quick-add-title"
            className="text-xs font-medium text-on-surface-muted uppercase tracking-wider"
          >
            Quick Add
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowTemplates((v) => !v);
                if (showTemplates) resetVariableState();
              }}
              disabled={submitting}
              aria-expanded={showTemplates}
              className="text-xs text-accent-foreground hover:underline"
            >
              Templates
            </button>
            <button
              onClick={onClose}
              disabled={submitting}
              aria-label="Close quick add"
              className="p-1 text-on-surface-muted hover:text-on-surface rounded-md hover:bg-surface-tertiary transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="px-4 pb-4">
          <TaskInput
            onParseAndCreate={handleParseAndCreate}
            placeholder='Add a task... (e.g., "buy milk tomorrow p1 #groceries")'
            autoFocus
          />
          {showTemplates && (
            <div className="mt-2 rounded-lg border border-border bg-surface-secondary p-2">
              <p className="text-xs font-semibold text-on-surface-muted uppercase tracking-wider mb-2">
                Templates
              </p>
              {pendingTemplate ? (
                <div className="space-y-3 px-1 py-1">
                  <div>
                    <p className="text-sm font-medium text-on-surface">{pendingTemplate.name}</p>
                    <p className="text-xs text-on-surface-muted truncate">
                      {pendingTemplate.title}
                    </p>
                  </div>
                  <form
                    id={variableFormId}
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleApplyVariables();
                    }}
                  >
                    {pendingVariables.map((name) => {
                      const fieldId = `${variableFormId}-${name}`;
                      return (
                        <div key={name} className="space-y-1">
                          <label
                            htmlFor={fieldId}
                            className="block text-xs font-medium text-on-surface-secondary"
                          >
                            {name}
                          </label>
                          <input
                            id={fieldId}
                            name={name}
                            type="text"
                            required
                            autoComplete="off"
                            value={variableValues[name] ?? ""}
                            disabled={submitting}
                            onChange={(e) => {
                              setVariableValues((prev) => ({ ...prev, [name]: e.target.value }));
                              if (variableError) setVariableError(null);
                            }}
                            className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
                          />
                        </div>
                      );
                    })}
                  </form>
                  {variableError && (
                    <p role="alert" className="text-xs text-error">
                      {variableError}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={resetVariableState}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary hover:bg-surface disabled:opacity-50"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      form={variableFormId}
                      disabled={submitting || !variablesComplete}
                      className="rounded-md bg-accent-action px-2.5 py-1 text-xs font-medium text-on-accent-action disabled:opacity-50"
                    >
                      Create task
                    </button>
                  </div>
                </div>
              ) : templates.length === 0 ? (
                <div className="px-2 py-2 text-sm text-on-surface-muted">
                  <p>No templates yet.</p>
                  {onManageTemplates && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onManageTemplates();
                      }}
                      className="mt-1 text-xs text-accent-foreground hover:underline"
                    >
                      Manage templates in Settings
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => handleSelectTemplate(template)}
                      disabled={submitting}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-on-surface hover:bg-surface-tertiary disabled:opacity-50"
                    >
                      <span className="flex-1">{template.name}</span>
                      <span className="text-xs text-on-surface-muted truncate">
                        {template.title}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
