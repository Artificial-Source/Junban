export interface FocusBlock {
  type: "quick_win" | "deep_work";
  tasks: { id?: string; title?: string; priority?: number }[];
}
