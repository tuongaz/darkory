// The Filter's words. enably injected every string for its translations; Darkory has one language,
// so they live here, kept apart so a screen can still word its own.
import type { OpDisabledReason } from "./operators";

const opWords: Record<string, string> = {
  is: "is",
  not: "is not",
  in: "is one of",
  nin: "is none of",
  after: "is after",
  before: "is before",
  gte: "is on or after",
  lte: "is on or before",
  btw: "is between",
  last: "is within",
  contains: "contains",
};

const disabledWords: Record<OpDisabledReason, string> = {
  oneValue: "one value only",
  twoDates: "a range only",
  dateValue: "not with Last N days",
};

export const filterLabels = {
  all: "All",
  reset: "Reset",
  filters: "Filters",
  /** The header button's name. */
  filter: "Filter",
  op: (op: string) => opWords[op] ?? op,
  opDisabled: (reason: OpDisabledReason) => disabledWords[reason],
  searchValues: "Search…",
  searchFields: "Filter by…",
  searchAxis: "Search",
  searchPlaceholder: "Search keys and titles",
  noneFound: "No matches",
  more: (n: number) => `+${n}`,
  datePreset: (token: string) => `Last ${token.replace(/d$/, "")} days`,
};

export type FilterLabels = typeof filterLabels;
