import { FiltersLabels } from "../FiltersLabels.js";
import { useAppState } from "../../context/AppStateContext.js";

export function FiltersLabelsTab() {
  const { tasks } = useAppState();

  return <FiltersLabels tasks={tasks} onNavigateToFilter={() => {}} />;
}
