/**
 * Settings modal shell — legacy desktop tab rail + mobile category index/detail.
 * Exact Phase 4 tabs: Essentials, Appearance, Features, Keyboard, Templates,
 * Data, Hosted, Diagnostics. AI/Voice/Extensions/About stay hidden.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  Database,
  FileText,
  Keyboard,
  Palette,
  Server,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { SettingsTabId } from "../../hooks/useRouting";
import { AppearanceTab } from "./AppearanceTab";
import { DataTab } from "./DataTab";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { EssentialsTab } from "./EssentialsTab";
import { FeaturesTab } from "./FeaturesTab";
import { HostedTab } from "./HostedTab";
import { KeyboardTab } from "./KeyboardTab";
import { MOBILE_SETTINGS_SECTIONS, SETTINGS_TAB_META } from "./settingsHelpers";
import { TemplatesTab } from "./TemplatesTab";

type TabMeta = {
  id: SettingsTabId;
  label: string;
  subtitle: string;
  icon: ReactNode;
  mobileIcon: ReactNode;
};

const TABS: TabMeta[] = SETTINGS_TAB_META.map((meta) => {
  const iconProps = { className: "h-4 w-4", "aria-hidden": true as const };
  const mobileIconProps = { className: "h-5 w-5", "aria-hidden": true as const };
  switch (meta.id) {
    case "essentials":
      return {
        ...meta,
        icon: <SlidersHorizontal {...iconProps} />,
        mobileIcon: <SlidersHorizontal {...mobileIconProps} />,
      };
    case "appearance":
      return {
        ...meta,
        icon: <Palette {...iconProps} />,
        mobileIcon: <Palette {...mobileIconProps} />,
      };
    case "features":
      return {
        ...meta,
        icon: <Sparkles {...iconProps} />,
        mobileIcon: <Sparkles {...mobileIconProps} />,
      };
    case "keyboard":
      return {
        ...meta,
        icon: <Keyboard {...iconProps} />,
        mobileIcon: <Keyboard {...mobileIconProps} />,
      };
    case "templates":
      return {
        ...meta,
        icon: <FileText {...iconProps} />,
        mobileIcon: <FileText {...mobileIconProps} />,
      };
    case "data":
      return {
        ...meta,
        icon: <Database {...iconProps} />,
        mobileIcon: <Database {...mobileIconProps} />,
      };
    case "hosted":
      return {
        ...meta,
        icon: <Server {...iconProps} />,
        mobileIcon: <Server {...mobileIconProps} />,
      };
    case "diagnostics":
      return {
        ...meta,
        icon: <Activity {...iconProps} />,
        mobileIcon: <Activity {...mobileIconProps} />,
      };
  }
});

function renderTabContent(tab: SettingsTabId): ReactNode {
  const errorFallback = (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-error">
      Failed to load this settings tab. Refresh and try again.
    </div>
  );
  const wrap = (content: ReactNode) => (
    <ErrorBoundary fallback={errorFallback}>{content}</ErrorBoundary>
  );

  switch (tab) {
    case "essentials":
      return wrap(<EssentialsTab />);
    case "appearance":
      return wrap(<AppearanceTab />);
    case "features":
      return wrap(<FeaturesTab />);
    case "keyboard":
      return wrap(<KeyboardTab />);
    case "templates":
      return wrap(<TemplatesTab />);
    case "data":
      return wrap(<DataTab />);
    case "hosted":
      return wrap(<HostedTab />);
    case "diagnostics":
      return wrap(<DiagnosticsTab />);
  }
}

export function SettingsDialog({
  tab,
  onNavigateTab,
  onClose,
  returnFocusTarget,
}: {
  /** null = mobile category index; desktop treats null as Essentials. */
  tab: SettingsTabId | null;
  onNavigateTab: (tab: SettingsTabId | null) => void;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const isMobile = useIsMobile();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mobileBackButtonRef = useRef<HTMLButtonElement>(null);
  const mobileOriginTabRef = useRef<SettingsTabId | null>(null);
  const [mobileAnnouncement, setMobileAnnouncement] = useState(() => {
    if (!isMobile || !tab) return "";
    const meta = TABS.find((item) => item.id === tab);
    return meta ? `${meta.label} settings opened` : "";
  });

  const desktopTab: SettingsTabId = tab ?? "essentials";
  const mobileSelectedTab = isMobile ? tab : desktopTab;
  const mobileTabMeta = mobileSelectedTab
    ? TABS.find((item) => item.id === mobileSelectedTab)
    : null;
  const titleId = "settings-dialog-title";

  useEffect(() => {
    if (!isMobile) return;
    if (mobileSelectedTab !== null) {
      mobileBackButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    const originTab = mobileOriginTabRef.current;
    if (!originTab) return;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(`[data-settings-mobile-tab="${originTab}"]`)
      ?.focus({ preventScroll: true });
    mobileOriginTabRef.current = null;
  }, [isMobile, mobileSelectedTab]);

  // Shell isolation: inert background siblings while Settings owns interaction.
  useEffect(() => {
    const backdrop = backdropRef.current;
    const parent = backdrop?.parentElement;
    if (!backdrop || !parent) return;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const backgroundElements = Array.from(parent.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
    );
    const previousState = backgroundElements.map((element) => {
      const ariaHidden = element.getAttribute("aria-hidden");
      return {
        element,
        inert: element.inert,
        ariaHidden,
        changedAriaHidden: ariaHidden !== "true",
      };
    });

    for (const { element, changedAriaHidden } of previousState) {
      element.inert = true;
      if (changedAriaHidden) element.setAttribute("aria-hidden", "true");
    }

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      for (const { element, inert, ariaHidden, changedAriaHidden } of previousState) {
        element.inert = inert;
        if (!changedAriaHidden) continue;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
    };
  }, []);

  useFocusTrap(dialogRef, true, returnFocusTarget);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Nested dialogs (ConfirmDialog) own Escape while present.
      const nestedDialog = dialogRef.current?.querySelector(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
      );
      if (nestedDialog) return;
      event.preventDefault();
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const handleMobileTabChange = (next: TabMeta) => {
    mobileOriginTabRef.current = next.id;
    setMobileAnnouncement(`${next.label} settings opened`);
    onNavigateTab(next.id);
  };

  const handleMobileBack = () => {
    setMobileAnnouncement("Settings categories opened");
    onNavigateTab(null);
  };

  return (
    <div
      ref={backdropRef}
      data-testid="settings-backdrop"
      className={`fixed inset-0 z-50 flex bg-black/50 ${
        isMobile ? "items-stretch justify-stretch" : "items-center justify-center"
      }`}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        data-testid="settings-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={
          isMobile
            ? "flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden bg-surface"
            : "flex h-[85vh] max-h-[800px] w-[90vw] max-w-[960px] flex-row overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        }
      >
        {isMobile && (
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {mobileAnnouncement}
          </div>
        )}

        {isMobile ? (
          mobileSelectedTab !== null ? (
            <>
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-3">
                <button
                  ref={mobileBackButtonRef}
                  type="button"
                  data-autofocus
                  onClick={handleMobileBack}
                  aria-label="Back to settings"
                  className="-ml-1.5 rounded-md p-2.5 text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface"
                >
                  <ArrowLeft aria-hidden="true" className="h-5 w-5" />
                </button>
                <h2 id={titleId} className="text-lg font-bold text-on-surface">
                  {mobileTabMeta?.label ?? "Settings"}
                </h2>
              </div>
              <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto p-4">
                {renderTabContent(mobileSelectedTab)}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-3">
                <button
                  type="button"
                  data-autofocus
                  onClick={onClose}
                  aria-label="Close settings"
                  className="-ml-1.5 rounded-md p-2.5 text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface"
                >
                  <ArrowLeft aria-hidden="true" className="h-5 w-5" />
                </button>
                <h2 id={titleId} className="text-lg font-bold text-on-surface">
                  Settings
                </h2>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {MOBILE_SETTINGS_SECTIONS.map((section) => (
                  <section key={section.label}>
                    <h3 className="px-5 pt-5 pb-2 text-xs font-semibold tracking-wider text-on-surface-secondary uppercase">
                      {section.label}
                    </h3>
                    {section.tabs.map((tabId) => {
                      const item = TABS.find((candidate) => candidate.id === tabId)!;
                      return (
                        <button
                          type="button"
                          key={item.id}
                          data-settings-mobile-tab={item.id}
                          onClick={() => handleMobileTabChange(item)}
                          aria-labelledby={`settings-mobile-tab-${item.id}`}
                          aria-describedby={`settings-mobile-tab-${item.id}-description`}
                          className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-surface-secondary active:bg-surface-tertiary"
                        >
                          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-surface-tertiary text-on-surface-secondary">
                            {item.mobileIcon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              id={`settings-mobile-tab-${item.id}`}
                              className="block text-sm font-medium text-on-surface"
                            >
                              {item.label}
                            </span>
                            <span
                              id={`settings-mobile-tab-${item.id}-description`}
                              className="mt-0.5 block text-xs text-on-surface-muted"
                            >
                              {item.subtitle}
                            </span>
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="h-4 w-4 flex-shrink-0 text-on-surface-muted"
                          />
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
            </>
          )
        ) : (
          <>
            <div className="flex w-60 flex-shrink-0 flex-col border-r border-border bg-surface-secondary p-4">
              <h2 id={titleId} className="mb-4 px-2 text-lg font-bold text-on-surface">
                Settings
              </h2>
              <nav aria-label="Settings tabs" className="flex-1">
                <ul className="space-y-0.5">
                  {TABS.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onNavigateTab(item.id)}
                        aria-current={desktopTab === item.id ? "page" : undefined}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                          desktopTab === item.id
                            ? "border-accent-action bg-surface-tertiary border-l-2 font-medium text-on-surface"
                            : "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface"
                        }`}
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border px-6 py-4">
                <h3 className="text-base font-semibold text-on-surface">
                  {TABS.find((item) => item.id === desktopTab)?.label ?? "Settings"}
                </h3>
                <button
                  type="button"
                  data-autofocus
                  onClick={onClose}
                  aria-label="Close settings"
                  className="rounded-md p-1.5 text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface"
                >
                  <X aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
              <div data-testid="settings-content" className="min-h-0 flex-1 overflow-y-auto p-6">
                {renderTabContent(desktopTab)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
