import { useState, useEffect, useCallback, useRef } from "react";
import { Search } from "lucide-react";

interface Command {
  id: string;
  name: string;
  callback: () => void;
  hotkey?: string;
}

interface CommandPaletteProps {
  commands: Command[];
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ commands, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const filtered = commands.filter((cmd) => cmd.name.toLowerCase().includes(query.toLowerCase()));

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const selected = filtered[selectedIndex];
    if (!selected) return;

    const element = listRef.current?.querySelector<HTMLLIElement>(`#cmd-${selected.id}`);
    element?.scrollIntoView({ block: "nearest" });
  }, [isOpen, filtered, selectedIndex]);

  const handleSelect = useCallback(
    (command: Command) => {
      command.callback();
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            handleSelect(filtered[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, handleSelect, onClose],
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-surface rounded-xl shadow-2xl overflow-hidden border border-border"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search size={16} className="text-on-surface-muted flex-shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            className="w-full py-3 bg-transparent text-on-surface placeholder-on-surface-muted focus:outline-none"
            autoFocus
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-controls="command-palette-list"
            aria-activedescendant={
              filtered[selectedIndex] ? `cmd-${filtered[selectedIndex].id}` : undefined
            }
          />
        </div>
        <ul
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Commands"
          className="max-h-64 overflow-auto py-1"
        >
          {filtered.map((cmd, index) => (
            <li
              key={cmd.id}
              id={`cmd-${cmd.id}`}
              role="option"
              aria-selected={index === selectedIndex}
            >
              <button
                onClick={() => handleSelect(cmd)}
                tabIndex={-1}
                className={`w-full text-left px-4 py-2 flex justify-between text-sm transition-colors ${
                  index === selectedIndex
                    ? "bg-accent/10 text-accent"
                    : "text-on-surface hover:bg-surface-secondary"
                }`}
              >
                <span>{cmd.name}</span>
                {cmd.hotkey && (
                  <kbd className="text-xs text-on-surface-muted bg-surface-tertiary px-1.5 py-0.5 rounded">
                    {cmd.hotkey}
                  </kbd>
                )}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-2 text-sm text-on-surface-muted">No matching commands</li>
          )}
        </ul>
      </div>
    </div>
  );
}
