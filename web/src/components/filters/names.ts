// What the Filter's button is called: its name carries the count of Filters set, which its badge
// shows to the eye only.
import type { FilterBarProps } from "./FilterBar";
import { filterLabels } from "./labels";

/** The Filters set. A pill for an axis this page does not know (a hand-edited address) is ignored, not counted. */
export function setCount({ fields, pills }: Pick<FilterBarProps, "fields" | "pills">) {
  const known = new Set(fields.map((f) => f.key));
  return pills.filter((p) => known.has(p.field)).length;
}

/** Filter's accessible name: "Filter", or "Filter, 2 set". */
export function filterName(props: FilterBarProps) {
  const labels = props.labels ?? filterLabels;
  const n = setCount(props);
  return n > 0 ? `${labels.filter}, ${n} set` : labels.filter;
}
