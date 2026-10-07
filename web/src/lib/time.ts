/** "15 min", "40 s", "2 h": how long until `ms` from now, rounded up so it never reads 0 while it holds. */
export function untilText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
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
