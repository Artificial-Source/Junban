import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { motion } from "framer-motion";

// Mock SettingsContext before importing AnimatedPresence
let mockReduceAnimations = "false";
vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { reduce_animations: mockReduceAnimations },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

import { AnimatedPresence } from "../../../src/ui/components/AnimatedPresence.js";
import { useReducedMotion } from "../../../src/ui/components/useReducedMotion.js";

/** Simple test component that uses the hook directly */
function ReducedMotionIndicator() {
  const reduced = useReducedMotion();
  return <span data-testid="reduced">{reduced ? "yes" : "no"}</span>;
}

describe("AnimatedPresence", () => {
  beforeEach(() => {
    mockReduceAnimations = "false";
  });

  it("renders children", () => {
    render(
      <AnimatedPresence>
        <div>Hello</div>
      </AnimatedPresence>,
    );
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders when reduce_animations is true", () => {
    mockReduceAnimations = "true";
    render(
      <AnimatedPresence>
        <div>Still here</div>
      </AnimatedPresence>,
    );
    expect(screen.getByText("Still here")).toBeInTheDocument();
  });

  it("supports mode prop", () => {
    render(
      <AnimatedPresence mode="wait">
        <motion.div key="a">Content</motion.div>
      </AnimatedPresence>,
    );
    expect(screen.getByText("Content")).toBeInTheDocument();
  });
});

describe("useReducedMotion", () => {
  beforeEach(() => {
    mockReduceAnimations = "false";
  });

  it("returns false when reduce_animations setting is false and no OS preference", () => {
    render(<ReducedMotionIndicator />);
    expect(screen.getByTestId("reduced").textContent).toBe("no");
  });

  it("returns true when reduce_animations setting is true", () => {
    mockReduceAnimations = "true";
    render(<ReducedMotionIndicator />);
    expect(screen.getByTestId("reduced").textContent).toBe("yes");
  });
});
