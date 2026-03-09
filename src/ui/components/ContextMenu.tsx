import { useEffect, useRef, useCallback, useState } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
  submenu?: ContextMenuItem[];
  /** When true, clicking this submenu item won't close the menu */
  keepOpen?: boolean;
  onClick?: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Viewport clamping — adjust position if menu overflows
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let { x, y } = position;
    if (y + rect.height > window.innerHeight) {
      y = Math.max(4, window.innerHeight - rect.height - 4);
    }
    if (x + rect.width > window.innerWidth) {
      x = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (x !== position.x || y !== position.y) {
      setAdjustedPosition({ x, y });
    }
  }, [position]);

  // Close on outside click, Escape, scroll
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const handleScroll = () => onClose();

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  // Focus first item
  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    buttons?.[0]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const enabledItems = items.filter((i) => !i.disabled);
      if (enabledItems.length === 0) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = (focusIndex + 1) % enabledItems.length;
          setFocusIndex(next);
          const buttons = menuRef.current?.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([aria-disabled="true"])',
          );
          buttons?.[next]?.focus();
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = (focusIndex - 1 + enabledItems.length) % enabledItems.length;
          setFocusIndex(prev);
          const buttons = menuRef.current?.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([aria-disabled="true"])',
          );
          buttons?.[prev]?.focus();
          break;
        }
        case "ArrowRight": {
          const item = enabledItems[focusIndex];
          if (item?.submenu) {
            e.preventDefault();
            setOpenSubmenu(item.id);
          }
          break;
        }
        case "ArrowLeft": {
          if (openSubmenu) {
            e.preventDefault();
            setOpenSubmenu(null);
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          const item = enabledItems[focusIndex];
          if (item?.submenu) {
            setOpenSubmenu(item.id);
          } else if (item?.onClick) {
            item.onClick();
            onClose();
          }
          break;
        }
      }
    },
    [items, focusIndex, openSubmenu, onClose],
  );

  // Ensure menu stays in viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: adjustedPosition.x,
    top: adjustedPosition.y,
    zIndex: 100,
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      className="min-w-[180px] py-1 bg-surface border border-border rounded-lg shadow-xl animate-scale-fade-in"
      style={style}
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => (
        <div key={item.id} className="relative">
          <button
            role="menuitem"
            aria-disabled={item.disabled}
            tabIndex={-1}
            onClick={() => {
              if (item.disabled) return;
              if (item.submenu) {
                setOpenSubmenu(openSubmenu === item.id ? null : item.id);
                return;
              }
              item.onClick?.();
              if (!item.keepOpen) onClose();
            }}
            onMouseEnter={() => {
              if (item.submenu) setOpenSubmenu(item.id);
              else setOpenSubmenu(null);
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
              item.disabled
                ? "text-on-surface-muted cursor-not-allowed"
                : item.danger
                  ? "text-error hover:bg-error/10"
                  : "text-on-surface hover:bg-surface-tertiary"
            }`}
          >
            {item.icon && <span className="w-4 flex-shrink-0">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="text-on-surface-muted text-xs ml-4 flex-shrink-0">
                {item.shortcut}
              </span>
            )}
            {item.submenu && <span className="text-on-surface-muted text-xs">&#9656;</span>}
          </button>
          {item.submenu && openSubmenu === item.id && (
            <div className="absolute left-full top-0 ml-0.5 min-w-[160px] py-1 bg-surface border border-border rounded-lg shadow-xl">
              {item.submenu.map((sub) => (
                <div key={sub.id}>
                  <button
                    role="menuitem"
                    aria-disabled={sub.disabled}
                    tabIndex={-1}
                    onClick={() => {
                      if (sub.disabled) return;
                      sub.onClick?.();
                      if (!sub.keepOpen) onClose();
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
                      sub.disabled
                        ? "text-on-surface-muted cursor-not-allowed"
                        : sub.danger
                          ? "text-error hover:bg-error/10"
                          : "text-on-surface hover:bg-surface-tertiary"
                    }`}
                  >
                    {sub.icon && <span className="w-4 flex-shrink-0">{sub.icon}</span>}
                    <span className="flex-1">{sub.label}</span>
                    {sub.shortcut && (
                      <span className="text-on-surface-muted text-xs ml-4 flex-shrink-0">
                        {sub.shortcut}
                      </span>
                    )}
                  </button>
                  {sub.separator && (
                    <div className="my-1 border-t border-border/50" role="separator" />
                  )}
                </div>
              ))}
            </div>
          )}
          {item.separator && <div className="my-1 border-t border-border/50" role="separator" />}
        </div>
      ))}
    </div>
  );
}
