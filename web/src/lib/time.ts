type Rounding = "down" | "up" | "nearest";
const rounders: Record<Rounding, (x: number) => number> = { down: Math.floor, up: Math.ceil, nearest: Math.round };

/**
 * "40s", "12m", "1h 2m", "18h", "3d": how long, the one way the app writes a duration, in a chip, a
 * row or a sentence. Under ten hours the minutes stay ("1h 2m"); past two days it counts days.
 * `round` says which way a part second, minute or hour goes.
 */
export function durationText(ms: number, round: Rounding = "down"): string {
  const r = rounders[round];
  const s = r(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.max(1, r(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 600) return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  const h = r(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${r(ms / 86_400_000)}d`;
}

/** "15m", "40s", "2h": how long until `ms` from now, rounded up so it never reads 0 while it holds. */
export function untilText(ms: number): string {
  return durationText(ms, "up");
}

/** "40s", "4m", "2h": how long something has lasted, rounded down, at least a second. */
export function lastedText(ms: number): string {
  return durationText(Math.max(ms, 1000), "down");
}

/** "40s", "12m", "1h 2m": a span that has ended (a median, a stay at a past Step), never "0s". */
export function spanText(ms: number): string {
  return durationText(Math.max(ms, 1000), "nearest");
}

/** "now", "36m", "1h 29m", "2d": how long something has waited, as a card's age says it; under a minute it is "now". */
export function ageText(ms: number): string {
  return ms < 60_000 ? "now" : durationText(ms);
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A time as a row shows it: "22:18" today, "6 Oct" this year, "6 Oct 2025" before. */
export function shortWhen(at: string, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock.format(d);
  return d.getFullYear() === n.getFullYear() ? day.format(d) : dayYear.format(d);
}

/** "40s ago", "3m ago", "5h ago", "2d ago": short enough for a narrow column; the exact time on hover. */
export function agoText(ms: number): string {
  return `${durationText(ms, "nearest")} ago`;
}
