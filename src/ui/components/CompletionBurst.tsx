/**
 * CompletionBurst — CSS keyframe particle burst effect on task completion.
 * Renders 8 small dots that burst outward from the center.
 */
import { useReducedMotion } from "./useReducedMotion.js";

const PARTICLE_COUNT = 8;

const COLORS = [
  "var(--color-success, #22c55e)",
  "var(--color-accent, #6366f1)",
  "var(--color-warning, #f59e0b)",
  "var(--color-success, #22c55e)",
  "var(--color-accent, #6366f1)",
  "var(--color-success, #22c55e)",
  "var(--color-warning, #f59e0b)",
  "var(--color-accent, #6366f1)",
];

export function CompletionBurst({ active }: { active: boolean }) {
  const reducedMotion = useReducedMotion();

  if (!active || reducedMotion) return null;

  return (
    <span className="absolute inset-0 pointer-events-none" aria-hidden="true">
      {Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const angle = (i * 360) / PARTICLE_COUNT;
        return (
          <span
            key={i}
            className="completion-burst-particle"
            style={
              {
                "--burst-angle": `${angle}deg`,
                "--burst-color": COLORS[i],
              } as React.CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
