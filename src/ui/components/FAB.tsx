import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { useReducedMotion } from "./useReducedMotion.js";
import { scaleIn } from "../utils/animation-variants.js";

interface FABProps {
  onClick: () => void;
}

export function FAB({ onClick }: FABProps) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button
      onClick={onClick}
      aria-label="Add task"
      className="fixed z-40 md:hidden right-4 bottom-[calc(var(--height-bottom-nav)+1rem)] w-14 h-14 rounded-full bg-accent text-white shadow-lg flex items-center justify-center hover:bg-accent-hover transition-all"
      variants={reducedMotion ? undefined : scaleIn}
      initial={reducedMotion ? undefined : "initial"}
      animate="animate"
      whileHover={reducedMotion ? undefined : { scale: 1.08 }}
      whileTap={reducedMotion ? undefined : { scale: 0.92 }}
    >
      <Plus size={24} />
    </motion.button>
  );
}
