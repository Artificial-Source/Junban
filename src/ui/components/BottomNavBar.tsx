import { useRef, useCallback } from "react";
import { Inbox, CalendarDays, Clock, Menu, Mic } from "lucide-react";

interface BottomNavBarProps {
  currentView: string;
  onNavigate: (view: string) => void;
  onMenuOpen: () => void;
  onOpenChat: () => void;
  onOpenVoice: () => void;
  chatOpen?: boolean;
  inboxCount?: number;
  todayCount?: number;
}

const LEFT_ITEMS = [
  { id: "inbox", label: "Inbox", icon: Inbox, countKey: "inbox" as const },
  { id: "today", label: "Today", icon: CalendarDays, countKey: "today" as const },
] as const;

const RIGHT_ITEMS = [{ id: "upcoming", label: "Upcoming", icon: Clock, countKey: null }] as const;

const LONG_PRESS_MS = 400;

export function BottomNavBar({
  currentView,
  onNavigate,
  onMenuOpen,
  onOpenChat,
  onOpenVoice,
  chatOpen,
  inboxCount,
  todayCount,
}: BottomNavBarProps) {
  const counts: Record<string, number | undefined> = { inbox: inboxCount, today: todayCount };
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const handlePointerDown = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      onOpenVoice();
    }, LONG_PRESS_MS);
  }, [onOpenVoice]);

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (!didLongPress.current) {
      onOpenChat();
    }
  }, [onOpenChat]);

  const handlePointerCancel = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const renderNavItem = (item: {
    id: string;
    label: string;
    icon: typeof Inbox;
    countKey: "inbox" | "today" | null;
  }) => {
    const Icon = item.icon;
    const isActive = currentView === item.id;
    const count = item.countKey ? counts[item.countKey] : undefined;
    return (
      <button
        key={item.id}
        onClick={() => onNavigate(item.id)}
        aria-current={isActive ? "page" : undefined}
        className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] transition-colors ${
          isActive ? "text-accent" : "text-on-surface-muted"
        }`}
      >
        <span className="relative">
          <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
          {count !== undefined && count > 0 && (
            <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold bg-accent text-white rounded-full">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </span>
        <span className="text-[10px] font-medium">{item.label}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-border bg-surface pb-safe"
    >
      <div className="flex items-stretch h-[--height-bottom-nav]">
        {LEFT_ITEMS.map(renderNavItem)}

        {/* Center AI button — raised accent orb */}
        <div className="flex-1 flex items-center justify-center">
          <button
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            aria-label="AI assistant — hold for voice"
            className={`-mt-5 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all active:scale-95 ${
              chatOpen
                ? "bg-accent text-white shadow-accent/30"
                : "bg-accent text-white shadow-accent/20"
            }`}
          >
            <Mic size={22} />
          </button>
        </div>

        {RIGHT_ITEMS.map(renderNavItem)}
        <button
          onClick={onMenuOpen}
          aria-label="Open menu"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-on-surface-muted transition-colors"
        >
          <Menu size={20} strokeWidth={1.75} />
          <span className="text-[10px] font-medium">Menu</span>
        </button>
      </div>
    </nav>
  );
}
