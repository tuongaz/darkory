// The Filter's state lives in the address, ported from enably-v2's use-filter-state: one parameter
// per set axis, `?filter.<entity>=<field>:<op>:<v1>,<v2>`, each value percent-encoded, so a filtered
// list can be linked and a reload keeps it. `GET /v1/tasks?filter=` reads the same tokens.
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

/** Ops that take no value: two segments, no dangling colon. */
const nullaryOps = new Set(["empty", "nempty"]);

/** One set axis: its field, its operator, and the values it compares with (ids, not names). */
export type FilterPill = { field: string; op: string; values: string[] };

/** `{field, op, values}` → `field:op:v1,v2`, each value percent-encoded. */
export function serializeFilter(pill: FilterPill): string {
  if (nullaryOps.has(pill.op)) return `${pill.field}:${pill.op}`;
  return `${pill.field}:${pill.op}:${pill.values.map(encodeURIComponent).join(",")}`;
}

/**
 * The address's search for a list of Tasks at one Step, `filter.tasks=step:is:<id>`, narrowed
 * further by `pills` (the scope and Filter the Step's Tasks were counted under): one pill per
 * field, as the list reads them, the Step's first and then the first of each field in `pills`.
 */
export function stepFilterSearch(stepId: string, pills: readonly FilterPill[] = []): string {
  const seen = new Set<string>();
  return [{ field: "step", op: "is", values: [stepId] }, ...pills]
    .filter((p) => !seen.has(p.field) && !!seen.add(p.field))
    .map((p) => `filter.tasks=${encodeURIComponent(serializeFilter(p))}`)
    .join("&");
}

/** Stands for a value `decodeURIComponent` refused; no address decodes to it. */
const decodeFailed = Symbol("decode-failed") as unknown as string;

/** `decodeURIComponent` throws on a malformed escape (`%`, `%zz`), which would blank the page mid-render. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return decodeFailed;
  }
}

/**
 * The inverse of serializeFilter, or null for a malformed token: a hand-edited address must not
 * break the page. One bad value refuses the whole token rather than keeping it half-decoded.
 */
export function parseFilter(token: string): FilterPill | null {
  if (!token) return null;
  const firstColon = token.indexOf(":");
  if (firstColon < 1) return null;
  const field = token.slice(0, firstColon);
  const rest = token.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (secondColon === -1) return nullaryOps.has(rest) ? { field, op: rest, values: [] } : null;
  const op = rest.slice(0, secondColon);
  const raw = rest.slice(secondColon + 1);
  if (!op || nullaryOps.has(op) || raw === "") return null;
  // decodeURIComponent, not a `+`-aware decode: `+` is a literal in a value.
  const values = raw.split(",").map(safeDecode);
  return values.includes(decodeFailed) ? null : { field, op, values };
}

export type FilterState = {
  pills: FilterPill[];
  /** Adds the pill, or replaces the one on its field: one pill per field. */
  setFilter: (pill: FilterPill) => void;
  removeFilter: (field: string) => void;
  clearAll: () => void;
  /** Every pill in one write. */
  replaceAll: (pills: FilterPill[]) => void;
};

/**
 * The pills of `?filter.<entity>=`. Every write copies the current parameters and changes only its
 * own, so the view, the peek and anything else in the address survive; writes replace the history
 * entry, as the Display's choices do.
 */
export function useFilterState(entity: string): FilterState {
  const [params, setParams] = useSearchParams();
  const key = `filter.${entity}`;

  const pills = useMemo(
    () =>
      params
        .getAll(key)
        .map(parseFilter)
        .filter((p): p is FilterPill => p !== null),
    [params, key],
  );

  // Each write starts from the parameters the router holds, never from a fresh set.
  const write = useCallback(
    (change: (pills: FilterPill[]) => FilterPill[]) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          const before = current
            .getAll(key)
            .map(parseFilter)
            .filter((p): p is FilterPill => p !== null);
          out.delete(key);
          for (const pill of change(before)) out.append(key, serializeFilter(pill));
          return out;
        },
        { replace: true },
      ),
    [setParams, key],
  );

  const setFilter = useCallback((pill: FilterPill) => write((ps) => [...ps.filter((p) => p.field !== pill.field), pill]), [write]);
  const removeFilter = useCallback((field: string) => write((ps) => ps.filter((p) => p.field !== field)), [write]);
  const clearAll = useCallback(() => write(() => []), [write]);
  const replaceAll = useCallback((next: FilterPill[]) => write(() => next), [write]);

  return { pills, setFilter, removeFilter, clearAll, replaceAll };
}
