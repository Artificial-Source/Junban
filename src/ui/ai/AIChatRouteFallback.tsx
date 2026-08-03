/**
 * Stable-dimension Suspense fallback for the AI chat route.
 * Keeps the main column filled so lazy resolution does not shift chrome.
 */
export function AIChatRouteFallback() {
  return (
    <div
      role="status"
      aria-label="Loading AI chat"
      className="flex h-full min-h-[20rem] w-full flex-1 flex-col items-center justify-center bg-surface"
    >
      <span className="sr-only">Loading AI chat…</span>
    </div>
  );
}
