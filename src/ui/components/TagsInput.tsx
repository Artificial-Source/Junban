import { useState, useRef, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { hexToRgba } from "../../utils/color.js";

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  tagColors?: Record<string, string>;
}

export function TagsInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add tag...",
  tagColors = {},
}: TagsInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = inputValue.trim()
    ? suggestions.filter(
        (s) => s.toLowerCase().includes(inputValue.toLowerCase()) && !value.includes(s),
      )
    : suggestions.filter((s) => !value.includes(s));

  // Close suggestions on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim().toLowerCase();
      if (trimmed && !value.includes(trimmed)) {
        onChange([...value, trimmed]);
      }
      setInputValue("");
      setHighlightIndex(-1);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(value.filter((t) => t !== tag));
    },
    [value, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filtered.length) {
        addTag(filtered[highlightIndex]);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeTag(value[value.length - 1]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setHighlightIndex(-1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, -1));
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap gap-1.5 items-center p-1.5 bg-surface-secondary border border-border rounded-md min-h-[34px]">
        {value.map((tag) => {
          const color = tagColors[tag];
          return (
            <span
              key={tag}
              className={`font-mono inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                color ? "" : "bg-surface-tertiary text-on-surface-secondary"
              }`}
              style={color ? { backgroundColor: hexToRgba(color, 0.15), color } : undefined}
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="opacity-60 hover:opacity-100 transition-opacity"
                aria-label={`Remove tag ${tag}`}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
            setHighlightIndex(-1);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[80px] text-sm bg-transparent border-none outline-none text-on-surface placeholder-on-surface-muted/50"
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-surface border border-border rounded-md shadow-lg max-h-32 overflow-auto">
          {filtered.slice(0, 10).map((suggestion, i) => (
            <button
              key={suggestion}
              onClick={() => addTag(suggestion)}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                i === highlightIndex
                  ? "bg-accent/10 text-accent"
                  : "text-on-surface-secondary hover:bg-surface-secondary"
              }`}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
