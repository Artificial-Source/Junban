import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { parseQuery, type ParsedQuery } from "../../core/query-parser.js";

interface QueryBarProps {
  onQueryChange: (query: ParsedQuery | null) => void;
  placeholder?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const SUGGESTIONS = [
  "due today",
  "due this week",
  "due tomorrow",
  "overdue",
  "p1",
  "pending",
  "completed",
  "cancelled",
];

export function QueryBar({ onQueryChange, placeholder, value, onValueChange }: QueryBarProps) {
  const [internalValue, setInternalValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValue = value ?? internalValue;

  const updateValue = useCallback(
    (newValue: string) => {
      if (value !== undefined) {
        onValueChange?.(newValue);
        return;
      }
      setInternalValue(newValue);
    },
    [value, onValueChange],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!inputValue.trim()) {
        onQueryChange(null);
      } else {
        onQueryChange(parseQuery(inputValue));
      }
    }, 200);
  }, [inputValue, onQueryChange]);

  const handleClear = () => {
    updateValue("");
    inputRef.current?.focus();
  };

  const handleSuggestionClick = (suggestion: string) => {
    const newValue = inputValue ? `${inputValue.trim()} ${suggestion}` : suggestion;
    updateValue(newValue);
    setShowSuggestions(false);
    setActiveSuggestionIndex(-1);
    inputRef.current?.focus();
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const normalizedValue = inputValue.trim().toLowerCase();
  const filteredSuggestions = SUGGESTIONS.filter((suggestion) => {
    const normalizedSuggestion = suggestion.toLowerCase();

    if (!normalizedValue) return true;
    if (normalizedValue.includes(normalizedSuggestion)) return false;

    return normalizedSuggestion.includes(normalizedValue);
  });

  useEffect(() => {
    setActiveSuggestionIndex((prev) => {
      if (filteredSuggestions.length === 0) return -1;
      if (prev < 0) return -1;
      return Math.min(prev, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setShowSuggestions(true);
      setActiveSuggestionIndex((prev) => {
        if (filteredSuggestions.length === 0) return -1;
        if (prev < 0) return 0;
        return (prev + 1) % filteredSuggestions.length;
      });
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setShowSuggestions(true);
      setActiveSuggestionIndex((prev) => {
        if (filteredSuggestions.length === 0) return -1;
        if (prev < 0) return filteredSuggestions.length - 1;
        return (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length;
      });
      return;
    }

    if (event.key === "Enter" && showSuggestions && activeSuggestionIndex >= 0) {
      event.preventDefault();
      const suggestion = filteredSuggestions[activeSuggestionIndex];
      if (suggestion) handleSuggestionClick(suggestion);
      return;
    }

    if (event.key === "Escape") {
      setShowSuggestions(false);
      setActiveSuggestionIndex(-1);
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-muted">
          <Search size={16} />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => updateValue(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() =>
            setTimeout(() => {
              setShowSuggestions(false);
              setActiveSuggestionIndex(-1);
            }, 150)
          }
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Search or filter... (e.g., "due today p1 #urgent")'}
          className="w-full pl-9 pr-8 py-1.5 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-shadow"
        />
        {inputValue && (
          <button
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-muted hover:text-on-surface p-0.5"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 py-1 bg-surface border border-border rounded-lg shadow-lg z-10">
          <div className="px-2 py-1 text-xs text-on-surface-muted">Suggestions</div>
          {filteredSuggestions.map((s, index) => (
            <button
              key={s}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSuggestionClick(s)}
              onMouseEnter={() => setActiveSuggestionIndex(index)}
              className={`w-full text-left px-3 py-1.5 text-sm text-on-surface hover:bg-surface-secondary ${
                filteredSuggestions[activeSuggestionIndex] === s ? "bg-surface-secondary" : ""
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
