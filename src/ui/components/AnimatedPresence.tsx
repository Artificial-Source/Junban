/**
 * AnimatedPresence — wraps Framer Motion's AnimatePresence with reduced-motion awareness.
 * When reduced motion is preferred (via OS or app settings), children render without animation.
 */
import { AnimatePresence, type AnimatePresenceProps } from "framer-motion";
import { useReducedMotion } from "./useReducedMotion.js";

interface AnimatedPresenceProps extends AnimatePresenceProps {
  children: React.ReactNode;
}

/**
 * Drop-in replacement for `AnimatePresence` that respects reduced motion preferences.
 * When reduced motion is active, this component still renders children but does not
 * animate enter/exit transitions (Framer Motion's own `useReducedMotion` is also
 * respected inside `motion.*` components).
 */
export function AnimatedPresence({ children, ...rest }: AnimatedPresenceProps) {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return <>{children}</>;
  }

  return <AnimatePresence {...rest}>{children}</AnimatePresence>;
}

// Re-export the hook for convenience
export { useReducedMotion } from "./useReducedMotion.js";
