import { useState, useEffect, useRef } from "react";
import { X, Check, Smile, Palette, List, Columns3, Calendar } from "lucide-react";
import EmojiPicker, { Theme } from "emoji-picker-react";
import { DEFAULT_PROJECT_COLORS, PROJECT_COLOR_LABELS } from "../../config/defaults.js";
import type { Project } from "../../core/types.js";

const MAX_NAME_LENGTH = 120;
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

const VIEW_OPTIONS = [
  { value: "list" as const, label: "List", icon: List },
  { value: "board" as const, label: "Board", icon: Columns3, soon: true },
  { value: "calendar" as const, label: "Calendar", icon: Calendar, soon: true },
];

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  mode?: "create" | "edit";
  onSubmit: (
    name: string,
    color: string,
    icon: string,
    parentId: string | null,
    isFavorite: boolean,
    viewStyle: "list" | "board" | "calendar",
  ) => void;
  projects: Project[];
  initialProject?: Project | null;
  defaultParentId?: string | null;
}

export function AddProjectModal({
  open,
  onClose,
  mode = "create",
  onSubmit,
  projects,
  initialProject = null,
  defaultParentId = null,
}: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLORS[10]); // Blue default
  const [customHex, setCustomHex] = useState("");
  const [showCustomHex, setShowCustomHex] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);
  const [viewStyle, setViewStyle] = useState<"list" | "board" | "calendar">("list");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  const excludedParentIds = new Set<string>();
  if (initialProject) {
    excludedParentIds.add(initialProject.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const project of projects) {
        if (
          project.parentId &&
          excludedParentIds.has(project.parentId) &&
          !excludedParentIds.has(project.id)
        ) {
          excludedParentIds.add(project.id);
          changed = true;
        }
      }
    }
  }

  // Root-level, non-archived projects for parent dropdown
  const rootProjects = projects.filter(
    (p) => !p.archived && p.parentId === null && !excludedParentIds.has(p.id),
  );

  // Reset form + autofocus on open
  useEffect(() => {
    if (!open) return;

    const nextName = initialProject?.name ?? "";
    const nextEmoji = initialProject?.icon ?? "";
    const nextColor = initialProject?.color ?? DEFAULT_PROJECT_COLORS[10];
    const nextParentId = initialProject?.parentId ?? defaultParentId;
    const nextIsFavorite = initialProject?.isFavorite ?? false;
    const nextViewStyle = initialProject?.viewStyle ?? "list";
    const isCustomColor = !(DEFAULT_PROJECT_COLORS as readonly string[]).includes(nextColor);

    setName(nextName);
    setEmoji(nextEmoji);
    setColor(nextColor);
    setCustomHex(isCustomColor ? nextColor : "");
    setShowCustomHex(isCustomColor);
    setParentId(nextParentId);
    setIsFavorite(nextIsFavorite);
    setViewStyle(nextViewStyle);
    setEmojiPickerOpen(false);
    const timer = setTimeout(() => nameRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open, initialProject, defaultParentId]);

  // Keyboard: Escape closes
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (emojiPickerOpen) {
          setEmojiPickerOpen(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, emojiPickerOpen]);

  // Click outside emoji picker closes it
  useEffect(() => {
    if (!emojiPickerOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target as Node) &&
        emojiButtonRef.current &&
        !emojiButtonRef.current.contains(e.target as Node)
      ) {
        setEmojiPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [emojiPickerOpen]);

  if (!open) return null;

  const canSubmit = name.trim().length > 0;
  const title = mode === "edit" ? "Edit project" : "Add project";
  const submitLabel = mode === "edit" ? "Save" : "Add";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(name.trim(), color, emoji.trim(), parentId, isFavorite, viewStyle);
    onClose();
  };

  const isCustomColor = !(DEFAULT_PROJECT_COLORS as readonly string[]).includes(color);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-project-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface rounded-xl shadow-2xl max-w-md w-full mx-4 border border-border animate-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 id="add-project-title" className="text-base font-semibold text-on-surface">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-5">
          {/* Name + Emoji */}
          <div>
            <label
              htmlFor="project-name"
              className="block text-xs font-medium text-on-surface-secondary mb-1.5"
            >
              Name
            </label>
            <div className="relative flex items-center gap-2">
              {/* Emoji trigger */}
              <div className="relative">
                <button
                  ref={emojiButtonRef}
                  type="button"
                  onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
                  className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-surface hover:bg-surface-tertiary transition-colors text-lg"
                  title="Pick an emoji"
                >
                  {emoji ? (
                    <span>{emoji}</span>
                  ) : (
                    <Smile size={18} className="text-on-surface-muted" />
                  )}
                </button>
                {emojiPickerOpen && (
                  <div ref={emojiPickerRef} className="absolute top-12 left-0 z-50">
                    <EmojiPicker
                      theme={Theme.AUTO}
                      lazyLoadEmojis
                      width={320}
                      height={400}
                      onEmojiClick={(emojiData) => {
                        setEmoji(emojiData.emoji);
                        setEmojiPickerOpen(false);
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="relative flex-1">
                <input
                  ref={nameRef}
                  id="project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LENGTH))}
                  placeholder="My project"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-muted">
                  {name.length}/{MAX_NAME_LENGTH}
                </span>
              </div>
              {emoji && (
                <button
                  type="button"
                  onClick={() => setEmoji("")}
                  className="p-1 rounded text-on-surface-muted hover:text-on-surface-secondary transition-colors"
                  title="Clear emoji"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1.5">
              Color
            </label>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setColor(c);
                    setShowCustomHex(false);
                  }}
                  title={PROJECT_COLOR_LABELS[c] ?? c}
                  className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                    color === c
                      ? "ring-2 ring-offset-2 ring-offset-surface ring-on-surface-secondary scale-110"
                      : "hover:scale-110"
                  }`}
                  style={{ backgroundColor: c }}
                >
                  {color === c && <Check size={12} className="text-white drop-shadow-sm" />}
                </button>
              ))}
              {/* Custom color button */}
              <button
                type="button"
                onClick={() => setShowCustomHex(!showCustomHex)}
                title="Custom color"
                className={`w-7 h-7 rounded-full flex items-center justify-center border-2 border-dashed transition-all ${
                  isCustomColor
                    ? "ring-2 ring-offset-2 ring-offset-surface ring-on-surface-secondary scale-110 border-on-surface-secondary"
                    : "border-on-surface-muted hover:border-on-surface-secondary hover:scale-110"
                }`}
                style={isCustomColor ? { backgroundColor: color } : undefined}
              >
                {isCustomColor ? (
                  <Check size={12} className="text-white drop-shadow-sm" />
                ) : (
                  <Palette size={12} className="text-on-surface-muted" />
                )}
              </button>
            </div>
            {showCustomHex && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={customHex}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomHex(v);
                    if (HEX_REGEX.test(v)) {
                      setColor(v.toLowerCase());
                    }
                  }}
                  placeholder="#4073ff"
                  maxLength={7}
                  className={`w-28 px-2 py-1.5 text-sm font-mono border rounded-lg bg-surface text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 ${
                    customHex && !HEX_REGEX.test(customHex)
                      ? "border-error focus:ring-error"
                      : "border-border focus:ring-accent"
                  }`}
                />
                {customHex && HEX_REGEX.test(customHex) && (
                  <span
                    className="w-6 h-6 rounded-full border border-border"
                    style={{ backgroundColor: customHex }}
                  />
                )}
                {customHex && !HEX_REGEX.test(customHex) && (
                  <span className="text-xs text-error">Invalid hex</span>
                )}
              </div>
            )}
          </div>

          {/* Parent project */}
          <div>
            <label
              htmlFor="project-parent"
              className="block text-xs font-medium text-on-surface-secondary mb-1.5"
            >
              Parent project
            </label>
            <select
              id="project-parent"
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value || null)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface focus:outline-none focus:ring-2 focus:ring-accent appearance-none"
            >
              <option value="">None</option>
              {rootProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon ? `${p.icon} ` : "● "}
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Favorite toggle */}
          <div className="flex items-center justify-between">
            <label
              htmlFor="project-favorite"
              className="text-xs font-medium text-on-surface-secondary"
            >
              Add to favorites
            </label>
            <button
              id="project-favorite"
              type="button"
              role="switch"
              aria-checked={isFavorite}
              onClick={() => setIsFavorite(!isFavorite)}
              className={`relative w-10 h-5.5 rounded-full transition-colors ${
                isFavorite ? "bg-accent" : "bg-surface-tertiary"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform ${
                  isFavorite ? "translate-x-4.5" : ""
                }`}
              />
            </button>
          </div>

          {/* View style */}
          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1.5">
              View
            </label>
            <div className="flex rounded-lg border border-border overflow-hidden">
              {VIEW_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const isActive = viewStyle === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setViewStyle(opt.value)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors relative ${
                      isActive
                        ? "bg-accent/10 text-accent"
                        : "text-on-surface-secondary hover:bg-surface-tertiary"
                    }`}
                  >
                    <Icon size={14} />
                    {opt.label}
                    {opt.soon && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-surface-tertiary text-on-surface-muted leading-none">
                        soon
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
