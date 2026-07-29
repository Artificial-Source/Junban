import { useState, useRef, useId } from "react";
import { Plus } from "lucide-react";

interface TaskInputProps {
  onSubmit: (title: string) => Promise<boolean>;
  placeholder?: string;
  autoFocusTrigger?: number;
}

export function TaskInput({
  onSubmit,
  placeholder = 'Add a task... (e.g., "buy milk tomorrow p1 #groceries")',
  autoFocusTrigger,
}: TaskInputProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !value.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const success = await onSubmit(value.trim());
      if (success) {
        setValue("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  // Focus on mount if autoFocusTrigger is set
  if (autoFocusTrigger && autoFocusTrigger > 0 && inputRef.current && !submitting) {
    inputRef.current.focus();
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4" aria-busy={submitting || undefined}>
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">
          <Plus size={18} aria-hidden="true" />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          disabled={submitting}
          aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus focus:border-transparent transition-shadow"
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-error">
          {error}
        </p>
      )}
      {error && (
        <button
          type="button"
          onClick={() => void handleSubmit({ preventDefault: () => {} } as React.FormEvent)}
          disabled={submitting}
          className="mt-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-on-surface-secondary hover:bg-surface-secondary disabled:opacity-50"
        >
          Retry add
        </button>
      )}
    </form>
  );
}
