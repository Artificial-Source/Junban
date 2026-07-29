import { Plus } from "lucide-react";

interface FABProps {
  onClick: () => void;
}

export function FAB({ onClick }: FABProps) {
  return (
    <button
      onClick={onClick}
      aria-label="Add task"
      className="fixed z-40 md:hidden right-4 bottom-[calc(var(--height-bottom-nav)+1rem)] w-14 h-14 rounded-full bg-accent-action text-on-accent-action shadow-lg flex items-center justify-center hover:bg-accent-action-hover transition-colors"
    >
      <Plus size={24} />
    </button>
  );
}
