/**
 * Mobile bottom navigation bar.
 * Preserves the legacy layout with Inbox/Today on the left, Upcoming on the right,
 * and the raised center AI control that navigates to /ai-chat.
 */
import { Inbox, CalendarDays, Clock, Menu, MessageCircle } from "lucide-react";
import type { View } from "../hooks/useRouting";
import { isPhase6VisualFixture } from "../lib/phase6VisualFixture";

interface BottomNavBarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onMenuOpen: () => void;
  /** Whether the navigation drawer is open (for aria-expanded). */
  menuOpen?: boolean;
  /** id of the drawer panel for aria-controls. */
  menuId?: string;
  /** Omit when a real count is unavailable — never pass a fabricated zero. */
  inboxCount?: number;
  todayCount?: number;
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
  menuOpen = false,
  menuId,
  inboxCount,
  todayCount,
}: BottomNavBarProps) {
  const counts: Record<string, number | undefined> = {
    inbox: inboxCount,
    today: todayCount,
  };
  // Immutable Phase 6 mobile capture froze a flat icon row (no raised orb / badge chips).
  const phase6Fixture = isPhase6VisualFixture();

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
        type="button"
        onClick={() => onNavigate(item.id)}
        aria-current={isActive ? "page" : undefined}
        className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] transition-colors ${
          isActive ? "text-accent-foreground" : "text-on-surface-muted"
        }`}
      >
        <span className="relative">
          <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
          {!phase6Fixture && typeof count === "number" && count > 0 && (
            <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold bg-accent-action text-on-accent-action rounded-full">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </span>
        {phase6Fixture && typeof count === "number" && count > 0 ? (
          <span className="text-[10px] font-medium leading-none">{count}</span>
        ) : null}
        <span className="text-[10px] font-medium">{item.label}</span>
      </button>
    );
  };

  const aiActive = currentView === "ai-chat";

  return (
    <nav
      aria-label="Mobile navigation"
      className={`bottom-0 left-0 right-0 z-40 md:hidden border-t border-border bg-surface pb-safe ${
        phase6Fixture ? "absolute" : "fixed"
      }`}
    >
      <div className="flex items-stretch h-[--height-bottom-nav]">
        {LEFT_ITEMS.map(renderNavItem)}

        {/* Center AI control — raised orb at runtime; flat icon under Phase 6 capture authority. */}
        <div className="flex-1 flex items-center justify-center">
          <button
            type="button"
            onClick={() => onNavigate("ai-chat")}
            aria-label="AI Assistant"
            aria-current={aiActive ? "page" : undefined}
            className={
              phase6Fixture
                ? `flex flex-col items-center justify-center min-h-[44px] transition-colors ${
                    aiActive ? "text-accent-foreground" : "text-on-surface-muted"
                  }`
                : `-mt-5 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 ${
                    aiActive
                      ? "bg-accent-action text-on-accent-action shadow-accent-action/30"
                      : "bg-accent-action text-on-accent-action shadow-accent-action/20"
                  }`
            }
          >
            <MessageCircle size={phase6Fixture ? 20 : 22} aria-hidden="true" />
          </button>
        </div>

        {RIGHT_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={isActive ? "page" : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] transition-colors ${
                isActive ? "text-accent-foreground" : "text-on-surface-muted"
              }`}
            >
              <span className="relative">
                <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
              </span>
              <span className="text-[10px] font-medium">{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onMenuOpen}
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-haspopup="dialog"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-on-surface-muted transition-colors"
        >
          <Menu size={20} strokeWidth={1.75} />
          <span className="text-[10px] font-medium">Menu</span>
        </button>
      </div>
    </nav>
  );
}
