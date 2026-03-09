/**
 * Framer Motion animation variants and spring presets.
 * All durations are kept under 300ms for snappy, non-distracting animations.
 */
import type { Variants, Transition } from "framer-motion";

// ── Spring Presets ───────────────────────────────────────────

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.8,
};

export const springGentle: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 25,
  mass: 1,
};

export const springBouncy: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 15,
  mass: 0.8,
};

// ── Fade ─────────────────────────────────────────────────────

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

export const fadeOut: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// ── Slides ───────────────────────────────────────────────────

export const slideInRight: Variants = {
  initial: { x: 24, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: springSnappy },
  exit: { x: 24, opacity: 0, transition: { duration: 0.15 } },
};

export const slideInLeft: Variants = {
  initial: { x: -24, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: springSnappy },
  exit: { x: -24, opacity: 0, transition: { duration: 0.15 } },
};

export const slideOutLeft: Variants = {
  initial: { x: 0, opacity: 1 },
  animate: { x: 0, opacity: 1 },
  exit: { x: -48, opacity: 0, transition: { duration: 0.2 } },
};

// ── Scale ────────────────────────────────────────────────────

export const scaleIn: Variants = {
  initial: { scale: 0.95, opacity: 0 },
  animate: { scale: 1, opacity: 1, transition: springSnappy },
  exit: { scale: 0.95, opacity: 0, transition: { duration: 0.12 } },
};

export const scaleOut: Variants = {
  initial: { scale: 1, opacity: 1 },
  animate: { scale: 1, opacity: 1 },
  exit: { scale: 0.95, opacity: 0, transition: { duration: 0.12 } },
};

// ── List Items ───────────────────────────────────────────────

export const listItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: springGentle },
  exit: {
    opacity: 0,
    x: -48,
    height: 0,
    marginTop: 0,
    marginBottom: 0,
    paddingTop: 0,
    paddingBottom: 0,
    transition: { duration: 0.2, opacity: { duration: 0.12 } },
  },
};

// ── Checkmark ────────────────────────────────────────────────

export const checkmark: Variants = {
  initial: { pathLength: 0, opacity: 0 },
  animate: {
    pathLength: 1,
    opacity: 1,
    transition: { ...springSnappy, opacity: { duration: 0.1 } },
  },
};

// ── Subtle Pulse ─────────────────────────────────────────────

export const subtlePulse: Variants = {
  animate: {
    scale: [1, 1.04, 1],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: "easeInOut",
    },
  },
};

// ── Crossfade (for view transitions) ─────────────────────────

export const crossfade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

// ── Backdrop (for modals) ────────────────────────────────────

export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
};

// ── Completion burst particle ────────────────────────────────

export const burstParticle: Variants = {
  initial: { scale: 0, opacity: 1 },
  animate: (i: number) => ({
    scale: [0, 1, 0.5],
    opacity: [1, 1, 0],
    x: Math.cos((i * Math.PI * 2) / 8) * 20,
    y: Math.sin((i * Math.PI * 2) / 8) * 20,
    transition: { duration: 0.5, ease: "easeOut" },
  }),
};

// ── Stagger container ────────────────────────────────────────

export const staggerContainer: Variants = {
  animate: {
    transition: {
      staggerChildren: 0.03,
    },
  },
};
