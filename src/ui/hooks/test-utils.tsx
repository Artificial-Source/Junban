/**
 * Minimal renderHook utility for Vitest without @testing-library/react.
 */
import { createRoot } from "react-dom/client";
import { act } from "react";

export function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result: { current: T } = {} as { current: T };

  function TestComponent() {
    result.current = hook();
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<TestComponent />);
  });

  return { result };
}

export { act };
