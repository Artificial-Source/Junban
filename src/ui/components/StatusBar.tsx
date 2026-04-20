import { useCallback } from "react";
import { usePluginContext } from "../context/PluginContext.js";
import { useDirectServices, BASE } from "../api/helpers.js";

interface StatusBarProps {
  mutationsBlocked?: boolean;
}

export function StatusBar({ mutationsBlocked = false }: StatusBarProps) {
  const { statusBarItems } = usePluginContext();
  const isDirect = useDirectServices();

  const handleClick = useCallback(
    (item: (typeof statusBarItems)[number]) => {
      if (mutationsBlocked) {
        return;
      }
      if (item.onClick) {
        // Direct services path — call the handler directly
        item.onClick();
        return;
      }
      if (!isDirect) {
        // REST path — fire-and-forget POST to trigger server-side onClick
        fetch(`${BASE}/plugins/ui/status-bar/${encodeURIComponent(item.id)}/click`, {
          method: "POST",
        }).catch(() => {
          // Non-critical
        });
      }
    },
    [isDirect, mutationsBlocked],
  );

  return (
    <div className="flex items-center gap-4 px-4 py-1 border-t border-border bg-surface-secondary text-xs text-on-surface-muted">
      {statusBarItems.length === 0 ? (
        <span className="opacity-0 select-none">&nbsp;</span>
      ) : (
        statusBarItems.map((item) => {
          const isClickable = !mutationsBlocked && (!!item.onClick || !isDirect);
          const baseClasses = "flex items-center gap-1";
          const clickableClasses = isClickable ? " cursor-pointer hover:text-on-surface" : "";
          const blockedClasses = mutationsBlocked ? " opacity-50" : "";
          return (
            <span
              key={item.id}
              className={`${baseClasses}${clickableClasses}${blockedClasses}`}
              onClick={isClickable ? () => handleClick(item) : undefined}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              aria-disabled={isClickable && mutationsBlocked ? "true" : undefined}
              onKeyDown={
                isClickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleClick(item);
                      }
                    }
                  : undefined
              }
            >
              <span>{item.icon}</span>
              <span>{item.text}</span>
            </span>
          );
        })
      )}
    </div>
  );
}
