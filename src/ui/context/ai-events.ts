export const AI_DATA_MUTATED_EVENT = "junban:ai-data-mutated";

export function dispatchAIDataMutatedEvent(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AI_DATA_MUTATED_EVENT));
}
