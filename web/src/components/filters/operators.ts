// The Filter's grammar, ported from enably-v2's FilterBar: what each axis is, which operators its
// chip offers, and which operator a pick writes. The person chooses only the sign (is ⇄ is not);
// how many values are ticked chooses singular or plural (is ⇄ is one of).
import type { ReactNode } from "react";
import { dateBounds, datePresets, pillDays } from "./dates";
import type { FilterPill } from "./filterState";

/**
 * An axis as the bar sees it. `ops` are the operators the axis accepts, in the server's words;
 * `type` decides its editor: a checklist (enum, ref, boolean), a calendar (date), or the Search
 * field (text, the `q` axis).
 */
export type FilterField = {
  key: string;
  type: "enum" | "ref" | "boolean" | "text" | "date";
  ops: readonly string[];
  label: string;
  /** The lucide icon on its row in the Filters menu. */
  icon?: ReactNode;
};

/**
 * One value an axis can take. Options with the same `group` form a section of the checklist, set
 * apart by a rule and headed by `groupLabel` when it has one.
 */
export type FilterOption = {
  value: string;
  label: string;
  /** A WorkGlyph or a MemberAvatar, drawn before the label in the checklist and on the chip. */
  icon?: ReactNode;
  /** A second identifier after the label, such as a Task's key. */
  sublabel?: string;
  /** Muted words at the end of the row, such as "Me". */
  hint?: string;
  group?: string;
  groupLabel?: string;
};

/** Why an operator row cannot be chosen against the values the axis holds. */
export type OpDisabledReason = "oneValue" | "oneDay" | "dateValue";

/** The first candidate operator the field accepts. */
export function pickOp(field: FilterField, ...candidates: string[]): string | undefined {
  return candidates.find((c) => field.ops.includes(c));
}

const polarityOps = ["is", "not", "in", "nin"] as const;

/** The types whose operator the chip lets the person choose. */
const operatorTypes = new Set<FilterField["type"]>(["enum", "ref", "date"]);

/**
 * The rows of an axis' operator menu: the polarity operators it accepts, then a date's span and
 * its two open ends, one row per question ("is after" or "is on or after", whichever the axis
 * accepts first). `last` is never a row, since only a preset beside the calendar can give its
 * value; it joins as the current operator when a pill holds it.
 */
export function operatorRows(field: FilterField, currentOp?: string): string[] {
  if (!operatorTypes.has(field.type)) return [];
  const rows: string[] = polarityOps.filter((op) => field.ops.includes(op));
  if (field.type === "date") {
    for (const candidates of [["btw"], ["after", "gte"], ["before", "lte"]]) {
      const op = pickOp(field, ...candidates);
      if (op) rows.push(op);
    }
  }
  if (currentOp && !rows.includes(currentOp)) rows.push(currentOp);
  return rows;
}

/** How many values an operator carries; `last`'s one value is a window (`7d`), not a date. */
export function opArity(op: string): "one" | "many" | "two" | "window" {
  if (op === "in" || op === "nin") return "many";
  if (op === "btw") return "two";
  if (op === "last") return "window";
  return "one";
}

/**
 * Why `op` cannot be chosen against the pill's values, or undefined when it can. A date pill is
 * read by the days it covers: one day takes every operator, a span only "is between", and a
 * window (Last 7 days) only its own.
 */
export function opDisabledReason(op: string, pill: FilterPill | undefined, field?: FilterField): OpDisabledReason | undefined {
  if (!pill || pill.values.length === 0) return undefined;
  const arity = opArity(op);
  if (opArity(pill.op) === "window") return arity === "window" ? undefined : "dateValue";
  if (field?.type === "date") return arity === "one" && pillDays(pill.values).length > 1 ? "oneDay" : undefined;
  if (arity === "one" && pill.values.length > 1) return "oneValue";
  return undefined;
}

/**
 * The values a pill carries over to another operator: the same ones, or on a date axis the same
 * days, bounded as the new operator compares them (after reads a day's end, before its start).
 */
export function revalue(field: FilterField, op: string, values: string[]): string[] {
  return field.type === "date" ? dateBounds(op, pillDays(values)) : values;
}

/** Whether the operator says "not": is not, is none of. */
export function negative(op: string): boolean {
  return op === "not" || op === "nin";
}

/**
 * The operator a pick of `count` values writes, given the one in force: several values take the
 * plural (is → is one of, is not → is none of), one value the singular, and the sign stays.
 */
export function commitOp(field: FilterField, chosen: string, count: number): string {
  if (count > 1 && (chosen === "is" || chosen === "not")) return pickOp(field, chosen === "is" ? "in" : "nin") ?? chosen;
  if (count === 1 && (chosen === "in" || chosen === "nin")) return pickOp(field, chosen === "in" ? "is" : "not") ?? chosen;
  return chosen;
}

/**
 * Whether ticking a value under `op` adds to the pick: the axis accepts the plural of the sign in
 * force (`in` for is, `nin` for is not). Otherwise a tick replaces the value.
 */
export function multiPick(field: FilterField, op: string): boolean {
  return negative(op) ? field.ops.includes("nin") : field.ops.includes("in");
}

/**
 * The pills a page can show and apply: those on an axis it has, with an operator the axis takes
 * and a value. Anything else in the address (hand-edited, or from a newer build) is left alone.
 */
export function usablePills(pills: readonly FilterPill[], fields: readonly FilterField[]): FilterPill[] {
  return pills.filter((p) => {
    const field = fields.find((f) => f.key === p.field);
    if (!field || !field.ops.includes(p.op) || p.values.length === 0 || p.values.some((v) => v === "")) return false;
    if (field.type !== "date") return true;
    if (p.op === "last") return p.values.length === 1 && (datePresets as readonly string[]).includes(p.values[0]);
    return p.values.length === (p.op === "btw" ? 2 : 1) && p.values.every((v) => !Number.isNaN(Date.parse(v)));
  });
}

/** The operator an unset axis starts on. */
export function defaultOp(field: FilterField): string {
  if (field.type === "text") return pickOp(field, "contains") ?? field.ops[0] ?? "contains";
  if (field.type === "date") return pickOp(field, "btw") ?? field.ops[0] ?? "btw";
  return pickOp(field, "is", "in") ?? field.ops[0] ?? "is";
}

/**
 * Which calendar a date axis draws for the operator in force: a span for `btw` (one click is one
 * day, a second completes the span), and for a window or nothing set; one day for the open ends.
 */
export function dateMode(op: string | undefined): "single" | "range" {
  if (op === "after" || op === "before" || op === "gte" || op === "lte") return "single";
  return "range";
}
