// Where the Filter bar plugs into a Project's Tasks. The bar's model v2 axes and its browser-side
// reading of the pills (`taskAxes` and `matches` in components/filters) are being ported beside
// this screen; until they land the list and the board show every Task, and this is the one place
// to swap: replace `taskMatches` with the bar's `matches`, mount FilterMenuButton and
// FilterChipRow in TasksPage with `useFilterState("tasks")`, and answer the `filter` intent.
import type { Task } from "@/api/client";

/** Whether a Task passes the Filter's pills. Every Task does while there is no Filter bar. */
export function taskMatches(task: Task): boolean {
  void task;
  return true;
}
