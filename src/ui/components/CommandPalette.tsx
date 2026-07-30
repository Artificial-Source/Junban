/**
 * Command palette with combobox/listbox semantics and keyboard navigation.
 * Preserves the legacy dialog layout. Ships only working Phase 2 commands.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Search } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface Command {
  id: string;
  name: string;
  callback: () => void | Promise<void>;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, isOpen);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  const filtered = commands.filter((cmd) => cmd.name.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const selected = filtered[selectedIndex];
    if (!selected) return;
    listRef.current?.querySelector<HTMLElement>(`#cmd-${selected.id}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [isOpen, filtered, selectedIndex]);

  const handleSelect = useCallback(
    async (command: Command) => {
      try {
        await command.callback();
        onClose();
      } catch {
        // Error handled by caller
      }
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
          if (filtered[selectedIndex]) void handleSelect(filtered[selectedIndex]);
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
      className="fixed inset-0 z-50 flex items-start justify-center pt-8 md:pt-24 bg-black/50 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg mx-3 md:mx-0 bg-surface rounded-lg shadow-2xl overflow-hidden border border-border animate-scale-fade-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search size={16} className="text-on-surface-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command…"
            className="w-full py-3 bg-transparent text-on-surface placeholder-on-surface-muted focus:outline-none rounded-sm"
            role="combobox"
            aria-label="Filter commands"
            aria-autocomplete="list"
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
              onClick={() => void handleSelect(cmd)}
              className={`w-full text-left px-4 py-2 flex justify-between text-sm transition-colors cursor-pointer ${
                index === selectedIndex
                  ? "bg-accent-action/10 text-accent-foreground"
                  : "text-on-surface hover:bg-surface-secondary"
              }`}
            >
              <span>{cmd.name}</span>
              {cmd.hotkey && (
                <kbd className="text-xs text-on-surface-muted bg-surface-tertiary px-1.5 py-0.5 rounded">
                  {cmd.hotkey}
                </kbd>
              )}
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-4 py-2 text-sm text-on-surface-muted">No matching commands.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
