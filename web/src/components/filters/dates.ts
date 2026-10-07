// A date axis on the wire: RFC 3339 instants with the browser's offset, at millisecond precision
// (the record keeps Unix ms). A picked local day D becomes its bounds, start(D) at 00:00:00.000 and
// end(D) at 23:59:59.999, and each operator compares instants plainly:
//
//   after:end(D)            at >  end of D         "after 4 Oct"
//   before:start(D)         at <  start of D       "before 4 Oct"
//   gte:start(D)            at >= start of D       "on or after 4 Oct"
//   lte:end(D)              at <= end of D         "on or before 4 Oct"
//   btw:start(A),end(B)     inclusive              "4 Oct – 6 Oct", or "4 Oct" for one day
//   last:7d|30d|90d         at >= now − N days     "Last 7 days"
//
// The chip reads each instant's day in the viewer's time zone.
import type { FilterPill } from "./filterState";

/** The relative windows a date axis offers beside its calendar. */
export const datePresets = ["7d", "30d", "90d"] as const;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A local time as RFC 3339 with its offset: 2026-10-04T00:00:00.000+11:00. */
function rfc3339(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** The first instant of the local day `day` falls on. */
export function startOf(day: Date): string {
  return rfc3339(new Date(day.getFullYear(), day.getMonth(), day.getDate()));
}

/** The last millisecond of the local day `day` falls on. */
export function endOf(day: Date): string {
  return rfc3339(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999));
}

/** The local day an instant falls on, or undefined for a value that is not a time. */
export function dayOf(value: string): Date | undefined {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The days a date pill's values fall on, without repeats, in order. */
export function pillDays(values: readonly string[]): Date[] {
  const days = values.flatMap((v) => dayOf(v) ?? []).sort((a, b) => a.getTime() - b.getTime());
  return days.filter((d, i) => i === 0 || d.getTime() !== days[i - 1].getTime());
}

/** The values `op` writes for the days picked: the bound of each day the operator compares with. */
export function dateBounds(op: string, days: readonly Date[]): string[] {
  if (days.length === 0) return [];
  const first = days[0];
  const last = days[days.length - 1];
  switch (op) {
    case "after":
    case "lte":
      return [endOf(first)];
    case "before":
    case "gte":
      return [startOf(first)];
    default:
      return [startOf(first), endOf(last)];
  }
}

const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** "4 Oct" this year, "4 Oct 2025" another. */
export function dayText(day: Date, now: number): string {
  return day.getFullYear() === new Date(now).getFullYear() ? dayFormat.format(day) : dayYearFormat.format(day);
}

/** "Last 7 days" for `7d`. */
export function presetText(token: string): string {
  return `Last ${token.replace(/d$/, "")} days`;
}

const prepositions: Record<string, string> = { after: "after", before: "before", gte: "on or after", lte: "on or before" };

/** What a date chip reads: "after 4 Oct", "4 Oct – 6 Oct", "4 Oct", "Last 7 days". */
export function dateText(op: string, values: readonly string[], now: number): string {
  if (op === "last") return presetText(values[0] ?? "");
  const days = values.map((v) => dayOf(v));
  if (days.some((d) => !d)) return values.join(", ");
  const [first, last] = days as Date[];
  if (op === "btw") return !last || first.getTime() === last.getTime() ? dayText(first, now) : `${dayText(first, now)} – ${dayText(last, now)}`;
  const word = prepositions[op];
  return word ? `${word} ${dayText(first, now)}` : dayText(first, now);
}

const dayMs = 24 * 60 * 60 * 1000;

/** Whether an instant passes a date pill; a Task without the date (not completed) passes none. */
export function passesDate(at: string | undefined, pill: FilterPill, now: number): boolean {
  if (!at) return false;
  const t = Date.parse(at);
  if (pill.op === "last") {
    const n = Number(pill.values[0]?.replace(/d$/, ""));
    return Number.isFinite(n) && t >= now - n * dayMs;
  }
  const [a, b] = pill.values.map((v) => Date.parse(v));
  switch (pill.op) {
    case "after":
      return t > a;
    case "before":
      return t < a;
    case "gte":
      return t >= a;
    case "lte":
      return t <= a;
    case "btw":
      return t >= a && t <= b;
    default:
      return true;
  }
}
