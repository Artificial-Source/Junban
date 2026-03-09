import { describe, it, expect } from "vitest";
import {
  fadeIn,
  fadeOut,
  slideInRight,
  slideInLeft,
  slideOutLeft,
  scaleIn,
  scaleOut,
  listItem,
  checkmark,
  subtlePulse,
  crossfade,
  backdrop,
  burstParticle,
  staggerContainer,
  springSnappy,
  springGentle,
  springBouncy,
} from "../../../src/ui/utils/animation-variants.js";
import type { Variants, Transition } from "framer-motion";

/** Extract the numeric duration from a variant's transition, if present. */
function getDuration(variant: Variants, state: string): number | undefined {
  const v = variant[state];
  if (typeof v === "object" && v !== null && "transition" in v) {
    const t = v.transition as Transition & { duration?: number };
    if (typeof t === "object" && "duration" in t) {
      return t.duration as number;
    }
  }
  return undefined;
}

describe("animation-variants", () => {
  describe("variant structure", () => {
    it.each([
      ["fadeIn", fadeIn],
      ["fadeOut", fadeOut],
      ["slideInRight", slideInRight],
      ["slideInLeft", slideInLeft],
      ["slideOutLeft", slideOutLeft],
      ["scaleIn", scaleIn],
      ["scaleOut", scaleOut],
      ["listItem", listItem],
      ["crossfade", crossfade],
      ["backdrop", backdrop],
    ] as [string, Variants][])("%s has initial, animate, and exit states", (_name, variant) => {
      expect(variant).toHaveProperty("initial");
      expect(variant).toHaveProperty("animate");
      expect(variant).toHaveProperty("exit");
    });

    it("checkmark has initial and animate states", () => {
      expect(checkmark).toHaveProperty("initial");
      expect(checkmark).toHaveProperty("animate");
    });

    it("subtlePulse has animate state with repeat", () => {
      expect(subtlePulse).toHaveProperty("animate");
      const anim = subtlePulse.animate as Record<string, unknown>;
      expect(anim.transition).toBeDefined();
      const t = anim.transition as Record<string, unknown>;
      expect(t.repeat).toBe(Infinity);
    });

    it("staggerContainer has staggerChildren in animate", () => {
      const anim = staggerContainer.animate as Record<string, unknown>;
      const t = anim.transition as Record<string, unknown>;
      expect(t.staggerChildren).toBe(0.03);
    });

    it("burstParticle has initial and animate function", () => {
      expect(burstParticle).toHaveProperty("initial");
      expect(burstParticle).toHaveProperty("animate");
      // animate is a custom function (dynamic variant)
      expect(typeof burstParticle.animate).toBe("function");
    });
  });

  describe("durations under 300ms", () => {
    it("fadeIn animate duration < 300ms", () => {
      const d = getDuration(fadeIn, "animate");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("fadeIn exit duration < 300ms", () => {
      const d = getDuration(fadeIn, "exit");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("crossfade animate duration < 300ms", () => {
      const d = getDuration(crossfade, "animate");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("crossfade exit duration < 300ms", () => {
      const d = getDuration(crossfade, "exit");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("backdrop animate duration < 300ms", () => {
      const d = getDuration(backdrop, "animate");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("listItem exit duration < 300ms", () => {
      const d = getDuration(listItem, "exit");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("scaleIn exit duration < 300ms", () => {
      const d = getDuration(scaleIn, "exit");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });

    it("slideInRight exit duration < 300ms", () => {
      const d = getDuration(slideInRight, "exit");
      expect(d).toBeDefined();
      expect(d!).toBeLessThanOrEqual(0.3);
    });
  });

  describe("spring presets", () => {
    it("springSnappy uses spring type", () => {
      const t = springSnappy as Record<string, unknown>;
      expect(t.type).toBe("spring");
      expect(t.stiffness).toBeDefined();
      expect(t.damping).toBeDefined();
    });

    it("springGentle uses spring type", () => {
      const t = springGentle as Record<string, unknown>;
      expect(t.type).toBe("spring");
    });

    it("springBouncy uses spring type with lower damping", () => {
      const t = springBouncy as Record<string, unknown>;
      expect(t.type).toBe("spring");
      expect((t.damping as number)).toBeLessThan((springSnappy as Record<string, unknown>).damping as number);
    });
  });
});
