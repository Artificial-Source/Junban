import { Inbox, CalendarDays, Clock, Menu, MessageCircle } from "lucide-react";
import type { View } from "../hooks/useRouting";

interface BottomNavBarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onMenuOpen: () => void;
  inboxCount: number;
  todayCount: number;
}

const LEFT_ITEMS = [
  { id: "inbox" as const, label: "Inbox", icon: Inbox, countKey: "inbox" as const },
  { id: "today" as const, label: "Today", icon: CalendarDays, countKey: "today" as const },
];

const RIGHT_ITEMS = [{ id: "upcoming" as const, label: "Upcoming", icon: Clock }];

export function BottomNavBar({
  currentView,
  onNavigate,
  onMenuOpen,
  inboxCount,
  todayCount,
}: BottomNavBarProps) {
  const counts: Record<string, number> = { inbox: inboxCount, today: todayCount };

  const renderNavItem = (item: {
    id: View;
    label: string;
    icon: typeof Inbox;
    countKey?: "inbox" | "today";
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
          isActive ? "text-accent-foreground" : "text-on-surface-muted"
        }`}
      >
        <span className="relative">
          <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
          {count !== undefined && count > 0 && (
            <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold bg-accent-action text-on-accent-action rounded-full">
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
            disabled
            aria-label="AI assistant (unavailable)"
            className={`-mt-5 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all active:scale-95 bg-accent-action text-on-accent-action shadow-accent-action/20 opacity-50 cursor-not-allowed`}
          >
            <MessageCircle size={22} />
          </button>
        </div>

        {RIGHT_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              disabled
              aria-label={`${item.label} (unavailable)`}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-on-surface-muted transition-colors opacity-50 cursor-not-allowed`}
            >
              <span className="relative">
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <span className="text-[10px] font-medium">{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={onMenuOpen}
          aria-label="Menu"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-on-surface-muted transition-colors"
        >
          <Menu size={20} strokeWidth={1.75} />
          <span className="text-[10px] font-medium">Menu</span>
        </button>
      </div>
    </nav>
  );
}
