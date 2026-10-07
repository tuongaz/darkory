// A View ↔ the Filter's pills, ported from enably's useSavedFilters: a View keeps the list's
// `filter` tokens as the server checked them; applying one turns them back into pills.
import { parseFilter, serializeFilter, type FilterPill } from "./filterState";
import { usablePills, type FilterField } from "./operators";

/** The tokens a View saves for the pills: the address's own, one per axis. */
export function viewTokens(pills: readonly FilterPill[]): string[] {
  return pills.map(serializeFilter);
}

/**
 * The pills a View's tokens give this list: those it can show and apply. A token for an axis the
 * page no longer has, or with an operator it no longer takes, is dropped rather than drawn as a
 * chip that filters nothing.
 */
export function viewPills(tokens: readonly string[], fields: readonly FilterField[]): FilterPill[] {
  return usablePills(
    tokens.map(parseFilter).filter((p): p is FilterPill => p !== null),
    fields,
  );
}

/**
 * Whether two sets of tokens filter alike: the same axes, operators and values, whatever their
 * order (a pill set again moves to the end of the address; ticked values keep their order).
 */
export function sameFilters(a: readonly string[], b: readonly string[]): boolean {
  const canonical = (tokens: readonly string[]) =>
    tokens
      .map(parseFilter)
      .map((p) => (p ? `${p.field}:${p.op}:${[...p.values].sort().join(",")}` : ""))
      .sort()
      .join(" ");
  return canonical(a) === canonical(b);
}
